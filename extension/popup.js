const api = globalThis.browser || globalThis.chrome;
const statusCard = document.querySelector(".status");
const statusTitle = statusCard.querySelector("strong");
const statusText = statusCard.querySelector("p");
const model = document.querySelector("#model");
const save = document.querySelector("#save");
const cloudSettings = document.querySelector("#cloud-settings");

async function checkHealth() {
  statusCard.dataset.state = "loading";
  statusTitle.textContent = "Verificando serviço…";
  statusText.textContent = "Consultando o serviço neste computador.";
  cloudSettings.hidden = save.hidden = true;
  try {
    const health = await api.runtime.sendMessage({ type: "health" });
    if (!health?.ok) throw new Error(health?.error || "Execute npm start na pasta do projeto.");
    if (!["local", "openrouter"].includes(health.provider)) {
      throw new Error("Reinicie o serviço usando a versão atual do projeto.");
    }
    const local = health.provider === "local";
    statusCard.dataset.state = "ok";
    statusTitle.textContent = local ? "Whisper local" : "OpenRouter";
    statusText.textContent = local
      ? "O áudio é processado neste computador. Resumos online estão desativados."
      : "As notas de voz visíveis são enviadas ao OpenRouter. Resumir envia o texto ao mesmo serviço.";
    cloudSettings.hidden = save.hidden = local;
  } catch (error) {
    statusCard.dataset.state = "error";
    statusTitle.textContent = "Serviço indisponível";
    statusText.textContent = error.message;
  }
}

save.addEventListener("click", async () => {
  await api.storage.local.set({ model: model.value });
  save.textContent = "Salvo";
  setTimeout(() => { save.textContent = "Salvar"; }, 1200);
});
document.querySelector("#retry").addEventListener("click", checkHealth);
api.storage.local.get({ model: "openai/whisper-large-v3" }).then((saved) => {
  model.value = saved.model;
});
checkHealth();
