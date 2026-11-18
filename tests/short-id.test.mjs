import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridge = new vm.Script(await readFile(new URL("../extension/page-bridge.js", import.meta.url), "utf8"), {
  filename: "page-bridge.js",
});
const origin = "https://web.whatsapp.com";
const shortId = "3EB0123456789ABCDEF0";

function chat(address) {
  const models = [];
  return {
    id: { _serialized: address, toString: () => address },
    models,
    msgs: { getModelsArray: () => [...models] },
  };
}

function audio(owner, sample, fromMe = false) {
  const canonical = `${fromMe}_${owner.id._serialized}_${shortId}`;
  const bytes = Uint8Array.of(0, sample, 255);
  const blob = new Blob([bytes], { type: "audio/ogg" });
  const model = {
    id: { id: shortId, remote: owner.id, fromMe, _serialized: canonical, toString: () => canonical },
    type: "ptt",
    mediaData: { mediaBlob: blob },
  };
  owner.models.push(model);
  return { model, blob, canonical, data: Buffer.from(bytes).toString("base64") };
}

function fixture() {
  const a = chat("11111111111@c.us");
  const b = chat("22222222222@c.us");
  let active = a;
  let listener;
  let serial = 0;
  const rawLookups = [];
  const mediaCalls = [];
  const replies = [];
  const track = name => () => { mediaCalls.push(name); };
  const player = {
    play: track("play"), pause: track("pause"), click: track("click"),
    captureStream: track("captureStream"), closest: () => row,
  };
  const row = {
    dataset: { id: shortId }, isConnected: true,
    getAttribute: key => key === "data-id" ? shortId : null,
    querySelector: () => player, querySelectorAll: () => [player],
  };
  const rows = selector => ['[data-id]', `[data-id="${shortId}"]`].includes(selector) ? [row] : [];
  // Global order stays fixed when the active chat changes. A short-key lookup
  // deliberately returns the first collision, like an unsafe unscoped store.
  const models = () => [...b.models, ...a.models];
  const get = id => {
    if (id === shortId) {
      rawLookups.push(id);
      return models().find(m => m.id.id === id);
    }
    return models().find(m => m.id.toString() === id);
  };
  const collections = {
    Chat: { getActive: () => active },
    Msg: { getModelsArray: models, get, getMessagesById: async ids => ({ messages: ids.map(get).filter(Boolean) }) },
  };
  const globals = {
    Blob, URL, btoa, location: { origin }, CSS: { escape: String },
    document: Object.assign(new EventTarget(), {
      querySelectorAll: rows, querySelector: selector => rows(selector)[0] ?? null,
    }),
    navigator: { mediaDevices: { getUserMedia: track("getUserMedia"), getDisplayMedia: track("getDisplayMedia") } },
    MediaRecorder: class { constructor() { mediaCalls.push("MediaRecorder"); } },
    fetch: track("fetch"),
  };
  const window = {
    ...globals,
    require(name) {
      if (name === "WAWebCollections") return collections;
      if (name === "WAWebCmd") return { Cmd: { getActiveChat: () => active } };
      throw Error(name);
    },
    addEventListener(name, callback) { if (name === "message") listener = callback; },
    postMessage(message, target) {
      assert.equal(target, origin);
      replies.push(message);
    },
  };
  bridge.runInNewContext({ ...globals, window });

  return {
    a, b, rawLookups,
    activate(owner) { active = owner; },
    async request() {
      const requestId = `request-${++serial}`;
      await listener({ source: window, origin, data: {
        source: "wpp-transcriber", direction: "to-page", type: "wpp-transcriber:message",
        requestId, messageId: row.dataset.id,
      } });
      const matches = replies.filter(reply => reply.requestId === requestId);
      assert.equal(matches.length, 1);
      const [reply] = matches;
      assert.equal(reply.source, "wpp-transcriber");
      assert.equal(reply.direction, "from-page");
      assert.equal(reply.type, "result");
      assert.equal(reply.messageId, shortId);
      assert.deepEqual(mediaCalls, [], "player, captura ou fetch acionado");
      return reply;
    },
  };
}

function accepted(reply, item) {
  assert.equal(reply.error, undefined);
  assert.equal(reply.canonicalId, item.canonical);
  assert.equal(reply.data, item.data);
  assert.equal(reply.size, item.blob.size);
  assert.equal(reply.mime, item.blob.type);
}

function rejected(reply) {
  assert.equal(reply.error, "AUDIO_UNAVAILABLE");
  for (const field of ["canonicalId", "data", "size", "mime"]) assert.equal(reply[field], undefined, field);
}

test("o mesmo ID curto no DOM retorna os bytes e o ID canônico da conversa ativa", async () => {
  const f = fixture();
  const first = audio(f.a, 1);
  const second = audio(f.b, 2);
  accepted(await f.request(), first);
  f.activate(f.b);
  accepted(await f.request(), second);
});

test("o bridge nunca fornece o ID curto à busca global por chave", async () => {
  const f = fixture();
  audio(f.b, 2);
  await f.request();
  audio(f.a, 1);
  await f.request();
  assert.deepEqual(f.rawLookups, []);
});

test("ID curto presente apenas em outra conversa é recusado", async () => {
  const f = fixture();
  audio(f.b, 2);
  rejected(await f.request());
});

test("sem conversa ativa, a coleção global não autoriza ler o áudio", async () => {
  const f = fixture();
  audio(f.a, 1);
  f.activate(null);
  rejected(await f.request());
});

test("sem coleção local, um ID curto de outra conversa continua inacessível", async () => {
  const f = fixture();
  delete f.a.msgs;
  audio(f.b, 2);
  rejected(await f.request());
});

test("duas mensagens da conversa ativa com o mesmo ID curto são ambíguas", async () => {
  const f = fixture();
  audio(f.a, 1);
  audio(f.a, 2, true);
  rejected(await f.request());
});

for (const field of ["model", "mediaData", "mediaObject"]) {
  test(`visualização única em ${field} bloqueia o áudio mesmo com colisão em outra conversa`, async () => {
    const f = fixture();
    const { model, blob } = audio(f.a, 1);
    delete model.mediaData.mediaBlob;
    model.mediaObject = {};
    (field === "model" ? model : model[field]).isViewOnce = true;
    let downloads = 0;
    model.downloadMedia = async () => { downloads++; return blob; };
    audio(f.b, 2);
    rejected(await f.request());
    assert.equal(downloads, 0);
  });
}

for (const stage of ["downloadMedia", "arrayBuffer"]) {
  test(`troca de conversa durante ${stage} invalida o pedido com ID curto`, async () => {
    const f = fixture();
    const { model, blob } = audio(f.a, 1);
    const second = audio(f.b, 2);
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    async function pause() {
      started.resolve();
      await resume.promise;
    }
    if (stage === "downloadMedia") {
      delete model.mediaData.mediaBlob;
      model.downloadMedia = async () => { await pause(); return blob; };
    } else {
      blob.arrayBuffer = async () => { await pause(); return Blob.prototype.arrayBuffer.call(blob); };
    }
    const pending = f.request();
    await Promise.race([started.promise, pending.then(() => assert.fail(`pedido terminou antes de ${stage}`))]);
    f.activate(f.b);
    resume.resolve();
    rejected(await pending);
    accepted(await f.request(), second);
  });
}


test("mensagem fora da janela carregada usa chaves completas da conversa ativa", async () => {
  const f = fixture();
  const note = audio(f.a, 8);
  audio(f.b, 3);
  delete note.model.id._serialized;
  delete f.a.id._serialized;
  f.a.msgs.getModelsArray = () => [];
  accepted(await f.request(), note);
  assert.deepEqual(f.rawLookups, []);
});
