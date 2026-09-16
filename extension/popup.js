const api = globalThis.browser || globalThis.chrome;
const statusCard = document.querySelector(".status");
const statusTitle = statusCard.querySelector("strong");
const statusText = statusCard.querySelector("p");
const model = document.querySelector("#model");

async function load() {
  const saved = await api.storage.local.get({ model: "openai/whisper-large-v3" });
  model.value = saved.model;
  await checkHealth();
}

async function checkHealth() {
  statusCard.dataset.state = "loading";
  statusTitle.textContent = "Verificando serviço…";
  statusText.textContent = "O serviço local protege sua chave.";
  const response = await api.runtime.sendMessage({ type: "health" });
  statusCard.dataset.state = response?.ok ? "ok" : "error";
  statusTitle.textContent = response?.ok ? "Pronto para transcrever" : "Serviço local desligado";
  statusText.textContent = response?.ok ? "OpenRouter conectado via localhost." : "Execute npm start na pasta do projeto.";
}

document.querySelector("#save").addEventListener("click", async () => {
  await api.storage.local.set({ model: model.value });
  const button = document.querySelector("#save");
  button.textContent = "Salvo";
  setTimeout(() => { button.textContent = "Salvar"; }, 1_200);
});
document.querySelector("#retry").addEventListener("click", checkHealth);
load();
