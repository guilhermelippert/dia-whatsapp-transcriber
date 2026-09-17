(() => {
  const api = globalThis.browser || globalThis.chrome;
  const MAX_BYTES = 24 * 1024 * 1024;
  const MAX_CACHED_TRANSCRIPTS = 500;
  const mounted = new WeakSet();
  const queued = new WeakSet();
  const autoAttempted = new Set();
  const transcriptCache = new Map();
  const summaryCache = new Map();
  let preferences = { consent: false, automatic: false, loggedIn: false };
  let cacheReady = false;
  let persistenceQueue = Promise.resolve();
  let transcriptionQueue = Promise.resolve();
  let scanTimer;
  let generation = 0;
  const VOICE_MESSAGE_LABEL = /^(play|pause|reproduzir|pausar)\s+(voice message|mensagem de voz|áudio|audio)\b/i;
  const PLAY_VOICE_MESSAGE_LABEL = /^(play|reproduzir)\s+(voice message|mensagem de voz|áudio|audio)\b/i;
  const PAUSE_VOICE_MESSAGE_LABEL = /^(pause|pausar)\s+(voice message|mensagem de voz|áudio|audio)\b/i;

  function formatFromMime(mime = "", source = "") {
    const value = `${mime} ${source}`.toLowerCase();
    if (value.includes("ogg") || value.includes("opus")) return "ogg";
    if (value.includes("webm")) return "webm";
    if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
    if (value.includes("mp4") || value.includes("m4a")) return "m4a";
    if (value.includes("wav")) return "wav";
    if (value.includes("flac")) return "flac";
    if (value.includes("aac")) return "aac";
    return "ogg";
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
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

  async function requestPageBlob(eventName, detail = {}, timeoutMs = 8_000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onResult);
        reject(new Error("Não foi possível acessar este áudio. Recarregue a conversa."));
      }, timeoutMs);
      function onResult(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (message?.source !== "wpp-transcriber" || message.direction !== "from-page" || message.type !== "result") return;
        if (message.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onResult);
        if (message.error) reject(new Error("Não foi possível acessar este áudio. Recarregue a conversa."));
        else resolve(message);
      }
      window.addEventListener("message", onResult);
      window.postMessage({
        source: "wpp-transcriber",
        direction: "to-page",
        type: eventName,
        requestId,
        ...detail,
      }, location.origin);
    });
  }

  function readThroughPage(url) {
    return requestPageBlob("wpp-transcriber:read", { url });
  }

  function armPageCapture(captureId) {
    return requestPageBlob("wpp-transcriber:arm", { captureId }, 2000);
  }

  function readAssociatedThroughPage(captureId) {
    return requestPageBlob("wpp-transcriber:associated", { captureId }, 5 * 60_000 + 15_000);
  }

  async function readAudio(audio) {
    const source = audio.currentSrc || audio.src;
    if (!source) throw new Error("Reproduza o áudio uma vez e tente novamente.");
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error("FETCH_FAILED");
      const blob = await response.blob();
      if (blob.size > MAX_BYTES) throw new Error("Este áudio ultrapassa o limite de 24 MB.");
      return {
        data: bytesToBase64(await blob.arrayBuffer()),
        format: formatFromMime(blob.type, source),
      };
    } catch (error) {
      if (error.message.includes("24 MB")) throw error;
      const bridged = await readThroughPage(source);
      if (bridged.size > MAX_BYTES) throw new Error("Este áudio ultrapassa o limite de 24 MB.");
      return { data: bridged.data, format: formatFromMime(bridged.mime, source) };
    }
  }

  async function readVoiceButton(playButton) {
    const captureId = crypto.randomUUID();
    await armPageCapture(captureId);
    const wasPlay = PLAY_VOICE_MESSAGE_LABEL.test(playButton.getAttribute("aria-label") || "");
    if (wasPlay) {
      playButton.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const rowButtons = findMessage(playButton)?.querySelectorAll("button[aria-label]") || [];
      const pauseButton = [...rowButtons].find((button) => PAUSE_VOICE_MESSAGE_LABEL.test(button.getAttribute("aria-label") || ""))
        ;
      pauseButton?.click();
    }
    const bridged = await readAssociatedThroughPage(captureId);
    if (bridged.size > MAX_BYTES) throw new Error("Este áudio ultrapassa o limite de 24 MB.");
    return { data: bridged.data, format: formatFromMime(bridged.mime, "") };
  }

  function findMessage(target) {
    return target.closest('[data-id], [role="row"]') || target.parentElement?.parentElement || target.parentElement;
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

  function currentConversation() {
    return document.querySelector("#main header [title], main header [title]")?.getAttribute("title") || document.title;
  }

  function messageKey(target, message) {
    const dataId = message?.getAttribute("data-id") || target.closest("[data-id]")?.getAttribute("data-id");
    if (dataId) return { key: `id:${dataId}`, stable: true };
    const source = target instanceof HTMLAudioElement ? target.currentSrc || target.src : "";
    if (source) return { key: `src:${source}`, stable: true };
    const chat = currentConversation();
    const signature = (message?.textContent || target.getAttribute("aria-label") || "audio")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return { key: `fallback:${chat}:${signature}`, stable: false };
  }

  function rememberBounded(collection, key, value) {
    collection.delete(key);
    collection.set(key, value);
    if (collection.size > MAX_CACHED_TRANSCRIPTS) collection.delete(collection.keys().next().value);
  }

  async function restorePersistedCache() {
    try {
      const settings = await api.runtime.sendMessage({ type: "settings" });
      if (settings?.ok) preferences = settings;
      if (preferences.consent && preferences.loggedIn) {
        const result = await api.runtime.sendMessage({ type: "cache:get" });
        for (const [key, value] of Object.entries(result?.cache || {})) {
          if (typeof value.transcript === "string") rememberBounded(transcriptCache, key, value.transcript);
          if (typeof value.summary === "string" && value.summary) rememberBounded(summaryCache, key, value.summary);
        }
      }
    } finally { cacheReady = true; scan(); }
  }

  function persistCache(key, transcript, summary, context) {
    persistenceQueue = persistenceQueue.catch(() => {}).then(() => api.runtime.sendMessage({
      type: "cache:put", key, transcript, summary, context,
    })).catch(() => {});
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
    if (mounted.has(target)) return;
    const message = findMessage(target);
    if (!message || message.querySelector(":scope .wpp-transcriber")) return;
    mounted.add(target);
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
    const identity = messageKey(target, message);
    const { key } = identity;
    const conversation = currentConversation();
    let transcriptText = transcriptCache.get(key) || "";
    let summaryText = summaryCache.get(key) || "";
    let lastAudioPayload = null;
    let context;

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
      const started = generation;
      if (automatic && (!target.isConnected || currentConversation() !== conversation)) return;
      button.disabled = true;
      summaryButton.disabled = true;
      delete panel.dataset.hasTranscript;
      button.querySelector("span").textContent = "Transcrevendo…";
      setState(panel, "loading", "Preparando o áudio com segurança…");
      try {
        const access = await api.runtime.sendMessage({ type: "access" });
        if (!access?.ok) throw new Error(access?.error || "Abra a extensão e autorize o processamento.");
        if (started !== generation) return;
        context = access.context;
        const payload = lastAudioPayload
          || (target instanceof HTMLAudioElement ? await readAudio(target) : await readVoiceButton(target));
        lastAudioPayload = payload;
        setState(panel, "loading", "Enviando para transcrição…");
        const result = await api.runtime.sendMessage({ type: "transcribe", ...payload, context });
        if (!result?.ok) throw new Error(result?.error || "Não foi possível transcrever.");
        if (started !== generation) return;
        transcriptText = result.text;
        summaryText = "";
        summaryCache.delete(key);
        rememberBounded(transcriptCache, key, transcriptText);
        persistCache(key, transcriptText, summaryText, context);
        if (automatic && (!target.isConnected || currentConversation() !== conversation)) return;
        setState(panel, "success", transcriptText);
        panel.dataset.view = "transcript";
        panel.dataset.hasTranscript = "true";
        summaryButton.querySelector("span").textContent = "Resumir";
        summaryButton.setAttribute("aria-label", "Resumir transcrição");
        button.querySelector("span").textContent = "Refazer";
      } catch (error) {
        setState(panel, "error", error.message || "Não foi possível transcrever.");
        button.querySelector("span").textContent = "Tentar novamente";
      } finally {
        button.disabled = false;
        summaryButton.disabled = false;
      }
    }

    async function summarize() {
      if (!transcriptText || summaryButton.disabled) return;
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
        const started = generation;
        const access = await api.runtime.sendMessage({ type: "access" });
        if (!access?.ok) throw new Error(access?.error || "Acesso indisponível.");
        context = access.context;
        const result = await api.runtime.sendMessage({ type: "summarize", text: transcriptText, context });
        if (started !== generation) return;
        if (!result?.ok) throw new Error(result?.error || "Não foi possível resumir.");
        summaryText = result.text;
        rememberBounded(summaryCache, key, summaryText);
        persistCache(key, transcriptText, summaryText, context);
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
      enqueue(target, () => transcribe({ automatic: false }));
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

    if (transcriptText) {
      setState(panel, "success", transcriptText);
      panel.dataset.hasTranscript = "true";
      button.querySelector("span").textContent = "Refazer";
      summaryButton.querySelector("span").textContent = summaryText ? "Ver resumo" : "Resumir";
      summaryButton.setAttribute("aria-label", summaryText ? "Mostrar resumo" : "Resumir transcrição");
      return;
    }
    if (preferences.consent && preferences.loggedIn && preferences.automatic && identity.stable && !autoAttempted.has(key)) {
      autoAttempted.add(key);
      if (autoAttempted.size > MAX_CACHED_TRANSCRIPTS) autoAttempted.delete(autoAttempted.values().next().value);
      enqueue(target, () => transcribe({ automatic: true }));
    }
  }

  function scan() {
    if (!cacheReady) return;
    document.querySelectorAll("audio").forEach(mount);
    document.querySelectorAll("button[aria-label]").forEach((button) => {
      if (VOICE_MESSAGE_LABEL.test(button.getAttribute("aria-label") || "")) mount(button);
    });
  }

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.documentElement.dataset.wppTranscriberLoaded = "true";
  api.runtime.onMessage?.addListener((message) => {
    if (message?.type === "dia:clear") {
      preferences = { consent: false, automatic: false, loggedIn: false };
      generation++;
      transcriptCache.clear(); summaryCache.clear(); autoAttempted.clear();
      document.querySelectorAll(".wpp-transcriber").forEach(panel => panel.remove());
      // Existing closures may contain old text. A reload discards them; do not remount stale targets.
    }
  });
  restorePersistedCache().catch(() => { cacheReady = true; scan(); });
})();
