(() => {
  const MAX_BYTES = 24 * 1024 * 1024;
  const MAX_AGE_MS = 5 * 60_000;
  const ARM_WINDOW_MS = 8_000;
  const RECORDING_TIMEOUT_MS = 5 * 60_000;

  const blobsByUrl = new Map();
  const mediaSourcesByUrl = new Map();
  const sourceBufferInfo = new WeakMap();
  const networkBlobs = [];
  const captureSessions = new Map();
  const playedMedia = [];

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const mediaPrototype = HTMLMediaElement.prototype;
  const originalPlay = mediaPrototype.play;
  const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;

  function now() {
    return Date.now();
  }

  function prune() {
    const cutoff = now() - MAX_AGE_MS;
    while (networkBlobs.length > 8) networkBlobs.shift();
    while (blobsByUrl.size > 16) blobsByUrl.delete(blobsByUrl.keys().next().value);
    while (playedMedia.length > 8) playedMedia.shift();
    while (mediaSourcesByUrl.size > 8) mediaSourcesByUrl.delete(mediaSourcesByUrl.keys().next().value);
    for (const [url, entry] of blobsByUrl) {
      if (entry.createdAt < cutoff) blobsByUrl.delete(url);
    }
    for (const [url, entry] of mediaSourcesByUrl) {
      if (entry.createdAt < cutoff) mediaSourcesByUrl.delete(url);
    }
    while (networkBlobs.length && networkBlobs[0].createdAt < cutoff) networkBlobs.shift();
    while (playedMedia.length && playedMedia[0].playedAt < cutoff) playedMedia.shift();
    for (const [captureId, session] of captureSessions) {
      if (session.armedAt < cutoff) captureSessions.delete(captureId);
    }
  }

  function rememberBlob(blob, { url = "", reason = "unknown", createdAt = now() } = {}) {
    if (!hasArmedCapture() || !(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_BYTES) return;
    const entry = { blob, url, reason, createdAt };
    if (url) blobsByUrl.set(url, entry);
    networkBlobs.push(entry);
    prune();
  }

  function hasArmedCapture() {
    const cutoff = now() - ARM_WINDOW_MS;
    return [...captureSessions.values()].some((session) => session.armedAt >= cutoff);
  }

  function responseLooksRelevant(response) {
    const type = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) return false;
    return hasArmedCapture() && (type.toLowerCase().startsWith("audio/") || type === "application/octet-stream");
  }

  async function rememberResponse(response, url, reason) {
    try {
      if (!responseLooksRelevant(response)) return;
      const blob = await response.blob();
      rememberBlob(blob, { url, reason });
    } catch {
      // Capturing is best-effort and must never alter WhatsApp's own request.
    }
  }

  function mediaSource(media) {
    return media.currentSrc || media.src || "";
  }

  function notePlayedMedia(media) {
    if (!hasArmedCapture()) return;
    const entry = { media, source: mediaSource(media), playedAt: now() };
    playedMedia.push(entry);
    const cutoff = entry.playedAt - ARM_WINDOW_MS;
    for (const session of captureSessions.values()) {
      if (session.armedAt >= cutoff && !session.media) session.media = media;
    }
    prune();
  }

  function dispatchResult(detail) {
    window.postMessage({
      source: "wpp-transcriber",
      direction: "from-page",
      type: "result",
      ...detail,
    }, location.origin);
  }

  function onRequest(type, handler) {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.source !== "wpp-transcriber" || message.direction !== "to-page" || message.type !== type) return;
      handler(message);
    });
  }

  async function blobLooksLikeAudio(blob) {
    if (blob.type.toLowerCase().startsWith("audio/")) return true;
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const ascii = String.fromCharCode(...bytes);
    return ascii.startsWith("OggS")
      || ascii.startsWith("RIFF")
      || ascii.startsWith("ID3")
      || ascii.startsWith("fLaC")
      || (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
      || ascii.slice(4, 8) === "ftyp"
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }

  async function sendBlob(requestId, blob) {
    if (blob.size > MAX_BYTES) {
      dispatchResult({ requestId, error: "AUDIO_TOO_LARGE" });
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    dispatchResult({ requestId, data: btoa(binary), mime: blob.type, size: blob.size });
  }

  async function fetchAudioSource(source) {
    if (!source || !source.startsWith(`blob:${location.origin}/`)) return null;
    const response = await originalFetch(source);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > MAX_BYTES || !(await blobLooksLikeAudio(blob))) return null;
    rememberBlob(blob, { url: source, reason: "direct-media-fetch" });
    return blob;
  }

  function recorderMimeType() {
    const options = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"];
    return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function waitForMediaReady(media) {
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("MEDIA_LOAD_TIMEOUT")), 10_000);
      const finish = (error) => {
        clearTimeout(timeout);
        media.removeEventListener("loadedmetadata", onReady);
        media.removeEventListener("error", onError);
        error ? reject(error) : resolve();
      };
      const onReady = () => finish();
      const onError = () => finish(new Error("MEDIA_LOAD_FAILED"));
      media.addEventListener("loadedmetadata", onReady, { once: true });
      media.addEventListener("error", onError, { once: true });
      media.load();
    });
  }

  async function recordMediaElement(originalMedia) {
    const source = mediaSource(originalMedia);
    let media = originalMedia;
    let restore = null;

    if (source) {
      const clone = document.createElement(originalMedia.tagName.toLowerCase());
      clone.src = source;
      clone.preload = "auto";
      clone.muted = true;
      try {
        await waitForMediaReady(clone);
        media = clone;
      } catch {
        clone.removeAttribute("src");
        clone.load();
      }
    }

    if (media === originalMedia) {
      restore = {
        currentTime: originalMedia.currentTime,
        muted: originalMedia.muted,
        playbackRate: originalMedia.playbackRate,
        paused: originalMedia.paused,
      };
      originalMedia.muted = true;
      originalMedia.playbackRate = 1;
      if (originalMedia.seekable.length) originalMedia.currentTime = 0;
    }

    const captureStream = media.captureStream || media.mozCaptureStream;
    if (typeof captureStream !== "function") throw new Error("MEDIA_CAPTURE_UNAVAILABLE");
    const stream = captureStream.call(media);
    const mimeType = recorderMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];

    try {
      const recorded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MEDIA_RECORDING_TIMEOUT")), RECORDING_TIMEOUT_MS);
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("MEDIA_RECORDING_FAILED"));
        }, { once: true });
        media.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("MEDIA_PLAYBACK_FAILED"));
        }, { once: true });
        recorder.addEventListener("stop", () => {
          clearTimeout(timeout);
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
        }, { once: true });
        media.addEventListener("ended", () => {
          if (recorder.state !== "inactive") recorder.stop();
        }, { once: true });
      });

      recorder.start(1_000);
      media.currentTime = 0;
      await originalPlay.call(media);
      const blob = await recorded;
      if (!blob.size) throw new Error("EMPTY_RECORDING");
      return blob;
    } finally {
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      media.pause();
      if (restore) {
        originalMedia.muted = restore.muted;
        originalMedia.playbackRate = restore.playbackRate;
        if (originalMedia.seekable.length) originalMedia.currentTime = restore.currentTime;
        if (!restore.paused) originalPlay.call(originalMedia).catch(() => {});
      } else {
        media.removeAttribute("src");
        media.load();
      }
    }
  }

  async function resolveAssociatedBlob(session) {
    const media = session.media
      || [...playedMedia].reverse().find((entry) => entry.playedAt >= session.armedAt)?.media;
    if (!media) return null;

    const source = mediaSource(media);
    const directEntry = blobsByUrl.get(source);
    if (directEntry && await blobLooksLikeAudio(directEntry.blob)) return directEntry.blob;

    const mediaSourceEntry = mediaSourcesByUrl.get(source);
    if (mediaSourceEntry) {
      const buffers = [...mediaSourceEntry.mediaSource.sourceBuffers];
      const chunks = buffers.flatMap((buffer) => sourceBufferInfo.get(buffer)?.chunks || []);
      const type = buffers.map((buffer) => sourceBufferInfo.get(buffer)?.type).find(Boolean) || "audio/webm";
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      if (size > 500 && size <= MAX_BYTES) {
        const blob = new Blob(chunks, { type });
        if (await blobLooksLikeAudio(blob)) return blob;
      }
    }

    const exactNetwork = [...networkBlobs].reverse().find((entry) => entry.url === source);
    if (exactNetwork && await blobLooksLikeAudio(exactNetwork.blob)) return exactNetwork.blob;

    try {
      const fetched = await fetchAudioSource(source);
      if (fetched) return fetched;
    } catch {
      // MediaSource-backed blob URLs are not fetchable; record the element below.
    }

    return recordMediaElement(media);
  }

  URL.createObjectURL = function patchedCreateObjectURL(value) {
    const url = originalCreateObjectURL(value);
    if (value instanceof Blob) rememberBlob(value, { url, reason: "createObjectURL" });
    else if (hasArmedCapture() && value instanceof MediaSource) mediaSourcesByUrl.set(url, { mediaSource: value, createdAt: now() });
    return url;
  };

  URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
    const entry = blobsByUrl.get(url);
    if (entry) entry.revokedAt = now();
    return originalRevokeObjectURL(url);
  };

  window.fetch = function patchedFetch(...args) {
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    const promise = originalFetch(...args);
    if (hasArmedCapture()) promise.then((response) => rememberResponse(response.clone(), response.url || requestUrl, "fetch")).catch(() => {});
    return promise;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...args) {
    this.__wppTranscriberUrl = String(url || "");
    return originalXhrOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    if (!this.__wppTranscriberObserved) {
      this.__wppTranscriberObserved = true;
      this.addEventListener("load", () => {
        try {
          const type = this.getResponseHeader("content-type") || "";
          const relevant = hasArmedCapture() && (type.toLowerCase().startsWith("audio/") || type === "application/octet-stream");
          if (!relevant) return;
          let blob = null;
          if (this.response instanceof Blob) blob = this.response;
          else if (this.response instanceof ArrayBuffer) blob = new Blob([this.response], { type });
          if (blob) rememberBlob(blob, { url: this.responseURL || this.__wppTranscriberUrl, reason: "xhr" });
        } catch {
          // Some response types do not allow reading response in page JavaScript.
        }
      });
    }
    return originalXhrSend.apply(this, args);
  };

  mediaPrototype.play = function patchedPlay(...args) {
    notePlayedMedia(this);
    return originalPlay.apply(this, args);
  };

  MediaSource.prototype.addSourceBuffer = function patchedAddSourceBuffer(type) {
    const buffer = originalAddSourceBuffer.call(this, type);
    sourceBufferInfo.set(buffer, { type: String(type || ""), chunks: [], size: 0 });
    return buffer;
  };

  SourceBuffer.prototype.appendBuffer = function patchedAppendBuffer(data) {
    const info = sourceBufferInfo.get(this);
    if (hasArmedCapture() && info && (ArrayBuffer.isView(data) || data instanceof ArrayBuffer)) {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      if (info && info.size + bytes.byteLength <= MAX_BYTES) {
        info.chunks.push(bytes);
        info.size += bytes.byteLength;
      }
    }
    return originalAppendBuffer.call(this, data);
  };

  onRequest("wpp-transcriber:arm", (message) => {
    const { captureId } = message;
    if (typeof captureId !== "string" || captureId.length > 100 || captureSessions.size >= 4) return;
    captureSessions.set(captureId, { captureId, armedAt: now(), media: null });
    prune();
    if (message.requestId) dispatchResult({ requestId: message.requestId });
  });

  onRequest("wpp-transcriber:read", async (message) => {
    const { requestId, url } = message;
    if (!requestId || typeof url !== "string" || !url.startsWith(`blob:${location.origin}/`)) return;
    const entry = blobsByUrl.get(url);
    if (!entry) {
      dispatchResult({ requestId, error: "BLOB_NOT_FOUND" });
      return;
    }
    await sendBlob(requestId, entry.blob);
  });

  onRequest("wpp-transcriber:associated", async (message) => {
    const { requestId, captureId } = message;
    if (!requestId || !captureId) return;
    const session = captureSessions.get(captureId);
    if (!session) {
      dispatchResult({ requestId, error: "CAPTURE_NOT_FOUND" });
      return;
    }
    try {
      const blob = await resolveAssociatedBlob(session);
      if (!blob) dispatchResult({ requestId, error: "AUDIO_NOT_FOUND" });
      else await sendBlob(requestId, blob);
    } catch (error) {
      dispatchResult({ requestId, error: error?.message || "AUDIO_CAPTURE_FAILED" });
    } finally {
      captureSessions.delete(captureId);
    }
  });

  // Keep audio references bounded even when the user stops interacting.
  setInterval(prune, 60_000);
})();
