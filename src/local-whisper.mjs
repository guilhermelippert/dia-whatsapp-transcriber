import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const DEMUXERS = { ogg: "ogg", webm: "matroska", mp3: "mp3", m4a: "mov", wav: "wav", flac: "flac", aac: "aac" };
const MAX_SECONDS = 900;
const PCM_BYTES_PER_SECOND = 16_000 * 2;

async function execute(file, args, options) {
  const result = runFile(file, args, options);
  // execFile can reject on abort before the operating system reaps the child.
  const closed = new Promise(resolve => result.child.once("close", resolve));
  try {
    return await result;
  } finally {
    await closed;
  }
}

async function pcmDataSize(wav) {
  const file = await open(wav, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(8);
    // FFmpeg writes a seekable RIFF/WAVE. Metadata and chunk padding are not audio.
    for (let offset = 12; offset + 8 <= size;) {
      if ((await file.read(header, 0, 8, offset)).bytesRead !== 8) break;
      const length = header.readUInt32LE(4);
      offset += 8;
      if (length > size - offset) break;
      if (header.toString("latin1", 0, 4) === "data") return length;
      offset += length + length % 2;
    }
    throw new Error("O conversor não produziu um arquivo WAV válido.");
  } finally {
    await file.close();
  }
}

export async function transcribeLocal(config, input, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-whisper-"));
  const source = path.join(dir, "input");
  const wav = path.join(dir, "audio.wav");
  const options = {
    cwd: dir, signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
      TMPDIR: dir, TEMP: dir, TMP: dir, LANG: "C",
    },
  };
  try {
    await writeFile(source, Buffer.from(input.data, "base64"), { mode: 0o600, signal });
    try {
      await execute(config.ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864",
        "-protocol_whitelist", "file", "-threads", "1", "-f", DEMUXERS[input.format], "-i", source,
        "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn", "-t", String(MAX_SECONDS + 1),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
      ], options);
    } catch (error) {
      signal.throwIfAborted();
      if (typeof error.code !== "number") throw error;
      throw Object.assign(new Error("Não foi possível decodificar o áudio."), { status: 422 });
    }
    // The bounded extra second distinguishes oversized clips from complete recordings.
    const bytes = await pcmDataSize(wav);
    if (!bytes) throw Object.assign(new Error("A gravação não contém áudio."), { status: 422 });
    if (bytes > MAX_SECONDS * PCM_BYTES_PER_SECOND) {
      throw Object.assign(new Error("A gravação ultrapassa o limite local de 15 minutos."), { status: 413 });
    }
    const { stdout } = await execute(config.whisper, [
      "-m", config.model, "-l", input.language, "-f", wav, "-nt", "-np",
    ], options);
    const text = stdout.trim();
    if (!text) throw Object.assign(new Error("O Whisper não retornou texto."), { status: 422 });
    return { text, usage: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
