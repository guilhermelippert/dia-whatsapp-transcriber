import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const binary = process.env.HELIUM_BINARY || "/Applications/Helium.app/Contents/MacOS/Helium";
const longResponse = process.env.TEST_EXTENSION_LONG_RESPONSE === "1";

test("popup real autoriza, persiste após reabrir e revoga com o serviço indisponível", {
  skip: existsSync(binary) ? false : "Helium não instalado",
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-popup-"));
  const ext = path.join(dir, "extension");
  const completion = Promise.withResolvers();
  const posts = [];
  let offline = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Connection", "close");
    if (req.url === "/fixture") res.setHeader("Content-Type", "text/html");
    if (req.url === "/fixture") return res.end("<html lang='pt-BR'></html>");
    if (req.url === "/offline") { offline = true; return res.end(); }
    if (req.url === "/online") { offline = false; return res.end(); }
    if (req.url === "/pair" && req.method === "POST") {
      res.writeHead(offline ? 503 : 200);
      return res.end(JSON.stringify(offline ? { error: "Serviço desativado para o teste" }
        : { service: "dia-whatsapp-transcriber", apiVersion: 2, ok: true, provider: "openrouter" }));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/result") {
      completion.resolve(JSON.parse(body));
      return res.end();
    }
    if (req.url === "/transcribe") {
      posts.push({ accept: req.headers.accept, ...JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      res.write(" ");
      const finish = () => res.end(JSON.stringify({ text: "Teste concluído" }));
      if (longResponse) setTimeout(finish, 36_000);
      else finish();
      return;
    }
    res.writeHead(404).end();
  });
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await exited;
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  await cp(new URL("../extension/", import.meta.url), ext, { recursive: true });
  const manifestFile = path.join(ext, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["fixture.js"] }];
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(manifestFile, JSON.stringify(manifest));
  const bg = path.join(ext, manifest.background.service_worker);
  const background = (await readFile(bg, "utf8")).replace("http://127.0.0.1:43110", origin)
    .replace("https://web.whatsapp.com/", origin + "/");
  await writeFile(bg, background + '\nchrome.runtime.onInstalled.addListener(() => setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }), 2500));');
  await writeFile(path.join(ext, "fixture.js"), `
    chrome.runtime.onMessage.addListener((m, sender, respond) => {
      if (m.type === "ping") { respond(true); return; }
      chrome.runtime.sendMessage(m).then(respond);
      return true;
    });
  `);
  await appendFile(path.join(ext, "popup.html"), '<script src="popup-test.js"></script>');
  await writeFile(path.join(ext, "popup-test.js"), `
    (async () => {
      const origin = ${JSON.stringify(origin)};
      const button = document.querySelector("#toggle-consent");
      const wait = async fn => {
        for (let i = 0; i < 200; i++) {
          if (await fn()) return;
          await new Promise(r => setTimeout(r, 30));
        }
        throw Error("Tempo excedido: " + fn);
      };
      const check = (ok, message) => { if (!ok) throw Error(message); };
      let error;
      try {
        await wait(() => !button.disabled);
        check(document.querySelector("#origin").value === location.origin, "Origem incorreta");
        const msg = { type: "transcribe", data: "YQ==", format: "wav", allowCloud: true };
        if (!location.search) {
          const tab = await chrome.tabs.create({ url: origin + "/fixture", active: false });
          await wait(() => chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => false));
          check(!(await chrome.tabs.sendMessage(tab.id, msg)).ok, "Envio antes de autorizar");
          button.click();
          await wait(() => button.textContent.includes("Revogar"));
          check((await chrome.tabs.sendMessage(tab.id, msg)).text === "Teste concluído", "Envio autorizado falhou");
          location.search = "?tab=" + tab.id;
          return;
        }
        check(button.textContent.includes("Revogar"), "Autorização perdida ao reabrir");
        const retry = document.querySelector("#retry");
        await wait(() => !retry.disabled);
        await fetch(origin + "/offline");
        retry.click();
        await wait(() => document.querySelector(".status").dataset.state === "error");
        check(!button.disabled, "Revogação indisponível offline");
        button.click();
        await wait(() => document.querySelector("#consent-state").textContent.includes("bloqueado"));
        await fetch(origin + "/online");
        const tabId = Number(new URLSearchParams(location.search).get("tab"));
        check(!(await chrome.tabs.sendMessage(tabId, msg)).ok, "Envio após revogar");
      } catch (e) { error = e.message; }
      await fetch(origin + "/result", { method: "POST", body: JSON.stringify({ error }) });
    })();
  `);
  child = spawn(binary, [
    ...(process.platform === "darwin" ? ["--use-mock-keychain", "--password-store=basic"] : []),
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--user-data-dir=" + path.join(dir, "profile"), "--disable-extensions-except=" + ext,
    "--load-extension=" + ext, "about:blank",
  ], { stdio: "ignore" });
  exited = once(child, "exit");
  const timer = setTimeout(() => completion.reject(new Error("Popup não concluiu o teste")), longResponse ? 65_000 : 20_000);
  try {
    const result = await Promise.race([completion.promise, exited.then(() => { throw Error("Helium encerrou"); })]);
    assert.equal(result.error, undefined);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].allowCloud, true);
    assert.equal(posts[0].accept, "application/vnd.whatsapp-transcriber+json");
  } finally {
    clearTimeout(timer);
  }
});
