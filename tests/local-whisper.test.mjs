import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
