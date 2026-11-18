import fs from "node:fs";
import path from "node:path";
import { EXTENSION_ORIGIN } from "./server-utils.mjs";

export function serverPort(value) {
  if (value === undefined || value === "") return 43110;
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error("PORT deve ser uma porta TCP válida.");
  return Number(value);
}

export function providerConfig(env) {
  const origins = new Set((env.ALLOWED_EXTENSION_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
  return {
    provider: env.TRANSCRIPTION_PROVIDER ?? "local",
    origins,
    whisper: env.WHISPER_CLI_PATH,
    model: env.WHISPER_MODEL_PATH,
    ffmpeg: env.FFMPEG_PATH,
    apiKey: env.OPENROUTER_API_KEY?.trim(),
    summaryModel: env.SUMMARY_MODEL || "google/gemini-2.5-flash-lite",
  };
}

function availableFile(file, mode) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    fs.accessSync(file, mode);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function configurationError(config) {
  if (!["local", "openrouter"].includes(config.provider)) return "TRANSCRIPTION_PROVIDER deve ser local ou openrouter.";
  if (!config.origins.size || [...config.origins].some(origin => !EXTENSION_ORIGIN.test(origin))) {
    return "Configure ALLOWED_EXTENSION_ORIGINS com as origens exatas das extensões.";
  }
  if (config.provider === "openrouter") return config.apiKey && /^[!-~]+$/.test(config.apiKey) ? null : "Configure OPENROUTER_API_KEY.";
  if (!availableFile(config.whisper, fs.constants.X_OK)) return "WHISPER_CLI_PATH deve apontar para o executável whisper-cli.";
  if (!availableFile(config.ffmpeg, fs.constants.X_OK)) return "FFMPEG_PATH deve apontar para o executável ffmpeg.";
  if (!availableFile(config.model, fs.constants.R_OK)) return "WHISPER_MODEL_PATH deve apontar para um modelo whisper.cpp legível.";
  let fd;
  try {
    fd = fs.openSync(config.model, "r");
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic) !== 4 || !magic.equals(Buffer.from("lmgg"))) {
      return "WHISPER_MODEL_PATH deve apontar para um modelo GGML do whisper.cpp.";
    }
  } catch {
    return "Não foi possível ler WHISPER_MODEL_PATH.";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

export function providerHealth(config) {
  const error = configurationError(config);
  return {
    service: "dia-whatsapp-transcriber",
    apiVersion: 2,
    ok: !error,
    provider: ["openrouter", "local"].includes(config.provider) ? config.provider : null,
    summaryAvailable: !error && config.provider === "openrouter",
    ...(config.provider === "local" && config.model ? { model: path.basename(config.model) } : {}),
    ...(error ? { error } : {}),
  };
}
