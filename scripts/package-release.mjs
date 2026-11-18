import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

// Package the committed source so local keys, models and browser data cannot
// enter either ZIP through a recursive copy of the developer's checkout.
const revision = git("rev-parse", "HEAD").trim();
const manifest = JSON.parse(git("show", revision + ":extension/manifest.json"));
const extensionFiles = [
  "manifest.json", manifest.background.service_worker, manifest.action.default_popup, "popup.js", "popup.css",
  ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])]),
  ...Object.values(manifest.icons),
];
mkdirSync(dist, { recursive: true });
function archive(name, tree, args) {
  const output = fileURLToPath(new URL(name, dist));
  git("archive", "--format=zip", "-o", output, ...args.options, tree, "--", ...args.files);
  console.log(output);
}
archive("whatsapp-transcriber-extension.zip", revision + ":extension", { options: [], files: extensionFiles });
archive("whatsapp-transcriber-setup.zip", revision, {
  options: ["--prefix=whatsapp-transcriber/"],
  files: ["README.md", "LICENSE", "SECURITY.md", "PRIVACY.md", "docs/diagram", ".env.example", "package.json",
    "server.mjs", "src", "scripts", "tests", ...extensionFiles.map(name => "extension/" + name),
    ...git("ls-tree", "--name-only", revision).trim().split("\n").filter(name => /\.(command|cmd)$/.test(name))],
});
