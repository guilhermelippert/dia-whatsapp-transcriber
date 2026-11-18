import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { transcribeLocal } from "../src/local-whisper.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseEnvFile } from "../src/server-utils.mjs";
import { providerConfig } from "../src/provider-config.mjs";
import { createTranscriberServer } from "../server.mjs";

test("Mac: fala sintética PT-BR em OGG/Opus passa por HTTP, ffmpeg e whisper.cpp", {
  skip: process.env.TEST_LOCAL_WHISPER !== "1", timeout: 180_000,
}, async t => {
  const env = parseEnvFile(await readFile(new URL("../.env.local", import.meta.url), "utf8"));
  const config = providerConfig(env);
  assert.equal(config.provider, "local");
  const origin = [...config.origins][0];
  let upstreamCalls = 0;
  const server = createTranscriberServer(config, { fetchImpl: () => {
    upstreamCalls++;
    throw new Error("Unexpected upstream request");
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-test-speech-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = promisify(execFile);
  await run("say", ["-v", "Luciana (Portuguese (Brazil))", "-r", "155", "-o", "speech.aiff",
    "Bom dia. A reunião de amanhã começa às nove horas. Por favor, confirme sua presença."], { cwd: dir });
  await run(config.ffmpeg, ["-nostdin", "-v", "error", "-i", "speech.aiff", "-c:a", "libopus", "speech.ogg"], { cwd: dir });
  const post = body => fetch("http://127.0.0.1:" + server.address().port + "/transcribe", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await post({ format: "ogg", language: "pt", provider: "openrouter",
    data: (await readFile(path.join(dir, "speech.ogg"))).toString("base64") });
  assert.equal(response.status, 200);
  const { text, usage } = await response.json();
  assert.match(text, /reunião.*amanhã.*(?:nove|9) horas.*confirme.*presença/is);
  assert.equal(usage, null);
  t.diagnostic(text);
  const invalid = await post({ format: "ogg", data: "YQ==" });
  assert.equal(invalid.status, 422);
  assert.equal(upstreamCalls, 0);
});

test("cancelamento local recolhe o processo e apaga o áudio antes de liberar a operação", {
  timeout: 6000, skip: process.platform === "win32" && "Executável de teste usa shebang POSIX",
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-test-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const decoder = path.join(dir, "decoder");
  const ready = path.join(dir, "ready");
  const marker = "WPP_TEST_ONLY_" + process.pid;
  process.env[marker] = "synthetic";
  t.after(() => { delete process.env[marker]; });
  await writeFile(decoder, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(ready + ".tmp")}, JSON.stringify({
  dir: process.cwd(), pid: process.pid, inherited: Object.hasOwn(process.env, ${JSON.stringify(marker)}),
}));
fs.renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const cancel = new AbortController();
  const input = { format: "ogg", data: "YQ==", language: "pt" };
  const result = transcribeLocal({ ffmpeg: decoder }, input, cancel.signal);
  const ended = assert.rejects(result, { name: "AbortError" });
  try {
    const deadline = AbortSignal.timeout(3000);
    let child;
    while (!child) {
      try {
        child = JSON.parse(await readFile(ready, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(10, undefined, { signal: deadline });
      }
    }
    assert.equal(child.inherited, false);
    cancel.abort();
    await ended;
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(child.dir), { code: "ENOENT" });
  } finally {
    cancel.abort();
    await ended;
  }
});
