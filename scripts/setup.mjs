import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerConfig, providerHealth } from "../src/provider-config.mjs";
import { EXTENSION_ORIGIN } from "../src/server-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function origins(raw) {
  const values = raw.split(",").map(part => {
    const id = part.trim();
    return /^[a-p]{32}$/.test(id) ? "chrome-extension://" + id : id;
  });
  if (values.some(value => !EXTENSION_ORIGIN.test(value) || !value.startsWith("chrome-extension://"))) {
    throw new Error("Copie o ID de 32 letras (a até p) ou a origem chrome-extension:// completa, sem barra final.");
  }
  return [...new Set(values)].join(",");
}

function executable(file) {
  if (!path.isAbsolute(file) || (process.platform === "win32" && !file.toLowerCase().endsWith(".exe"))) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findExecutable(name) {
  const filename = process.platform === "win32" ? name + ".exe" : name;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, filename);
    if (executable(file)) return file;
  }
}

function localPath(raw, dir) {
  const value = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Informe o caminho do arquivo em uma única linha.");
  return path.resolve(dir, value);
}

export function terminal(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error("Abra o assistente em um terminal interativo.");
  let hidden = false;
  const display = new Writable({
    write(chunk, encoding, done) {
      if (hidden) done();
      else output.write(chunk, encoding, done);
    },
  });
  const rl = createInterface({ input, output: display, terminal: true, historySize: 0 });
  const abort = new AbortController();
  rl.on("close", () => abort.abort());
  rl.on("SIGINT", () => rl.close());
  return {
    async ask(label, secret = false) {
      // Print the prompt separately so the entire readline redraw stays muted.
      hidden = secret;
      if (secret) output.write(label + " ");
      try {
        return await rl.question(secret ? "" : label + " ", { signal: abort.signal });
      } finally {
        // Keep any pending redraw muted until the next prompt.
        if (secret) output.write("\n");
      }
    },
    tell(message) { output.write(message + "\n"); },
    close() { rl.close(); },
  };
}

async function field(ui, label, validate, { fallback = "", secret = false } = {}) {
  for (;;) {
    const answer = await ui.ask(label + (fallback ? " [" + fallback + "]" : "") + ":", secret);
    try {
      return validate(answer || fallback);
    } catch (error) {
      ui.tell(error.message);
    }
  }
}

function validateConfig(env) {
  const health = providerHealth(providerConfig(env));
  if (!health.ok) throw new Error(health.error);
}

function configExists(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new Error(".env.local deve ser um arquivo regular.");
  return Boolean(info);
}

export async function setup(dir, ui) {
  const dest = path.join(dir, ".env.local");
  if (configExists(dest)) {
    ui.tell(".env.local já existe. Para alterar a configuração, abra esse arquivo no editor.");
    return;
  }
  ui.tell("Em chrome://extensions, carregue a pasta extension e copie o ID do cartão.");
  const allowed = await field(ui, "ID ou origem da extensão (separe vários por vírgula)", origins);
  const provider = await field(ui, "Provedor (local ou openrouter)", value => {
    if (!["local", "openrouter"].includes(value)) throw new Error("Escolha local ou openrouter.");
    return value;
  }, { fallback: "local" });
  const env = { TRANSCRIPTION_PROVIDER: provider, ALLOWED_EXTENSION_ORIGINS: allowed };
  if (provider === "local") {
    for (const [key, name] of [["FFMPEG_PATH", "ffmpeg"], ["WHISPER_CLI_PATH", "whisper-cli"]]) {
      env[key] = await field(ui, "Caminho do executável " + name, raw => {
        const file = localPath(raw, dir);
        if (!executable(file)) throw new Error("Informe um arquivo executável de " + name + ".");
        return file;
      }, { fallback: findExecutable(name) });
    }
    const model = path.join("models", "ggml-base.bin");
    env.WHISPER_MODEL_PATH = await field(ui, "Caminho do modelo GGML multilíngue (.bin)", raw => {
      const file = localPath(raw, dir);
      validateConfig({ ...env, WHISPER_MODEL_PATH: file });
      return file;
    }, { fallback: fs.existsSync(path.join(dir, model)) ? model : "" });
  } else {
    ui.tell("Autorize o envio no popup para usar OpenRouter. A transcrição na nuvem pode gerar cobranças.");
    env.OPENROUTER_API_KEY = await field(ui, "Chave OpenRouter (entrada oculta)", value => {
      if (!/^[!-~]+$/.test(value)) throw new Error("Informe uma chave sem espaços.");
      return value;
    }, { secret: true });
  }
  validateConfig(env);
  const contents = Object.entries(env).map(([key, value]) => key + '="' + value + '"\n').join("");
  // Publish the complete private file only if the destination is still free.
  const temp = path.join(dir, ".env.setup-" + randomUUID());
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temp, dest);
  } finally {
    fs.unlinkSync(temp);
  }
  ui.tell(".env.local criado. Para iniciar o serviço pelo terminal, execute npm start.");
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Instale o Node.js 22 ou superior.");
  const start = process.argv[2] === "--start";
  if (configExists(path.join(root, ".env.local"))) {
    console.log("Usando o .env.local existente. Para alterar a configuração, abra esse arquivo no editor.");
  } else {
    const ui = terminal();
    try {
      await setup(root, ui);
    } finally {
      ui.close();
    }
  }
  if (start) {
    console.log("Mantenha esta janela aberta enquanto usa a extensão. Ctrl+C encerra o serviço.");
    const child = spawnSync(process.execPath, [path.join(root, "server.mjs")], { cwd: root, stdio: "inherit" });
    if (child.error) throw new Error("Falha ao iniciar o serviço Node.");
    process.exitCode = child.status ?? 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error.code === "EEXIST" ? ".env.local já existe. O arquivo existente foi preservado." :
      error.name === "AbortError" ? "Configuração cancelada." : error.message);
    process.exitCode = 1;
  });
}
