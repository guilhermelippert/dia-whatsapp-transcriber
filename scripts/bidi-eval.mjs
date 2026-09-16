const endpoint = process.env.BIDI_URL || "ws://127.0.0.1:9223/session";
const expression = process.argv[2] || "document.title";
const urlNeedle = process.argv[3] || "web.whatsapp.com";

const socket = new WebSocket(endpoint);
let nextId = 0;
const pending = new Map();

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`BiDi timeout: ${method}`));
    }, 30_000);
  });
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (message.type === "error") waiter.reject(new Error(`${message.error}: ${message.message}`));
  else waiter.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await command("session.new", { capabilities: { alwaysMatch: { webSocketUrl: true } } });
  if (process.env.EXTENSION_PATH) {
    await command("webExtension.install", {
      extensionData: { type: "path", path: process.env.EXTENSION_PATH },
    });
  }
  const tree = await command("browsingContext.getTree");
  const contexts = [];
  const visit = (nodes) => nodes.forEach((node) => {
    contexts.push(node);
    visit(node.children || []);
  });
  visit(tree.contexts || []);
  const target = contexts.find((context) => context.url.includes(urlNeedle)) || contexts[0];
  if (!target) throw new Error("Nenhum contexto de navegador encontrado.");
  if (process.env.SCREENSHOT_PATH) {
    const { writeFile } = await import("node:fs/promises");
    const screenshot = await command("browsingContext.captureScreenshot", { context: target.context });
    await writeFile(process.env.SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  }
  if (process.env.CLICK_EXPRESSION) {
    const located = await command("script.evaluate", {
      expression: process.env.CLICK_EXPRESSION,
      target: { context: target.context },
      awaitPromise: true,
      resultOwnership: "root",
    });
    const sharedId = located?.result?.sharedId;
    if (!sharedId) throw new Error("A expressao de clique nao retornou um elemento.");
    await command("input.performActions", {
      context: target.context,
      actions: [{
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: 0, y: 0, duration: 0, origin: { type: "element", element: { sharedId } } },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
  }
  if (process.env.WHEEL_DELTA_Y) {
    await command("input.performActions", {
      context: target.context,
      actions: [{
        type: "wheel",
        id: "wheel",
        actions: [{
          type: "scroll",
          x: Number(process.env.WHEEL_X || 1400),
          y: Number(process.env.WHEEL_Y || 600),
          deltaX: 0,
          deltaY: Number(process.env.WHEEL_DELTA_Y),
          duration: 300,
          origin: "viewport",
        }],
      }],
    });
  }
  const result = await command("script.evaluate", {
    expression,
    target: { context: target.context },
    awaitPromise: true,
    resultOwnership: "none",
    userActivation: true,
  });
  process.stdout.write(`${JSON.stringify({ context: target.context, url: target.url, result }, null, 2)}\n`);
} finally {
  socket.send(JSON.stringify({ id: ++nextId, method: "session.end", params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.close();
}
