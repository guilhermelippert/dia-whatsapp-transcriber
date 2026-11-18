const FORMATS = new Set(["ogg", "webm", "mp3", "m4a", "wav", "flac", "aac"]);
const MAX_BASE64_LENGTH = 32 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 200_000;
export const EXTENSION_ORIGIN = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;

export function parseEnvFile(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function isTrustedBrowserOrigin(origin, origins) {
  return typeof origin === "string" && EXTENSION_ORIGIN.test(origin) && origins.has(origin);
}

export function validateTranscriptionInput(input) {
  if (!input || typeof input !== "object") throw new Error("Requisição inválida.");
  if (typeof input.data !== "string" || !input.data) throw new Error("Áudio ausente.");
  if (input.data.length > MAX_BASE64_LENGTH) {
    const error = new Error("O áudio ultrapassa o limite local de 24 MB.");
    error.status = 413;
    throw error;
  }
  if (input.data.length % 4 || /[^A-Za-z0-9+/=]/.test(input.data)
      || input.data.slice(0, -2).includes("=") || /=[^=]$/.test(input.data)) {
    throw new Error("Áudio em base64 inválido.");
  }
  const format = typeof input.format === "string" ? input.format.toLowerCase() : "";
  if (!FORMATS.has(format)) throw new Error("Formato de áudio não suportado.");
  return {
    data: input.data,
    format,
    language: typeof input.language === "string" && /^[a-z]{2}$/.test(input.language) ? input.language : "pt",
    model: typeof input.model === "string" && input.model ? input.model : "openai/whisper-large-v3",
  };
}

export function validateSummaryInput(input) {
  if (!input || typeof input !== "object") throw new Error("Requisição inválida.");
  if (typeof input.text !== "string" || !input.text.trim()) throw new Error("Transcrição ausente.");
  const text = input.text.trim();
  if (text.length > MAX_SUMMARY_LENGTH) {
    const error = new Error("A transcrição é grande demais para resumir.");
    error.status = 413;
    throw error;
  }
  return { text };
}

export function extractChatCompletionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const error = new Error("O provedor não retornou um resumo.");
    error.status = 502;
    throw error;
  }
  return content.trim();
}

export function mapOpenRouterError(status) {
  const messages = {
    401: "A chave do OpenRouter é inválida ou foi revogada.",
    402: "A conta do OpenRouter está sem créditos disponíveis.",
    413: "O conteúdo é grande demais para o provedor.",
    429: "Muitas solicitações em sequência. Aguarde alguns segundos.",
    502: "O provedor está indisponível no momento.",
    503: "O serviço está temporariamente indisponível.",
  };
  return {
    status: status >= 400 && status < 600 ? status : 502,
    message: messages[status] || "O OpenRouter não conseguiu processar a solicitação.",
  };
}
