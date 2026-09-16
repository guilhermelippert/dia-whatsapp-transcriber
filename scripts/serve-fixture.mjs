import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
http.createServer((req, res) => {
  const relative = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const target = path.resolve(root, relative || "tests/fixture.html");
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": `${types[path.extname(target)] || "application/octet-stream"}; charset=utf-8` });
  fs.createReadStream(target).pipe(res);
}).listen(43111, "127.0.0.1", () => console.log("Fixture em http://127.0.0.1:43111/tests/fixture.html"));
