const api = globalThis.browser || globalThis.chrome;
const DEFAULT_SETTINGS = {
  endpoint: "http://127.0.0.1:43110",
  model: "openai/whisper-large-v3",
  language: "pt",
};
const WHATSAPP_ORIGIN = "https://web.whatsapp.com/";

async function getSettings() {
  const saved = await api.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...saved };
}

async function readResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Falha no serviço local (${response.status}).`);
  return payload;
}

async function handleMessage(message, sender) {
  if (message?.type === "health") {
    try {
      const { endpoint } = await getSettings();
      await readResponse(await fetch(`${endpoint}/health`, { cache: "no-store" }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  if (!["transcribe", "summarize"].includes(message?.type)) return undefined;
  if (!sender?.url?.startsWith(WHATSAPP_ORIGIN)) {
    return { ok: false, error: "Origem da solicitação não permitida." };
  }

  try {
    const { endpoint, model, language } = await getSettings();
    const payload = await readResponse(await fetch(
      `${endpoint}/${message.type === "summarize" ? "summarize" : "transcribe"}`,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.type === "summarize"
        ? { text: message.text }
        : { data: message.data, format: message.format, model, language }),
      },
    ));
    return { ok: true, text: payload.text, usage: payload.usage };
  } catch (error) {
    return {
      ok: false,
      error: error.message.includes("Failed to fetch")
        ? "O serviço local não está rodando. Execute npm start na pasta da extensão."
        : error.message,
    };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});
