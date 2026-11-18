import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createTranscriberServer } from "../server.mjs";
import { providerConfig } from "../src/provider-config.mjs";

const origin = "chrome-extension://" + "a".repeat(32);
const headers = { Origin: origin, "Content-Type": "application/json" };
const audio = { format: "ogg", data: "YQ==" };

async function service(t, env = {}, fetchImpl = () => assert.fail("Unexpected upstream request")) {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-test-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model = path.join(dir, "demo.bin");
  await writeFile(model, "lmgg");
  const config = providerConfig({
    WHISPER_CLI_PATH: process.execPath, WHISPER_MODEL_PATH: model, FFMPEG_PATH: process.execPath,
    ALLOWED_EXTENSION_ORIGINS: origin, ...env,
  });
  const server = createTranscriberServer(config, { fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const post = (route, body, h = headers) => fetch(endpoint + route, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { endpoint, post };
}

test("health sinaliza configuração inválida sem divulgar chaves ou caminhos", async t => {
  for (const [env, variable] of [
    [{ TRANSCRIPTION_PROVIDER: "typo" }, "TRANSCRIPTION_PROVIDER"],
    [{ FFMPEG_PATH: "private-path" }, "FFMPEG_PATH"],
    [{ WHISPER_MODEL_PATH: "" }, "WHISPER_MODEL_PATH"],
    [{ WHISPER_MODEL_PATH: process.execPath }, "WHISPER_MODEL_PATH"],
    [{ WHISPER_CLI_PATH: "" }, "WHISPER_CLI_PATH"],
    [{ ALLOWED_EXTENSION_ORIGINS: "*" }, "ALLOWED_EXTENSION_ORIGINS"],
    [{ TRANSCRIPTION_PROVIDER: "openrouter" }, "OPENROUTER_API_KEY"],
  ]) {
    const { endpoint } = await service(t, env);
    const response = await fetch(endpoint + "/health");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.includes(variable));
    assert.doesNotMatch(JSON.stringify(body), /private-path|\/Users\//);
  }
});

test("rotas checam origem, host, método, preflight, formato e limites", async t => {
  const { endpoint, post } = await service(t);
  const health = await fetch(endpoint + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, provider: "local", service: "dia-whatsapp-transcriber",
    summaryAvailable: false, model: "demo.bin" });
  for (const untrusted of ["null", "https://web.whatsapp.com", origin.replace(/a$/, "b"), undefined]) {
    const h = { "Content-Type": "application/json", ...(untrusted && { Origin: untrusted }) };
    const r = await post("/transcribe", audio, h);
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  const rebind = http.get(endpoint + "/health", { headers: { Host: "other.example" } });
  const [denied] = await once(rebind, "response");
  assert.equal(denied.statusCode, 403);
  denied.resume();
  assert.equal((await fetch(endpoint + "/oops", { headers })).status, 404);
  assert.equal((await fetch(endpoint + "/transcribe", { headers })).status, 405);
  const preflight = h => fetch(endpoint + "/transcribe", { method: "OPTIONS", headers: {
    Origin: origin, "Access-Control-Request-Method": "POST", ...h,
  } });
  const allowed = await preflight({ "Access-Control-Request-Headers": "content-type" });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
  assert.equal((await preflight({ "Access-Control-Request-Method": "PUT" })).status, 403);
  assert.equal((await preflight({ "Access-Control-Request-Headers": "x-custom" })).status, 403);
  assert.equal((await post("/transcribe", audio, { ...headers, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/transcribe", audio, { ...headers, "Content-Encoding": "gzip" })).status, 415);
  assert.equal((await fetch(endpoint + "/transcribe", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await post("/transcribe", { ...audio, data: "!!!!" })).status, 400);
  const blocked = await post("/summarize", { provider: "openrouter", text: "teste" });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /modo local/);
});

test("limita os corpos declarados e chunked antes de consultar OpenRouter", async t => {
  const { endpoint } = await service(t, { TRANSCRIPTION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test" });
  for (const [route, declared] of [["/transcribe", 34 * 1024 * 1024], ["/summarize", null]]) {
    const req = http.request(endpoint + route, { method: "POST", headers: {
      ...headers, ...(declared && { "Content-Length": declared }),
    } });
    const result = once(req, "response");
    req.flushHeaders();
    if (!declared) {
      req.write(Buffer.alloc(1_200_000, 32));
      req.end(Buffer.alloc(4097, 32));
    }
    const [res] = await result;
    assert.equal(res.statusCode, 413);
    res.resume();
    req.destroy();
  }
});

test("OpenRouter preserva a transcrição e o resumo com o provedor fixado pelo serviço", async t => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return Response.json(url.endsWith("completions")
      ? { choices: [{ message: { content: " resumo " } }] }
      : { text: " transcrição ", usage: { seconds: 2 } });
  };
  const { post, endpoint } = await service(t, { TRANSCRIPTION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test", SUMMARY_MODEL: "summary" }, fetchImpl);
  assert.equal((await (await fetch(endpoint + "/health")).json()).summaryAvailable, true);
  assert.deepEqual(await (await post("/transcribe", { ...audio, provider: "local", model: "model" })).json(),
    { text: "transcrição", usage: { seconds: 2 } });
  assert.deepEqual(await (await post("/summarize", { text: "teste" })).json(), { text: "resumo", usage: null });
  assert.equal(calls[0][0], "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.deepEqual(calls[0][1], { model: "model", input_audio: audio, language: "pt", temperature: 0 });
  assert.equal(calls[1][1].model, "summary");
});
