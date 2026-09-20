import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { derivePriority, jevTriage } from '../src/triage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(path.join(root, 'evals/executive-triage.json'), 'utf8'));
const fixture = process.argv.includes('--fixture');
const threshold = Number(process.env.TRIAGE_LOW_CONFIDENCE_THRESHOLD || 0.6);
const minimumAccuracy = Number(process.env.TRIAGE_MIN_ACCURACY || 0.8);
const maximumProviderFailureRate = Number(process.env.TRIAGE_MAX_PROVIDER_FAILURE_RATE || 0.05);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('TRIAGE_LOW_CONFIDENCE_THRESHOLD deve estar entre 0 e 1.');
if (!Number.isFinite(minimumAccuracy) || minimumAccuracy < 0 || minimumAccuracy > 1) throw new Error('TRIAGE_MIN_ACCURACY deve estar entre 0 e 1.');
if (!Number.isFinite(maximumProviderFailureRate) || maximumProviderFailureRate < 0 || maximumProviderFailureRate > 1) throw new Error('TRIAGE_MAX_PROVIDER_FAILURE_RATE deve estar entre 0 e 1.');

function fixtureResult(item) {
  const { urgency, conflict, needsResponse, category } = item.expected;
  return {
    model: 'fixture',
    urgency: { score: urgency, confidence: 1 },
    conflict: { score: conflict, confidence: 1 },
    needsResponse: { probability: needsResponse ? 1 : 0 },
    category: { choice: category, confidence: 1 },
    priority: derivePriority({ urgency, conflict, needsResponse: needsResponse ? 1 : 0 }),
  };
}

function checkDataset() {
  assert.equal(cases.length, 30, 'O benchmark precisa manter 30 casos.');
  const ids = new Set();
  for (const item of cases) {
    assert.equal(typeof item.id, 'string'); assert(!ids.has(item.id), `ID duplicado: ${item.id}`); ids.add(item.id);
    assert.equal(typeof item.text, 'string'); assert(item.text.trim()); assert(item.text.length <= 32000);
    assert(Number.isInteger(item.expected?.urgency) && item.expected.urgency >= 0 && item.expected.urgency <= 3);
    assert(Number.isInteger(item.expected?.conflict) && item.expected.conflict >= 0 && item.expected.conflict <= 3);
    assert.equal(typeof item.expected?.needsResponse, 'boolean');
    assert(['people', 'customer', 'revenue', 'operation', 'other'].includes(item.expected?.category));
  }
}

const dimensions = ['urgency', 'conflict', 'needsResponse', 'category', 'priority'];
const correct = Object.fromEntries(dimensions.map(key => [key, 0]));
const lowConfidence = Object.fromEntries(dimensions.map(key => [key, 0]));
const failures = [];
const reviewCases = new Set();
checkDataset();

let config;
if (!fixture) {
  config = loadConfig({ DATA_ENCRYPTION_KEY: '00'.repeat(32), NODE_ENV: 'development' });
  if (!config.typesafeKey) throw new Error('Defina TYPESAFE_API_KEY para o modo live ou use --fixture.');
}

for (const item of cases) {
  try {
    const actual = fixture ? fixtureResult(item) : await jevTriage(config, { text: item.text });
    const answers = {
      urgency: Math.round(actual.urgency.score),
      conflict: Math.round(actual.conflict.score),
      needsResponse: actual.needsResponse.probability >= 0.5,
      category: actual.category.choice,
      priority: actual.priority,
    };
    const expectedPriority = derivePriority({ urgency: item.expected.urgency, conflict: item.expected.conflict, needsResponse: item.expected.needsResponse ? 1 : 0 });
    const expected = { ...item.expected, priority: expectedPriority };
    const confidence = {
      urgency: actual.urgency.confidence,
      conflict: actual.conflict.confidence,
      needsResponse: Math.abs(actual.needsResponse.probability - 0.5) * 2,
      category: actual.category.confidence,
      priority: Math.min(actual.urgency.confidence, actual.conflict.confidence, Math.abs(actual.needsResponse.probability - 0.5) * 2),
    };
    for (const key of dimensions) {
      if (answers[key] === expected[key]) correct[key]++;
      if (confidence[key] < threshold) { lowConfidence[key]++; reviewCases.add(item.id); }
    }
  } catch (error) {
    failures.push({ id: item.id, error: error?.code || error?.name || 'ERROR' });
  }
}

const completed = cases.length - failures.length;
const metrics = Object.fromEntries(dimensions.map(key => [key, {
  correct: correct[key],
  total: completed,
  accuracy: completed ? Number((correct[key] / completed).toFixed(4)) : null,
  lowConfidence: lowConfidence[key],
  lowConfidenceRate: completed ? Number((lowConfidence[key] / completed).toFixed(4)) : null,
} ]));
const report = {
  mode: fixture ? 'fixture' : 'live',
  model: fixture ? 'fixture' : config.typesafeModel,
  cases: cases.length,
  completed,
  providerFailures: failures.length,
  abstentions: failures.length + reviewCases.size,
  reviewCases: reviewCases.size,
  lowConfidenceThreshold: threshold,
  qualityGates: { minimumAccuracy, maximumProviderFailureRate },
  metrics,
  failedCaseIds: failures.map(value => value.id),
  note: fixture ? 'Fixture valida somente o runner, não a qualidade do modelo.' : 'Nenhum texto de avaliação ou segredo foi impresso.',
};
console.log(JSON.stringify(report, null, 2));
const providerFailureRate = failures.length / cases.length;
const failedMetrics = dimensions.filter(key => metrics[key].accuracy === null || metrics[key].accuracy < minimumAccuracy);
if (providerFailureRate > maximumProviderFailureRate || failedMetrics.length) process.exitCode = 1;
