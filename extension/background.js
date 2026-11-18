const api = globalThis.browser || globalThis.chrome;
const endpoint = "http://127.0.0.1:43110";
const DEFAULT_SETTINGS = {
  model: "openai/whisper-large-v3",
  language: "pt",
  openRouterConsent: false,
};
const WHATSAPP_ORIGIN = "https://web.whatsapp.com/";
const consentError = "Abra o popup do Transcritor, autorize o envio ao OpenRouter e tente novamente.";

async function request(path, options) {
  let response;
  try {
    response = await fetch(endpoint + path, {
      ...options, cache: "no-store", redirect: "error", credentials: "omit",
    });
  } catch {
    options.signal.throwIfAborted();
    throw new Error("Confira ALLOWED_EXTENSION_ORIGINS em .env.local e execute npm start na pasta do projeto. Depois, teste a conexão no popup.");
  }
  if (path === "/pair" && [404, 405].includes(response.status)) {
    throw new Error("Atualize o serviço local para a versão da extensão e reinicie com npm start.");
  }
  const payload = await response.json().catch(() => null);
  options.signal.throwIfAborted();
  if (!response.ok || typeof payload?.error === "string") {
    if (response.status === 403 && (path === "/pair" || /origem/i.test(payload?.error || ""))) {
      throw new Error("Copie a origem no popup, inclua em ALLOWED_EXTENSION_ORIGINS no .env.local e reinicie o serviço.");
    }
    throw new Error(payload?.error || `Falha no serviço local (${response.status}).`);
  }
  return payload;
}

async function post(operation, body) {
  const signal = AbortSignal.timeout(210_000);
  // Keep the MV3 worker active while the local service processes long recordings.
  const heartbeat = setInterval(() => {
    api.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  try {
    return await request("/" + operation, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.whatsapp-transcriber+json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error("O serviço demorou demais. Tente um áudio menor.");
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function getHealth() {
  const signal = AbortSignal.timeout(5000);
  let health;
  try {
    health = await request("/pair", { method: "POST", signal });
  } catch (error) {
    if (signal.aborted) throw new Error("O serviço local demorou a responder. Reinicie com npm start.");
    throw error;
  }
  if (health?.service !== "dia-whatsapp-transcriber" || health.apiVersion !== 2
    || health.ok !== true || !["local", "openrouter"].includes(health.provider)) {
    throw new Error("Atualize o serviço local para a versão da extensão e reinicie com npm start.");
  }
  return health;
}

async function getSettings() {
  try {
    return await api.storage.local.get(DEFAULT_SETTINGS);
  } catch {
    throw new Error("Falha ao ler as preferências. Recarregue a extensão e abra o popup novamente.");
  }
}

async function handleMessage(message, sender) {
  const operation = message?.type;
  if (!["health", "transcribe", "summarize"].includes(operation)) return;
  if (operation !== "health" && !sender?.url?.startsWith(WHATSAPP_ORIGIN)) {
    return { ok: false, error: "Origem da solicitação não permitida." };
  }

  try {
    // Recheck the service on each dispatch. Older installations ignore allowCloud.
    const health = await getHealth();
    const { model, language, openRouterConsent } = await getSettings();
    const allowCloud = health.provider === "openrouter" && openRouterConsent === true;
    if (operation === "health") {
      return { ok: true, provider: health.provider, model: health.model,
        cloudConsentRequired: health.provider === "openrouter" && !allowCloud };
    }
    if (health.provider === "openrouter" && !allowCloud) throw new Error(consentError);
    if (operation === "summarize" && health.provider !== "openrouter") {
      throw new Error("O resumo precisa do modo OpenRouter e da autorização no popup.");
    }
    const body = operation === "summarize"
      ? { text: message.text, allowCloud }
      : { data: message.data, format: message.format, model, language, allowCloud };
    const payload = await post(operation, body);
    if (typeof payload?.text !== "string" || !payload.text.trim()) {
      throw new Error("O serviço retornou um texto vazio. Tente novamente.");
    }
    return { ok: true, text: payload.text, usage: payload.usage };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});
