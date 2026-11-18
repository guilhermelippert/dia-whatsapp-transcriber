import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const DEMUXERS = { ogg: "ogg", webm: "matroska", mp3: "mp3", m4a: "mov", wav: "wav", flac: "flac", aac: "aac" };
const MAX_SECONDS = 900;
const PCM_BYTES_PER_SECOND = 16_000 * 2;

export async function transcribeLocal(config, input, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), "wpp-whisper-"));
  const source = path.join(dir, "input");
  const wav = path.join(dir, "audio.wav");
  const options = { cwd: dir, signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 };
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
    if ((await stat(wav)).size > MAX_SECONDS * PCM_BYTES_PER_SECOND + 4096) {
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
