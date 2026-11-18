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

async function runInHelium(dir, url, completion, flags) {
  const child = spawn(binary, [
    "--use-mock-keychain", "--password-store=basic",
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--user-data-dir=${path.join(dir, "profile")}`, ...flags, url,
  ], { stdio: "ignore" });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => completion.reject(new Error("Helium não concluiu a fixture")), 60000);
  try {
    return await Promise.race([completion.promise, exited.then(([code]) => {
      throw new Error("Helium encerrou antes da fixture, código " + code);
    })]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await exited;
  }
}

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
  t.after(async () => {
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
  const result = await runInHelium(dir, origin + "/?extension", completion, [
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  ]);
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
});

// Executed in the visual fixture, after its normal content scripts have loaded.
async function measureDarkPanels() {
  if (!matchMedia("(prefers-color-scheme: dark)").matches) throw Error("Tema escuro inativo");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  function luminance() {
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
    const linear = channel => {
      const s = channel / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }
  function contrast(button) {
    const layers = [];
    for (let el = button; el; el = el.parentElement) layers.unshift(getComputedStyle(el).backgroundColor);
    function paint(color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
    }
    paint("white");
    layers.forEach(paint);
    const background = luminance();
    paint(getComputedStyle(button).color);
    const foreground = luminance();
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  }
  function bounds(el) {
    const { left, right, top, bottom, width } = el.getBoundingClientRect();
    return { left, right, top, bottom, width };
  }
  const results = [];
  for (const side of ["in", "out"]) {
    const bubble = document.querySelector(side === "out" ? '[data-testid="msg-container"]' : ".message-in > .copyable-text");
    const row = bubble.closest("[data-id]");
    const deadline = performance.now() + 20000;
    let panel;
    do {
      panel = row.querySelector('.wpp-transcriber[data-state="success"]');
      if (panel) break;
      if (performance.now() >= deadline) throw Error("Painel ausente para .message-" + side);
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    const buttons = [".wpp-transcriber__button:not(.wpp-transcriber__summary)", ".wpp-transcriber__summary", ".wpp-transcriber__copy"].map(selector => {
      const button = panel.querySelector(selector);
      if (!button?.checkVisibility() || !bounds(button).width) throw Error("Botão oculto ou ausente: " + selector);
      return { label: button.textContent.trim(), contrast: contrast(button) };
    });
    results.push({ side, bubble: bounds(bubble), row: bounds(row), panel: bounds(panel), buttons });
  }
  return results;
}

test("Painel acompanha a bolha recebida e enviada e mantém contraste no tema escuro", {
  skip: existsSync(binary) ? false : "Helium não instalado",
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "helium-panel-layout-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const completion = Promise.withResolvers();
  const fixture = await readFile(new URL("fixture.html", import.meta.url), "utf8");
  const probe = `<script>
    (${measureDarkPanels.toString()})().then(panels => ({ panels }), e => ({ error: e.message }))
      .then(result => fetch("/result", { method: "POST", body: JSON.stringify(result) }));
    </script>`;
  const assets = new Map();
  for (const file of ["content.css", "content.js", "page-bridge.js"]) {
    assets.set("/extension/" + file, await readFile(new URL(file, source)));
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.end();
      completion.resolve(JSON.parse(body));
    } else if (req.url === "/tests/fixture.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8").end(fixture.replace("</body>", () => probe + "</body>"));
    } else if (assets.has(req.url)) {
      res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : "text/javascript").end(assets.get(req.url));
    } else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runInHelium(dir, `http://127.0.0.1:${server.address().port}/tests/fixture.html`, completion,
    ["--force-dark-mode", "--window-size=900,900"]);
  assert.equal(result.error, undefined);
  for (const { side, bubble, row, panel, buttons } of result.panels) {
    const edge = side === "out" ? "right" : "left";
    assert.ok(row.width - bubble.width >= 80, `.message-${side}: fixture sem espaço lateral`);
    const oppositeEdge = side === "out" ? "left" : "right";
    assert.ok(Math.abs(row[edge] - bubble[edge]) < Math.abs(row[oppositeEdge] - bubble[oppositeEdge]),
      `.message-${side}: bolha fora do lado esperado`);
    assert.ok(Math.abs(panel[edge] - bubble[edge]) <= 2, `.message-${side}: painel desalinhado à ${edge}`);
    assert.ok(panel.width > 0 && Math.abs(panel.width - bubble.width) <= 2, `.message-${side}: largura fora da bolha`);
    assert.ok(panel.top >= bubble.bottom - 1, `.message-${side}: painel sobrepõe a bolha`);
    for (const button of buttons) {
      assert.ok(button.contrast >= 4.5, `.message-${side}: contraste de ${button.label} = ${button.contrast.toFixed(2)}:1`);
    }
  }
});
