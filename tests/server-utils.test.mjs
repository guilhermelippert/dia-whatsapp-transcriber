import test from "node:test";
import assert from "node:assert/strict";
import {
  extractChatCompletionText,
  isTrustedBrowserOrigin,
  mapOpenRouterError,
  parseEnvFile,
  validateSummaryInput,
  validateTranscriptionInput,
} from "../src/server-utils.mjs";

test("parseEnvFile lê valores sem expor lógica de shell", () => {
  assert.deepEqual(parseEnvFile("A=1\n# comentário\nOPENROUTER_API_KEY='teste'\n"), { A: "1", OPENROUTER_API_KEY: "teste" });
});

test("isTrustedBrowserOrigin bloqueia páginas comuns e aceita extensões", () => {
  assert.equal(isTrustedBrowserOrigin(undefined), true);
  assert.equal(isTrustedBrowserOrigin("chrome-extension://abcdefghijklmnop"), true);
  assert.equal(isTrustedBrowserOrigin("moz-extension://1234-abcd"), true);
  assert.equal(isTrustedBrowserOrigin("https://site-malicioso.example"), false);
  assert.equal(isTrustedBrowserOrigin("null"), false);
});

test("validateTranscriptionInput aplica defaults seguros", () => {
  const result = validateTranscriptionInput({ data: "YQ==", format: "OGG" });
  assert.equal(result.format, "ogg");
  assert.equal(result.language, "pt");
  assert.equal(result.model, "openai/whisper-large-v3");
});

test("validateTranscriptionInput rejeita formato desconhecido", () => {
  assert.throws(() => validateTranscriptionInput({ data: "YQ==", format: "exe" }), /não suportado/);
});

test("mapOpenRouterError traduz erros operacionais", () => {
  assert.match(mapOpenRouterError(401).message, /chave/i);
  assert.match(mapOpenRouterError(402).message, /créditos/i);
  assert.match(mapOpenRouterError(429).message, /aguarde/i);
});

test("validateSummaryInput normaliza uma transcrição", () => {
  assert.deepEqual(validateSummaryInput({ text: "  conteúdo falado  " }), { text: "conteúdo falado" });
  assert.throws(() => validateSummaryInput({ text: "  " }), /ausente/i);
});

test("validateSummaryInput limita textos excessivos", () => {
  assert.throws(() => validateSummaryInput({ text: "a".repeat(200_001) }), /grande demais/i);
});

test("extractChatCompletionText lê o resumo do OpenRouter", () => {
  assert.equal(extractChatCompletionText({ choices: [{ message: { content: "  resumo  " } }] }), "resumo");
  assert.throws(() => extractChatCompletionText({ choices: [] }), /não retornou/i);
});
