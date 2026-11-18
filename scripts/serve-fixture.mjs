import http from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const allowed = new Map([
  ["/tests/fixture.html", "text/html"],
  ["/tests/bridge-fixture.html", "text/html"],
  ["/extension/content.js", "text/javascript"],
  ["/extension/page-bridge.js", "text/javascript"],
  ["/extension/content.css", "text/css"],
]);

http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const type = allowed.get(path);
  if (!type || req.method !== "GET") {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL(path.slice(1), root));
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
}).listen(43111, "127.0.0.1", () => console.log("Fixture em http://127.0.0.1:43111/tests/fixture.html"));
