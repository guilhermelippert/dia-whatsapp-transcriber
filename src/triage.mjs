import { HttpError } from './security.mjs';

export const URGENCY_LEVELS = [
  'Informação concluída ou apenas para registro, sem ação nem prazo pendente.',
  'Acompanhamento de rotina, decisão futura ou prazo flexível de dois dias ou mais, sem bloqueio imediato.',
  'Ação importante até hoje ou amanhã, bloqueio relevante e limitado, ou risco concreto que ainda permite resposta planejada.',
  'Ação em minutos ou imediatamente por emergência, crise ativa, ameaça grave, segurança física ou operação crítica amplamente bloqueada.',
];
export const CONFLICT_LEVELS = [
  'Sem atrito entre pessoas ou organizações. Problemas técnicos, urgência, cancelamento, risco e pressão de prazo isoladamente não são conflito.',
  'Discordância ou frustração leve e explícita, ainda construtiva e sem cobrança repetida.',
  'Atrito ativo, cobrança repetida ou forte dirigida a alguém, discussão intensa ou risco claro de escalada interpessoal.',
  'Hostilidade explícita, insulto, ameaça, ultimato punitivo ou escalada grave contra pessoa ou organização.',
];
export const CATEGORIES = {
  people: 'Pessoas, liderança, equipe, contratação, RH ou relacionamento interno são o assunto central.',
  customer: 'Cliente, suporte, entrega, satisfação, cancelamento ou relacionamento externo são o assunto central.',
  revenue: 'Receita, venda, proposta, preço, contrato, desconto, cobrança, pagamento ou faturamento são o assunto central.',
  operation: 'Projeto, processo de negócio, fornecedor, sistema ou execução operacional são o assunto central.',
  other: 'Agenda pessoal, viagem, refeição, segurança física ou qualquer assunto cujo tema central não caiba nas quatro categorias anteriores.',
};

export function validateTriageInput(body) {
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 32000) throw new HttpError(400, 'Selecione de 1 a 32.000 caracteres.');
  return { text: body.text.trim() };
}

export function triageQuestions() {
  return {
    urgency: {
      type: 'score',
      instructions: 'Classifique a urgência para o destinatário usando o prazo e o impacto explícitos. Não aumente o nível só porque existe dinheiro, cliente ou linguagem negativa. Use 3 apenas para ação imediata, emergência ou crise crítica ativa; use 2 para hoje ou amanhã; use 1 para rotina futura; use 0 para assunto concluído ou informativo.',
      criteria: URGENCY_LEVELS,
    },
    conflict: {
      type: 'score',
      instructions: 'Classifique somente atrito interpessoal ou entre organizações explicitamente presente. Não trate falha técnica, urgência, prejuízo, acidente, cancelamento ou pressão de prazo como conflito por si só. Diferencie frustração leve (1), cobrança forte ou repetida (2) e hostilidade, insulto ou ameaça punitiva (3).',
      criteria: CONFLICT_LEVELS,
    },
    needs_response: {
      type: 'noul',
      instructions: 'Esta comunicação pede ou exige uma resposta do destinatário?',
      criteria: {
        true: 'Há pergunta, solicitação, decisão pendente, cobrança ou expectativa explícita de retorno.',
        false: 'É apenas informativa, confirmação final ou não cria expectativa de resposta.',
      },
    },
    category: {
      type: 'choice',
      instructions: 'Escolha o assunto central, ignorando efeitos incidentais. Priorize people para equipe e contratação, customer para a relação com cliente, revenue para venda, contrato e pagamento, operation para sistemas e processos de negócio, e other para agenda pessoal, viagem, refeição ou segurança física.',
      criteria: CATEGORIES,
    },
  };
}

const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function validDistribution(value, keys) {
  if (!exactKeys(value, keys) || keys.some(key => !finite(value[key], 0, 1))) return false;
  return Math.abs(keys.reduce((sum, key) => sum + value[key], 0) - 1) <= 0.02;
}
function scoreAnswer(value, expectedLegend) {
  const levels = ['0', '1', '2', '3'];
  if (!value || value.type !== 'score' || !finite(value.score, 0, 3) || !finite(value.confidence, 0, 1) || !validDistribution(value.probabilities, levels) || !exactKeys(value.legend, levels) || levels.some(level => value.legend[level] !== expectedLegend[Number(level)])) throw new HttpError(502, 'O Jev retornou uma avaliação inválida.');
  const weightedScore = levels.reduce((sum, level) => sum + Number(level) * value.probabilities[level], 0);
  if (Math.abs(weightedScore - value.score) > 0.05) throw new HttpError(502, 'O Jev retornou uma avaliação contraditória.');
  return { score: Math.round(weightedScore * 1e6) / 1e6, confidence: value.confidence };
}

export function derivePriority({ urgency, conflict, needsResponse }) {
  if (urgency >= 2.5 || conflict >= 2.75) return 'critical';
  if (urgency >= 1.5 || conflict >= 1.75 || needsResponse >= 0.8) return 'high';
  if (urgency >= 0.5 || conflict >= 0.75 || needsResponse >= 0.5) return 'normal';
  return 'low';
}

export function validateTriageResult(payload) {
  if (!payload || typeof payload.model !== 'string' || !payload.model.trim() || payload.model.length > 100 || !exactKeys(payload.answers, ['urgency', 'conflict', 'needs_response', 'category'])) throw new HttpError(502, 'O Jev retornou uma avaliação inválida.');
  const urgency = scoreAnswer(payload.answers.urgency, URGENCY_LEVELS);
  const conflict = scoreAnswer(payload.answers.conflict, CONFLICT_LEVELS);
  const needs = payload.answers.needs_response;
  if (!needs || needs.type !== 'noul' || !finite(needs.noul, 0, 1)) throw new HttpError(502, 'O Jev retornou uma avaliação inválida.');
  const category = payload.answers.category;
  const choices = Object.keys(CATEGORIES);
  if (!category || category.type !== 'choice' || !choices.includes(category.choice) || !finite(category.confidence, 0, 1) || !validDistribution(category.probabilities, choices)) throw new HttpError(502, 'O Jev retornou uma avaliação inválida.');
  const highest = Math.max(...choices.map(choice => category.probabilities[choice]));
  if (category.probabilities[category.choice] < highest - 1e-9) throw new HttpError(502, 'O Jev retornou uma avaliação contraditória.');
  const normalized = {
    model: payload.model.trim(), urgency, conflict,
    needsResponse: { probability: needs.noul },
    category: { choice: category.choice, confidence: category.confidence },
  };
  return { ...normalized, priority: derivePriority({ urgency: urgency.score, conflict: conflict.score, needsResponse: needs.noul }) };
}

export async function jevTriage(config, input, fetcher = fetch) {
  if (!config.typesafeKey) throw new HttpError(503, 'Triagem executiva ainda não configurada.', 'TRIAGE_UNAVAILABLE');
  const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.typesafeKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: input.text, model: config.typesafeModel, questions: triageQuestions() }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, 'A triagem executiva está indisponível. Tente novamente.', 'TRIAGE_UNAVAILABLE');
  return validateTriageResult(payload);
}
