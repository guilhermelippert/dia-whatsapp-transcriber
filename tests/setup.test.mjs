import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setup, terminal } from "../scripts/setup.mjs";
import { providerConfig, providerHealth } from "../src/provider-config.mjs";
import { parseEnvFile } from "../src/server-utils.mjs";

const id = "abcdefghijklmnop".repeat(2);

async function isolated(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "setup com espaços-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function prompts(...answers) {
  const transcript = [];
  const secretPrompts = [];
  return {
    transcript, secretPrompts,
    async ask(label, secret) {
      transcript.push(label);
      if (secret) secretPrompts.push(label);
      assert.ok(answers.length, "Pergunta inesperada: " + label);
      return answers.shift();
    },
    tell(message) { transcript.push(message); },
  };
}

test("setup local corrige origens, executáveis e modelo e grava caminhos utilizáveis pelo serviço", async t => {
  const dir = await isolated(t);
  const model = "modelo com espaços.bin";
  await writeFile(path.join(dir, model), "lmgg");
  const other = "chrome-extension://" + "b".repeat(32);
  const ui = prompts("*", "https://web.whatsapp.com", id + ",", id + "," + other + "," + id,
    "typo", "", dir, process.execPath, "missing", process.execPath, "", process.execPath, '"' + model + '"');
  await setup(dir, ui);
  const dest = path.join(dir, ".env.local");
  const env = parseEnvFile(await readFile(dest, "utf8"));
  assert.equal(env.ALLOWED_EXTENSION_ORIGINS, "chrome-extension://" + id + "," + other);
  assert.equal(env.WHISPER_MODEL_PATH, path.join(dir, model));
  assert.equal(env.WHISPER_CLI_PATH, process.execPath);
  assert.equal(env.FFMPEG_PATH, process.execPath);
  assert.equal(env.TRANSCRIPTION_PROVIDER, "local");
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(providerHealth(providerConfig(env)).ok, true);
  assert.equal(ui.secretPrompts.length, 0);
  if (process.platform !== "win32") assert.equal((await lstat(dest)).mode & 0o077, 0);
});

test("OpenRouter pede chave oculta, recusa entrada inválida e não divulga o valor", async t => {
  const dir = await isolated(t);
  const fake = "fixture-key=#123";
  const ui = prompts(id, "openrouter", "", "linha\nPORT=1", fake);
  await setup(dir, ui);
  const env = parseEnvFile(await readFile(path.join(dir, ".env.local"), "utf8"));
  assert.ok(env.OPENROUTER_API_KEY === fake);
  assert.equal(env.TRANSCRIPTION_PROVIDER, "openrouter");
  assert.equal(env.PORT, undefined);
  assert.equal(ui.secretPrompts.length, 3);
  assert.ok(!ui.transcript.join("").includes(fake));
});

test("dois assistentes simultâneos preservam o primeiro arquivo completo e removem temporários", async t => {
  const dir = await isolated(t);
  const dest = path.join(dir, ".env.local");
  const runs = await Promise.allSettled([setup(dir, prompts(id, "openrouter", "first")),
    setup(dir, prompts(id, "openrouter", "second"))]);
  assert.equal(runs.filter(run => run.status === "fulfilled").length, 1);
  assert.equal(runs.find(run => run.status === "rejected").reason.code, "EEXIST");
  const first = await readFile(dest, "utf8");
  await setup(dir, prompts());
  assert.ok((await readFile(dest, "utf8")) === first);
  assert.deepEqual(await readdir(dir), [".env.local"]);
});

test("cancelamento antes da gravação e link preexistente não modificam arquivos", async t => {
  const dir = await isolated(t);
  await assert.rejects(setup(dir, { ...prompts(), ask() { throw new Error("cancelado"); } }), /cancelado/);
  assert.deepEqual(await readdir(dir), []);
  if (process.platform !== "win32") {
    const target = path.join(dir, "alvo-ausente");
    await symlink(target, path.join(dir, ".env.local"));
    await assert.rejects(setup(dir, prompts()), /arquivo regular/);
    assert.deepEqual(await readdir(dir), [".env.local"]);
  }
});

test("terminal exige TTY, oculta a digitação da chave e cancela com Ctrl+C", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk; });
  assert.throws(() => terminal(input, output), /interativo/);
  input.isTTY = output.isTTY = true;
  input.setRawMode = () => {};
  const ui = terminal(input, output);
  try {
    const fake = "secret-for-test";
    const answer = ui.ask("Chave oculta", true);
    for (const letter of fake) input.write(letter);
    input.write("\r");
    assert.ok((await answer) === fake);
    assert.equal(text, "Chave oculta \n");
    const cancelled = ui.ask("Outra chave", true);
    input.write("\x03");
    await assert.rejects(cancelled, { name: "AbortError" });
  } finally {
    ui.close();
  }
});
