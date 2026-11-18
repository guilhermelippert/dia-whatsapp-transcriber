import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const audio = { type: "transcribe", data: "YQ==", format: "wav" };
const summary = { type: "summarize", text: "Teste" };
const health = { service: "dia-whatsapp-transcriber", apiVersion: 2, ok: true, provider: "openrouter" };

function worker() {
  let listener;
  const state = {
    health: { ...health }, saved: {}, posts: [], timers: new Set(), ticks: 0,
    response: () => Response.json({ text: "resultado" }),
  };
  const chrome = {
    runtime: {
      onMessage: { addListener: cb => { listener = cb; } },
      getPlatformInfo: async () => { state.ticks++; },
    },
    storage: { local: { get: async defaults => ({ ...defaults, ...state.saved }) } },
  };
  vm.runInNewContext(source, {
    chrome, AbortSignal,
    setInterval(fn, ms) { assert.equal(ms, 20_000); state.timers.add(fn); return fn; },
    clearInterval(fn) { assert.ok(state.timers.delete(fn)); },
    fetch: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (url.endsWith("/pair")) {
        assert.equal(options.method, "POST");
        assert.equal(options.body, undefined);
        return Response.json(state.health, { status: state.pairStatus || 200 });
      }
      state.posts.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      assert.equal(options.headers.Accept, "application/vnd.whatsapp-transcriber+json");
      return state.response(options);
    },
  });
  state.send = (msg, url = "https://web.whatsapp.com/") =>
    new Promise(resolve => listener(msg, { url }, resolve));
  return state;
}

test("só autorização explícita persistida libera áudio e texto para a nuvem", async () => {
  const w = worker();
  for (const stored of [undefined, false, "true", 1]) {
    w.saved.openRouterConsent = stored;
    for (const msg of [audio, summary]) {
      assert.match((await w.send({ ...msg, allowCloud: true })).error, /autorize/i);
    }
  }
  assert.equal(w.posts.length, 0);
  w.saved.openRouterConsent = true;
  for (const msg of [audio, summary]) assert.ok((await w.send({ ...msg, allowCloud: false })).ok);
  assert.deepEqual(w.posts, [
    { path: "/transcribe", body: { data: audio.data, format: "wav", model: "openai/whisper-large-v3", language: "pt", allowCloud: true } },
    { path: "/summarize", body: { text: summary.text, allowCloud: true } },
  ]);
  w.saved.openRouterConsent = false;
  assert.equal((await w.send(audio)).ok, false);
  assert.equal((await w.send(summary)).ok, false);
  assert.equal(w.posts.length, 2);
  assert.equal(w.timers.size, 0);
});

test("Whisper recebe false e uma troca de serviço exige nova verificação antes do POST", async () => {
  const w = worker();
  w.health.provider = "local";
  assert.ok((await w.send({ ...audio, allowCloud: true })).ok);
  assert.equal(w.posts[0].body.allowCloud, false);
  w.saved.openRouterConsent = true;
  assert.ok((await w.send({ ...audio, allowCloud: true })).ok);
  assert.equal(w.posts[1].body.allowCloud, false);
  for (const apiVersion of [undefined, 1, "2"]) {
    w.health.apiVersion = apiVersion;
    for (const msg of [audio, summary]) assert.match((await w.send(msg)).error, /atualize/i);
  }
  w.health = { ...health, service: "outro" };
  assert.equal((await w.send(audio)).ok, false);
  w.health = health;
  assert.equal((await w.send(audio, "https://example.org/")).ok, false);
  assert.equal(w.posts.length, 2);
});

test("keepalive cobre a leitura completa do corpo e erro no JSON com HTTP 200 libera o timer", async () => {
  const w = worker();
  w.saved.openRouterConsent = true;
  const started = Promise.withResolvers();
  const finalBody = Promise.withResolvers();
  w.response = () => ({ ok: true, status: 200, json: () => { started.resolve(); return finalBody.promise; } });
  const pending = w.send(audio);
  await started.promise;
  assert.equal(w.timers.size, 1);
  await [...w.timers][0]();
  assert.equal(w.ticks, 1);
  finalBody.resolve({ error: "Serviço ocupado." });
  assert.equal((await pending).error, "Serviço ocupado.");
  assert.equal(w.timers.size, 0);
  w.response = () => { throw new Error(); };
  assert.equal((await w.send(audio)).ok, false);
  assert.equal(w.timers.size, 0);
});

test("falhas de pareamento e versões antigas impedem qualquer envio de dados", async () => {
  const w = worker();
  w.saved.openRouterConsent = true;
  for (const status of [403, 404, 405]) {
    w.pairStatus = status;
    for (const msg of [{ type: "health" }, audio, summary]) {
      assert.match((await w.send(msg)).error, status === 403 ? /ALLOWED_EXTENSION_ORIGINS/ : /Atualize/);
    }
  }
  assert.equal(w.posts.length, 0);
});
