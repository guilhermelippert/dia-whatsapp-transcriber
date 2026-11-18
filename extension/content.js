(() => {
  const api = globalThis.browser || globalThis.chrome;
  const MAX_BYTES = 24 * 1024 * 1024;
  const MAX_CACHED_TRANSCRIPTS = 500;
  const TRANSCRIPT_STORAGE_KEY = "wppTranscriber.transcripts.v2";
  const SUMMARY_STORAGE_KEY = "wppTranscriber.summaries.v2";
  const mounted = new Map();
  const queued = new WeakSet();
  const transcriptCache = new Map();
  const summaryCache = new Map();
  const storage = api?.storage?.local;
  let cacheReady = !storage?.get;
  let persistenceQueue = Promise.resolve();
  let transcriptionQueue = Promise.resolve();
  let scanTimer;
  let provider;
  let healthRequest;
  const VOICE_MESSAGE_LABEL = /^(play|pause|download|reproduzir|pausar|baixar)\s+(voice message|voice note|mensagem de voz|áudio|audio)\b/iu;
  const AUDIO_SELECTOR = 'audio, [data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="audio-download"]';

  function refreshProvider() {
    if (healthRequest) return healthRequest;
    healthRequest = (async () => {
      try {
        const health = await api.runtime.sendMessage({ type: "health" });
        provider = health?.ok ? health.provider : undefined;
      } catch {
        provider = undefined;
      }
      for (const binding of mounted.values()) binding.updateSummaryAction();
    })().finally(() => { healthRequest = undefined; });
    return healthRequest;
  }

  function formatFromMime(mime) {
    const value = mime.split(";", 1)[0].toLowerCase();
    if (value === "audio/webm") return "webm";
    if (value.includes("ogg") || value.includes("opus")) return "ogg";
    if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
    if (value.includes("mp4") || value.includes("m4a")) return "m4a";
    if (value.includes("wav")) return "wav";
    if (value.includes("flac")) return "flac";
    if (value.includes("aac")) return "aac";
    throw new Error("Formato de áudio não suportado.");
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Some browser contexts deny the async clipboard API; use the local fallback.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Não foi possível copiar o texto.");
  }

  function readMessage(messageId) {
    const requestId = crypto.randomUUID();
    const unavailable = "Este áudio não está disponível para transcrição silenciosa.";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onResult);
        reject(new Error(unavailable));
      }, 30_000);
      function onResult(event) {
        const reply = event.data;
        if (event.source !== window || event.origin !== location.origin
          || reply?.source !== "wpp-transcriber" || reply.direction !== "from-page"
          || reply.type !== "result" || reply.requestId !== requestId || reply.messageId !== messageId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onResult);
        try {
          if (reply.error === "TOO_LARGE") throw new Error("Este áudio ultrapassa o limite de 24 MB.");
          if (reply.error || !Number.isSafeInteger(reply.size) || reply.size <= 0 || reply.size > MAX_BYTES
            || typeof reply.data !== "string" || reply.data.length !== 4 * Math.ceil(reply.size / 3)
            || !reply.mime?.startsWith("audio/")) throw new Error(unavailable);
          resolve({ data: reply.data, format: formatFromMime(reply.mime) });
        } catch (error) {
          reject(error);
        }
      }
      window.addEventListener("message", onResult);
      window.postMessage({
        source: "wpp-transcriber", direction: "to-page", type: "wpp-transcriber:message", requestId, messageId,
      }, location.origin);
    });
  }

  function findPanelLayout(target, message) {
    let previous = target;
    let node = target.parentElement;
    while (node && node !== message && message?.contains(node)) {
      const style = getComputedStyle(node);
      const alignedColumn = style.display === "flex"
        && style.flexDirection === "column"
        && (style.alignItems === "flex-start" || style.alignItems === "flex-end");
      if (alignedColumn && node.getBoundingClientRect().width > previous.getBoundingClientRect().width + 80) {
        return {
          host: node,
          width: previous.getBoundingClientRect().width,
          direction: style.alignItems === "flex-end" ? "outgoing" : "incoming",
        };
      }
      previous = node;
      node = node.parentElement;
    }
    return {
      host: message,
      width: Math.min(message?.getBoundingClientRect().width || 320, 360),
      direction: "incoming",
    };
  }

  function setState(panel, state, text) {
    panel.dataset.state = state;
    panel.querySelector(".wpp-transcriber__text").textContent = text;
    const announcement = panel.querySelector(".wpp-transcriber__announcement");
    if (announcement) {
      announcement.textContent = state === "success"
        ? "Transcrição concluída."
        : state === "error" ? "Falha ao transcrever o áudio." : "Transcrevendo áudio.";
    }
  }

  function rememberBounded(collection, key, value) {
    collection.delete(key);
    collection.set(key, value);
    if (collection.size > MAX_CACHED_TRANSCRIPTS) collection.delete(collection.keys().next().value);
  }

  async function restorePersistedCache() {
    if (!storage?.get) {
      cacheReady = true;
      scan();
      return;
    }
    try {
      const saved = await storage.get({
        [TRANSCRIPT_STORAGE_KEY]: {},
        [SUMMARY_STORAGE_KEY]: {},
      });
      for (const [key, value] of Object.entries(saved[TRANSCRIPT_STORAGE_KEY] || {})) {
        if (typeof value === "string" && value.trim()) rememberBounded(transcriptCache, key, value);
      }
      for (const [key, value] of Object.entries(saved[SUMMARY_STORAGE_KEY] || {})) {
        if (typeof value === "string" && value.trim()) rememberBounded(summaryCache, key, value);
      }
    } catch {
      // A storage failure must not block the transcriber from working in memory.
    } finally {
      cacheReady = true;
      scan();
    }
  }

  function persistCache() {
    if (!storage?.set) return;
    const transcripts = Object.fromEntries(transcriptCache);
    const summaries = Object.fromEntries(summaryCache);
    persistenceQueue = persistenceQueue
      .catch(() => {})
      .then(() => storage.set({
        [TRANSCRIPT_STORAGE_KEY]: transcripts,
        [SUMMARY_STORAGE_KEY]: summaries,
      }))
      .catch(() => {});
  }

  function enqueue(target, task) {
    if (queued.has(target)) return;
    queued.add(target);
    transcriptionQueue = transcriptionQueue
      .then(task, task)
      .catch(() => {})
      .finally(() => queued.delete(target));
  }

  function mount(target) {
    const message = target.closest("[data-id]");
    const messageId = message?.dataset.id;
    if (!messageId || mounted.has(message)) return;
    const layout = findPanelLayout(target, message);

    const panel = document.createElement("div");
    panel.className = "wpp-transcriber";
    panel.dataset.state = "idle";
    panel.dataset.direction = layout.direction;
    panel.dataset.view = "transcript";
    panel.style.setProperty("--wpp-transcriber-width", `${Math.max(220, Math.round(layout.width))}px`);
    panel.innerHTML = `
      <span class="wpp-transcriber__announcement" aria-live="polite"></span>
      <div class="wpp-transcriber__result" role="region" aria-label="Transcrição do áudio">
        <div class="wpp-transcriber__actions">
          <span class="wpp-transcriber__primary"></span>
          <button class="wpp-transcriber__copy" type="button" aria-label="Copiar transcrição">Copiar</button>
        </div>
        <span class="wpp-transcriber__text" tabindex="0"></span>
      </div>`;

    const button = document.createElement("button");
    button.className = "wpp-transcriber__button";
    button.type = "button";
    button.setAttribute("aria-label", "Transcrever este áudio");
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V22H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.06A8 8 0 0 0 20 12a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z"/></svg><span>Transcrever</span>`;
    panel.querySelector(".wpp-transcriber__primary").appendChild(button);
    const summaryButton = document.createElement("button");
    summaryButton.className = "wpp-transcriber__button wpp-transcriber__summary";
    summaryButton.type = "button";
    summaryButton.setAttribute("aria-label", "Resumir transcrição");
    summaryButton.innerHTML = "<span>Resumir</span>";
    panel.querySelector(".wpp-transcriber__primary").appendChild(summaryButton);
    const copy = panel.querySelector(".wpp-transcriber__copy");
    const key = `id:${messageId}`;
    const isCurrent = () => message.isConnected && message.dataset.id === messageId
      && target.closest("[data-id]") === message && panel.closest("[data-id]") === message;
    let transcriptText = "";
    let summaryText = "";

    function updateSummaryAction() {
      summaryButton.style.display = summaryText || provider === "openrouter" ? "" : "none";
    }
    mounted.set(message, { panel, isCurrent, updateSummaryAction });
    updateSummaryAction();

    function showTranscript() {
      updateSummaryAction();
      setState(panel, "success", transcriptText);
      panel.dataset.view = "transcript";
      panel.dataset.hasTranscript = "true";
      button.querySelector("span").textContent = "Refazer";
      summaryButton.querySelector("span").textContent = summaryText ? "Ver resumo" : "Resumir";
      summaryButton.setAttribute("aria-label", summaryText ? "Mostrar resumo" : "Resumir transcrição");
    }

    function showText(text, view) {
      panel.querySelector(".wpp-transcriber__text").textContent = text;
      panel.dataset.view = view;
      summaryButton.querySelector("span").textContent = view === "summary" ? "Ver transcrição" : "Ver resumo";
      summaryButton.setAttribute("aria-label", view === "summary"
        ? "Mostrar transcrição completa"
        : "Mostrar resumo");
    }

    async function transcribe({ automatic = false } = {}) {
      if (panel.dataset.state === "loading") return;
      if (!isCurrent()) return;
      if (automatic && transcriptCache.has(key)) {
        transcriptText = transcriptCache.get(key);
        summaryText = summaryCache.get(key) || "";
        showTranscript();
        return;
      }
      button.disabled = true;
      summaryButton.disabled = true;
      delete panel.dataset.hasTranscript;
      button.querySelector("span").textContent = "Transcrevendo…";
      setState(panel, "loading", "Preparando o áudio com segurança…");
      try {
        const payload = await readMessage(messageId);
        if (!isCurrent()) return;
        setState(panel, "loading", "Enviando para transcrição…");
        const result = await api.runtime.sendMessage({ type: "transcribe", ...payload });
        if (!result?.ok) throw new Error(result?.error || "Não foi possível transcrever.");
        transcriptText = result.text;
        summaryText = "";
        summaryCache.delete(key);
        rememberBounded(transcriptCache, key, transcriptText);
        persistCache();
        if (isCurrent()) showTranscript();
        if (!provider) void refreshProvider();
      } catch (error) {
        if (!isCurrent()) return;
        setState(panel, "error", error.message || "Não foi possível transcrever.");
        button.querySelector("span").textContent = "Tentar novamente";
      } finally {
        button.disabled = false;
        summaryButton.disabled = false;
      }
    }

    async function summarize() {
      if (!isCurrent() || !transcriptText || summaryButton.disabled) return;
      if (summaryText) {
        showText(panel.dataset.view === "summary" ? transcriptText : summaryText,
          panel.dataset.view === "summary" ? "transcript" : "summary");
        return;
      }
      button.disabled = true;
      summaryButton.disabled = true;
      summaryButton.removeAttribute("title");
      summaryButton.querySelector("span").textContent = "Resumindo…";
      summaryButton.setAttribute("aria-label", "Resumindo transcrição");
      panel.querySelector(".wpp-transcriber__announcement").textContent = "Resumindo transcrição.";
      try {
        await refreshProvider();
        if (provider !== "openrouter" || !isCurrent()) {
          summaryButton.querySelector("span").textContent = "Resumir";
          summaryButton.setAttribute("aria-label", "Resumir transcrição");
          panel.querySelector(".wpp-transcriber__announcement").textContent = "Resumo online indisponível.";
          return;
        }
        const result = await api.runtime.sendMessage({ type: "summarize", text: transcriptText });
        if (!result?.ok) throw new Error(result?.error || "Não foi possível resumir.");
        summaryText = result.text;
        rememberBounded(summaryCache, key, summaryText);
        persistCache();
        if (!isCurrent()) return;
        showText(summaryText, "summary");
        panel.querySelector(".wpp-transcriber__announcement").textContent = "Resumo concluído.";
      } catch (error) {
        summaryButton.querySelector("span").textContent = "Tentar resumo";
        summaryButton.setAttribute("aria-label", "Tentar resumir transcrição");
        summaryButton.title = error.message || "Não foi possível resumir.";
        panel.querySelector(".wpp-transcriber__announcement").textContent = "Falha ao resumir a transcrição.";
      } finally {
        button.disabled = false;
        summaryButton.disabled = false;
      }
    }

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      enqueue(panel, () => transcribe({ automatic: false }));
    });
    summaryButton.addEventListener("click", (event) => {
      event.stopPropagation();
      summarize();
    });
    copy.addEventListener("click", async (event) => {
      event.stopPropagation();
      const text = panel.querySelector(".wpp-transcriber__text").textContent;
      try {
        await copyText(text);
        copy.textContent = "Copiado";
      } catch {
        copy.textContent = "Falha ao copiar";
      }
      setTimeout(() => { copy.textContent = "Copiar"; }, 1_500);
    });
    layout.host.appendChild(panel);

    enqueue(panel, () => transcribe({ automatic: true }));
  }

  function scan() {
    scanTimer = undefined;
    if (!cacheReady) return;
    for (const [message, binding] of mounted) {
      if (binding.isCurrent()) continue;
      binding.panel.remove();
      mounted.delete(message);
    }
    document.querySelectorAll(AUDIO_SELECTOR).forEach(mount);
    document.querySelectorAll('button[aria-label], [role="button"][aria-label]').forEach((button) => {
      if (VOICE_MESSAGE_LABEL.test(button.getAttribute("aria-label"))) mount(button);
    });
  }

  const observer = new MutationObserver(() => {
    if (scanTimer === undefined) scanTimer = setTimeout(scan, 80);
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["data-id", "aria-label", "data-icon", "role"],
  });
  document.documentElement.dataset.wppTranscriberLoaded = "true";
  window.addEventListener("focus", refreshProvider);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshProvider();
  });
  void refreshProvider();
  restorePersistedCache();
})();
