import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createTranscriberServer } from "../server.mjs";
import { providerConfig, serverPort } from "../src/provider-config.mjs";

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
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const invalidMagic = path.join(dir, "demo.bin");
  await writeFile(invalidMagic, Buffer.from([0xec, 0xed, 0xe7, 0xe7]));
  for (const [env, variable] of [
    [{ TRANSCRIPTION_PROVIDER: "typo" }, "TRANSCRIPTION_PROVIDER"],
    [{ FFMPEG_PATH: "private-path" }, "FFMPEG_PATH"],
    [{ WHISPER_MODEL_PATH: "" }, "WHISPER_MODEL_PATH"],
    [{ WHISPER_MODEL_PATH: process.execPath }, "WHISPER_MODEL_PATH"],
    [{ WHISPER_MODEL_PATH: invalidMagic }, "WHISPER_MODEL_PATH"],
    [{ WHISPER_CLI_PATH: "" }, "WHISPER_CLI_PATH"],
    [{ ALLOWED_EXTENSION_ORIGINS: "*" }, "ALLOWED_EXTENSION_ORIGINS"],
    [{ TRANSCRIPTION_PROVIDER: "openrouter" }, "OPENROUTER_API_KEY"],
    [{ TRANSCRIPTION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "a\nb" }, "OPENROUTER_API_KEY"],
  ]) {
    const { endpoint } = await service(t, env);
    const response = await fetch(endpoint + "/health");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.apiVersion, 2);
    assert.ok(body.error.includes(variable));
    assert.doesNotMatch(JSON.stringify(body), /private-path|\/Users\//);
  }
});

test("rotas checam origem, host, método, preflight, formato e limites", async t => {
  const { endpoint, post } = await service(t);
  const health = await fetch(endpoint + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, provider: "local", apiVersion: 2, service: "dia-whatsapp-transcriber",
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
  assert.deepEqual(await (await post("/transcribe", { ...audio, provider: "local", model: "model", allowCloud: true })).json(),
    { text: "transcrição", usage: { seconds: 2 } });
  assert.deepEqual(await (await post("/summarize", { text: "teste", allowCloud: true })).json(), { text: "resumo", usage: null });
  assert.equal(calls[0][0], "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.deepEqual(calls[0][1], { model: "model", input_audio: audio, language: "pt", temperature: 0 });
  assert.equal(calls[1][1].model, "summary");
});

const cloud = { TRANSCRIPTION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test" };

test("cada rota de nuvem exige consentimento booleano antes de chamar o provedor", async t => {
  let calls = 0;
  const { post } = await service(t, cloud, () => { calls++; return Response.json({}); });
  for (const [route, input] of [["/transcribe", audio], ["/summarize", { text: "teste" }]]) {
    for (const allowCloud of [undefined, false, null, "true", 1, {}]) {
      const response = await post(route, { ...input, provider: "local", allowCloud });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(calls, 0);
});

test("limita a resposta declarada e decodificada do provedor e descarta erros privados", async t => {
  const limit = 2 * 1024 * 1024;
  let canceled = 0;
  const largeStream = () => new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { canceled++; },
  });
  const replies = [
    () => new Response(largeStream(), { headers: { "content-length": String(limit + 1) } }),
    () => new Response(largeStream()),
    () => new Response("private-marker", { status: 401 }),
    () => new Response("private-marker"),
    () => Response.json({ text: { private: "private-marker" } }),
    () => Response.json({ text: "ok" }),
  ];
  const { post } = await service(t, cloud, () => replies.shift()());
  for (const status of [502, 502, 401, 502, 502, 200]) {
    const response = await post("/transcribe", { ...audio, allowCloud: true });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private-marker/);
  }
  assert.equal(canceled, 2);
});

test("três operações de nuvem compartilham vagas e a desconexão libera capacidade", { timeout: 6000 }, async t => {
  const entered = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const replacement = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const { endpoint, post } = await service(t, cloud, async (url, { signal }) => {
    calls++;
    if (calls === 3) entered.resolve();
    if (calls === 4) replacement.resolve();
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { stopped.resolve(); reject(signal.reason); }, { once: true });
      release.promise.then(resolve);
    });
    return Response.json({ text: "ok" });
  });
  const disconnect = new AbortController();
  const body = { ...audio, allowCloud: true };
  const first = fetch(endpoint + "/transcribe", {
    method: "POST", headers: workerHeaders, body: JSON.stringify(body), signal: disconnect.signal,
  }).then(response => response.json()).catch(error => error.name);
  const others = Promise.all([post("/transcribe", body), post("/transcribe", body)]);
  try {
    await entered.promise;
    assert.equal((await post("/summarize", { text: "teste", allowCloud: true })).status, 429);
    assert.equal(calls, 3);
    disconnect.abort();
    assert.equal(await first, "AbortError");
    await stopped.promise;
    const retry = post("/transcribe", body);
    // A rejected retry must fail immediately, even while the two other slots are busy.
    await Promise.race([replacement.promise, retry.then(r => assert.equal(r.status, 200))]);
    release.resolve();
    assert.equal((await retry).status, 200);
    assert.deepEqual((await others).map(response => response.status), [200, 200]);
  } finally {
    release.resolve();
    disconnect.abort();
  }
});

test("a porta de escuta aceita inteiros TCP e rejeita configurações ambíguas", () => {
  assert.equal(serverPort(undefined), 43110);
  assert.equal(serverPort("0"), 0);
  assert.equal(serverPort("1234"), 1234);
  for (const value of [" ", "0x50", "1e3", "-1", "1.5", "65536", "private-marker"]) {
    assert.throws(() => serverPort(value), { message: "PORT deve ser uma porta TCP válida." });
  }
});

test("modo local usa apenas PCM para limitar duração e remove temporários em todos os resultados", {
  skip: process.platform === "win32" && "Executáveis de teste usam shebang POSIX",
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-test-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ffmpeg = path.join(dir, "decoder");
  const whisper = path.join(dir, "recognizer");
  const record = path.join(dir, "workdir");
  // Sparse WAV files exercise sample boundaries without generating 15 minutes of speech.
  await writeFile(ffmpeg, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const bytes = Number(fs.readFileSync(args[args.indexOf("-i") + 1], "utf8"));
fs.writeFileSync(${JSON.stringify(record)}, process.cwd());
const header = Buffer.alloc(24);
header.write("RIFF");
header.writeUInt32LE(24 + bytes, 4);
header.write("WAVE", 8);
header.write("JUNK", 12);
header.writeUInt32LE(3, 16);
const data = Buffer.alloc(8);
data.write("data");
data.writeUInt32LE(bytes, 4);
const file = args.at(-1);
fs.writeFileSync(file, Buffer.concat([header, data]));
fs.truncateSync(file, 32 + bytes);
`, { mode: 0o700 });
  await writeFile(whisper, `#!${process.execPath}
process.stdout.write("fala sintética");
`, { mode: 0o700 });
  const { post } = await service(t, { FFMPEG_PATH: ffmpeg, WHISPER_CLI_PATH: whisper });
  for (const [bytes, allowCloud, status] of [[28_800_000, undefined, 200], [2, true, 200], [28_800_002, false, 413], [0, false, 422]]) {
    const response = await post("/transcribe", {
      ...audio, data: Buffer.from(String(bytes)).toString("base64"), provider: "openrouter", allowCloud,
    });
    assert.equal(response.status, status);
    if (status === 200) assert.deepEqual(await response.json(), { text: "fala sintética", usage: null });
    await assert.rejects(access(await readFile(record, "utf8")), { code: "ENOENT" });
  }
  const blocked = await post("/summarize", { text: "teste", allowCloud: true });
  assert.equal(blocked.status, 403);
});

const workerType = "application/vnd.whatsapp-transcriber+json";
const workerHeaders = { ...headers, Accept: workerType };

test("MV3 recebe cabeçalhos e espaço antes do provedor e um único documento JSON ao final", { timeout: 4000 }, async t => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { post } = await service(t, cloud, async () => {
    await release.promise;
    return Response.json({ text: "confirmado" });
  });
  const response = await post("/transcribe", { ...audio, allowCloud: true }, workerHeaders);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), workerType + "; charset=utf-8");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), " ");
  release.resolve();
  const chunks = [first.value];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { text: "confirmado", usage: null });
});

test("MV3 mantém rejeições HTTP antes do trabalho e informa falhas tardias no JSON", async t => {
  let calls = 0;
  const { post, endpoint } = await service(t, cloud, () => {
    calls++;
    return new Response("private-marker", { status: 429 });
  });
  const preflight = await fetch(endpoint + "/summarize", { method: "OPTIONS", headers: {
    Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Accept, Content-Type",
  } });
  assert.equal(preflight.status, 204);
  for (const [body, status] of [[{ text: "teste" }, 403], [{ text: "", allowCloud: true }, 400]]) {
    const response = await post("/summarize", body, workerHeaders);
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type"), /^application\/json/);
  }
  assert.equal(calls, 0);
  const body = { text: "teste", allowCloud: true };
  const worker = await post("/summarize", body, workerHeaders);
  const legacy = await post("/summarize", body);
  assert.equal(worker.status, 200);
  assert.equal(legacy.status, 429);
  const { error } = await legacy.json();
  assert.match(error, /aguarde/i);
  assert.deepEqual(await worker.json(), { error, status: 429 });
});

test("MV3 conclui com erro de timeout após o início da resposta", { timeout: 4000 }, async t => {
  const deadline = new AbortController();
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", ms => ms === 35_000 ? deadline.signal : original(ms));
  const { post } = await service(t, cloud, (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const response = await post("/summarize", { text: "teste", allowCloud: true }, workerHeaders);
  deadline.abort();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 504);
  assert.match(result.error, /demorou/);
});

test("POST /pair confirma origem e configuração sem corpo nem chamada ao provedor", async t => {
  for (const [env, expected] of [[cloud, 200], [{ TRANSCRIPTION_PROVIDER: "openrouter" }, 503]]) {
    const { endpoint } = await service(t, env);
    const health = await fetch(endpoint + "/health");
    assert.equal(health.status, expected);
    const pair = (method, h, body) => fetch(endpoint + "/pair", { method, headers: h, body });
    for (const source of [undefined, origin.replace(/a$/, "b")]) {
      const h = source ? { Origin: source } : {};
      for (const response of [
        await pair("POST", h),
        await pair("OPTIONS", { ...h, "Access-Control-Request-Method": "POST" }),
      ]) {
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
    }
    const h = { Origin: origin };
    const options = await pair("OPTIONS", { ...h, "Access-Control-Request-Method": "POST" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-methods"), "POST");
    assert.equal(options.headers.get("access-control-allow-origin"), origin);
    assert.equal((await pair("OPTIONS", { ...h, "Access-Control-Request-Method": "GET" })).status, 403);
    assert.equal((await pair("GET", h)).status, 405);
    assert.equal((await pair("POST", h, "{}")).status, 400);
    const response = await pair("POST", h);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.deepEqual(await response.json(), await health.json());
  }
});
