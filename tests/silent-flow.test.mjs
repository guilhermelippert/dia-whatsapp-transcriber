import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const binary = process.env.HELIUM_BINARY || "/Applications/Helium.app/Contents/MacOS/Helium";
const source = new URL("../extension/", import.meta.url);

test("Helium executa a fila silenciosa em mundos MAIN e ISOLATED", {
  skip: existsSync(binary) ? false : "Helium não instalado",
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "helium-silent-flow-"));
  const fixture = await readFile(new URL("bridge-fixture.html", import.meta.url));
  const completion = Promise.withResolvers();
  const documents = new Map();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Connection", "close");
    if (req.url === "/?extension") {
      return res.setHeader("content-type", "text/html").end(fixture);
    }
    if (req.method !== "POST") return res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const [route, docId] = req.url.slice(1).split("/");
    if (!docId) return res.writeHead(404).end();
    if (!documents.has(docId)) documents.set(docId, { provider: "local", sends: [], summaries: [] });
    const doc = documents.get(docId);
    if (route === "provider") {
      doc.provider = body;
      return res.end();
    }
    if (route === "result") {
      completion.resolve({ ...JSON.parse(body), doc });
      return res.end();
    }
    if (route !== "runtime") return res.writeHead(404).end();
    const msg = JSON.parse(body);
    if (msg.type === "health") return res.end(JSON.stringify({ ok: true, provider: doc.provider }));
    if (msg.type === "summarize") {
      doc.summaries.push(doc.provider);
      return res.end(JSON.stringify({ ok: true, text: "Resumo sintético" }));
    }
    doc.sends.push(msg);
    return res.end(JSON.stringify({ ok: true, text: msg.data }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(dir, "extension");
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await exited;
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await mkdir(extension);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", source), "utf8"));
  const matches = ["http://127.0.0.1/*"];
  manifest.host_permissions = matches;
  for (const script of manifest.content_scripts) {
    script.matches = matches;
    for (const file of [...script.js, ...(script.css || [])]) {
      await copyFile(new URL(file, source), path.join(extension, file));
    }
    if (script.world === "MAIN") script.js.unshift("observe.js");
    else script.js.unshift("identify-fixture.js");
  }
  delete manifest.icons;
  delete manifest.action;
  await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(extension, "observe.js"), `(() => {
    let playerCalls = 0;
    let externalReads = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (["http:", "https:"].includes(url.protocol) && url.origin !== location.origin) {
        externalReads++;
        return Promise.reject(new Error("Origem externa na fixture"));
      }
      return originalFetch(input, options);
    };
    for (const method of ["play", "pause"]) HTMLMediaElement.prototype[method] = () => { playerCalls++; };
    const hooks = [
      [HTMLMediaElement.prototype, ["play", "pause", "captureStream"]],
      [window, ["fetch", "MediaRecorder"]], [XMLHttpRequest.prototype, ["open", "send"]],
      [URL, ["createObjectURL", "revokeObjectURL"]], [MediaSource.prototype, ["addSourceBuffer"]],
      [SourceBuffer.prototype, ["appendBuffer"]],
    ].flatMap(([obj, keys]) => keys.map(key => [obj, key, obj[key]]));
    window.checkSilentAPIs = () => {
      if (playerCalls || externalReads || hooks.some(([obj, key, fn]) => obj[key] !== fn)) throw Error("Player ou API de mídia alterado");
    };
  })();`);
  await writeFile(path.join(extension, "identify-fixture.js"), `
    chrome.runtime.sendMessage({ type: "fixture-document" }).then(id => {
      document.documentElement.dataset.fixtureDocument = id;
    });
  `);
  await writeFile(path.join(extension, manifest.background.service_worker), `
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.type === "fixture-document") {
        respond(sender.documentId);
        return;
      }
      fetch(${JSON.stringify(origin + "/runtime/")} + sender.documentId, { method: "POST", body: JSON.stringify(message) })
        .then(r => r.json()).then(respond, () => respond({ ok: false }));
      return true;
    });
  `);
  child = spawn(binary, [
    ...(process.platform === "darwin" ? ["--use-mock-keychain", "--password-store=basic"] : []),
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--user-data-dir=${path.join(dir, "profile")}`, `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`, origin + "/?extension",
  ], { stdio: "ignore" });
  exited = once(child, "exit");
  const timeout = setTimeout(() => completion.reject(new Error("Helium não concluiu a fixture")), 60000);
  try {
    const result = await Promise.race([completion.promise, exited.then(([code]) => {
      throw new Error("Helium encerrou antes da fixture, código " + code);
    })]);
    assert.equal(result.error, undefined);
    assert.equal(result.expected.length, 6);
    assert.deepEqual(result.doc.sends, result.expected.map(data => ({ type: "transcribe", data, format: "wav" })));
    assert.deepEqual(result.doc.summaries, ["openrouter"]);
    // Some Helium versions reload startup tabs. Even an interrupted document
    // must have sent only the expected prefix before it was replaced.
    for (const doc of documents.values()) {
      assert.deepEqual(doc.sends, result.doc.sends.slice(0, doc.sends.length));
      assert.deepEqual(doc.summaries, ["openrouter"].slice(0, doc.summaries.length));
    }
  } finally {
    clearTimeout(timeout);
  }
});
