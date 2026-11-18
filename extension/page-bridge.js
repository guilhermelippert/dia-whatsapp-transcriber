(() => {
  const MAX_BYTES = 24 * 1024 * 1024;
  const unavailable = "AUDIO_UNAVAILABLE";

  function matchesAudio(model, id) {
    const key = model?.id;
    const serialized = typeof key === "string" ? key : key?._serialized ?? key?.toString();
    return serialized === id && (model.type === "ptt" || model.type === "audio")
      && !model.isViewOnce && !model.mediaData?.isViewOnce && !model.mediaObject?.isViewOnce;
  }

  function cachedBlob(model) {
    const media = model.mediaObject;
    const data = model.mediaData;
    const attached = media?.mediaBlob ?? data?.mediaBlob;
    if (attached instanceof Blob) return attached;
    const blob = attached?.forceToBlob?.();
    if (blob instanceof Blob) return blob;

    const hash = media?.filehash || data?.filehash;
    if (typeof hash !== "string" || !hash) return null;
    try {
      return window.require("WAWebMediaInMemoryBlobCache").InMemoryMediaBlobCache.get(hash);
    } catch {
      return null;
    }
  }

  async function verifiedRowBlob(model, id) {
    const hash = model.filehash || model.mediaData?.filehash || model.mediaObject?.filehash;
    if (typeof hash !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(hash)) return null;

    const owners = document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`);
    if (owners.length !== 1) return null;
    const row = owners[0];
    const players = [...row.querySelectorAll("audio")].filter(el => el.closest("[data-id]") === row);
    if (players.length !== 1 || players[0].srcObject) return null;
    const player = players[0];
    const url = player.currentSrc || player.src;
    const localBlob = url.startsWith("blob:") && new URL(url).origin === location.origin;
    const audioData = /^data:audio\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i.test(url);
    if (!localBlob && !audioData) return null;
    if (audioData && url.length > 4 * Math.ceil(MAX_BYTES / 3) + 256) throw new Error("TOO_LARGE");

    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) return null;
    if (Number(response.headers.get("Content-Length")) > MAX_BYTES) throw new Error("TOO_LARGE");
    const blob = await response.blob();
    if (blob.size > MAX_BYTES) throw new Error("TOO_LARGE");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    if (btoa(String.fromCharCode(...digest)) !== hash || !matchesAudio(model, id)
      || !row.isConnected || row.dataset.id !== id || player.closest("[data-id]") !== row
      || (player.currentSrc || player.src) !== url) return null;
    return blob;
  }

  async function readMessage(id) {
    const messages = window.require("WAWebCollections").Msg;
    let model = messages.get(id);
    if (!model && messages.getMessagesById) {
      const result = await messages.getMessagesById([id]);
      model = result?.messages?.find((candidate) => matchesAudio(candidate, id));
    }
    if (!matchesAudio(model, id)) throw new Error(unavailable);
    if (model.size > MAX_BYTES) throw new Error("TOO_LARGE");

    let blob = cachedBlob(model);
    if (!blob && typeof model.downloadMedia === "function") {
      const downloaded = await model.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      if (!matchesAudio(model, id)) throw new Error(unavailable);
      blob = downloaded instanceof Blob ? downloaded : cachedBlob(model);
    }
    if (!blob) blob = await verifiedRowBlob(model, id);
    if (!(blob instanceof Blob) || !blob.size) throw new Error(unavailable);
    if (blob.size > MAX_BYTES) throw new Error("TOO_LARGE");
    const mime = (!blob.type || blob.type === "application/octet-stream")
      ? model.mimetype || model.mediaData?.mimetype : blob.type;
    if (!mime?.startsWith("audio/")) throw new Error(unavailable);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return { data: btoa(chunks.join("")), size: blob.size, mime };
  }

  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin
      || request?.source !== "wpp-transcriber" || request.direction !== "to-page"
      || request.type !== "wpp-transcriber:message" || typeof request.requestId !== "string"
      || typeof request.messageId !== "string" || !request.messageId) return;
    const { requestId, messageId } = request;
    let result;
    try {
      result = await readMessage(messageId);
    } catch (error) {
      result = { error: error?.message === "TOO_LARGE" ? "TOO_LARGE" : unavailable };
    }
    window.postMessage({
      source: "wpp-transcriber", direction: "from-page", type: "result", requestId, messageId, ...result,
    }, location.origin);
  });
})();
