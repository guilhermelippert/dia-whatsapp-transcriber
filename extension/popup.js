const api = globalThis.browser || globalThis.chrome;
const statusCard = document.querySelector(".status");
const statusTitle = statusCard.querySelector("strong");
const statusText = statusCard.querySelector("p");
const model = document.querySelector("#model");
const save = document.querySelector("#save");
const cloudSettings = document.querySelector("#cloud-settings");
const consentButton = document.querySelector("#toggle-consent");
const consentState = document.querySelector("#consent-state");
const retry = document.querySelector("#retry");
const feedback = document.querySelector("#feedback");
const originField = document.querySelector("#origin");
let consent;
let cloudMode = false;
let savingConsent = false;

originField.value = api.runtime.getURL("").replace(/\/$/, "");

function renderConsent() {
  consentButton.disabled = savingConsent || consent === undefined || (!consent && !cloudMode);
  consentButton.textContent = consent ? "Revogar autorização" : "Autorizar envio ao OpenRouter";
  consentState.textContent = consent === undefined ? "Autorização indisponível."
    : consent ? "Envio autorizado neste navegador." : "Envio bloqueado neste navegador.";
}

async function checkHealth() {
  retry.disabled = true;
  cloudMode = false;
  renderConsent();
  statusCard.dataset.state = "loading";
  statusTitle.textContent = "Verificando serviço…";
  statusText.textContent = "Consultando o serviço neste computador.";
  cloudSettings.hidden = save.hidden = true;
  try {
    const health = await api.runtime.sendMessage({ type: "health" });
    if (!health?.ok) throw new Error(health?.error || "Recarregue a extensão e reinicie o serviço com npm start.");
    cloudMode = health.provider === "openrouter";
    statusCard.dataset.state = "ok";
    statusTitle.textContent = cloudMode ? "OpenRouter" : "Whisper local";
    statusText.textContent = cloudMode
      ? "O serviço está configurado para processamento online."
      : "O áudio é processado neste computador. Resumos online estão desativados.";
    cloudSettings.hidden = save.hidden = !cloudMode;
  } catch (error) {
    statusCard.dataset.state = "error";
    statusTitle.textContent = "Serviço indisponível";
    statusText.textContent = error.message;
  } finally {
    retry.disabled = false;
    renderConsent();
  }
}

consentButton.addEventListener("click", async () => {
  if (consentButton.disabled) return;
  const next = !consent;
  savingConsent = true;
  renderConsent();
  try {
    await api.storage.local.set({ openRouterConsent: next });
    consent = next;
    feedback.textContent = next ? "Autorizado. Nos áudios já bloqueados, clique em Tentar novamente."
      : "Autorização revogada para novos envios.";
  } catch {
    feedback.textContent = "Falha ao salvar a autorização. Tente novamente.";
  } finally {
    savingConsent = false;
    renderConsent();
  }
});

save.addEventListener("click", async () => {
  try {
    await api.storage.local.set({ model: model.value });
    feedback.textContent = "Modelo salvo.";
  } catch {
    feedback.textContent = "Falha ao salvar o modelo. Tente novamente.";
  }
});
document.querySelector("#copy-origin").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(originField.value);
    feedback.textContent = "Origem copiada.";
  } catch {
    originField.focus();
    originField.select();
    feedback.textContent = "Use o atalho de copiar para copiar a origem selecionada.";
  }
});
retry.addEventListener("click", checkHealth);
api.storage.local.get({ model: model.value, openRouterConsent: false }).then(saved => {
  model.value = saved.model;
  consent = saved.openRouterConsent === true;
  renderConsent();
}).catch(() => {
  feedback.textContent = "Falha ao ler as preferências. Reabra o popup.";
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.openRouterConsent) {
    consent = changes.openRouterConsent.newValue === true;
    renderConsent();
  }
});
checkHealth();
