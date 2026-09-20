# Dia Executive para WhatsApp

## Problema e público

O produto atende executivos que recebem muitas conversas simultâneas e precisam
separar decisões, riscos, delegações e follow-ups sem transformar o WhatsApp em
outro sistema complexo. O caso principal é um C-level que alterna entre clientes,
lideranças e grupos operacionais ao longo do dia e precisa recuperar o contexto
correto antes de agir.

A extensão deve reduzir três custos concretos:

1. tempo gasto relendo conversas e ouvindo áudios;
2. perda de compromissos, decisões e pedidos entre vários chats;
3. risco de responder sem contexto ou deixar uma situação crítica sem dono.

## Fluxo do produto

O usuário abre uma conversa no WhatsApp Web e escolhe explicitamente o trecho já
carregado que deseja analisar. O painel transforma esse trecho em itens revisáveis.
Nada é salvo, enviado à IA ou copiado para a área de transferência sem uma ação
do usuário.

O painel executivo organiza o trabalho em cinco etapas:

1. **Capturar:** carregar até o limite exibido de mensagens da conversa aberta e
   revisar o texto antes de processá-lo.
2. **Entender:** gerar resumo executivo, decisões e riscos com evidência do trecho.
3. **Organizar:** salvar itens em pastas, classificar prioridade, responsável e
   quem deve responder.
4. **Agir:** acompanhar pendências e preparar um handoff ou rascunho para copiar.
5. **Recuperar:** buscar por texto e combinar filtros de tipo, pasta, prioridade,
   status e conversa.

## Capacidades do produto

### Base

- transcrição e resumo de áudios sob demanda;
- resumo da conversa aberta;
- busca por texto em transcrições e itens salvos;
- pastas para separar temas, contas, lideranças ou frentes;
- tarefas com prazo, prioridade, responsável e estado de acompanhamento;
- biblioteca exportável e com exclusão individual.

### Diferenciais executivos

1. **Briefing executivo:** produz uma leitura curta do trecho com fatos, decisões,
   riscos e próximas ações. O resultado continua editável e só entra na biblioteca
   depois de revisão.
2. **Registro de decisões:** extrai decisão, dono, prazo e evidência literal. A
   sugestão não é tratada como decisão confirmada até o usuário salvá-la.
3. **Radar de riscos:** identifica bloqueios, escaladas e compromissos frágeis com
   evidência. A classificação de IA é uma hipótese para revisão humana.
4. **Radar de follow-up:** separa o que depende do usuário, de outra pessoa ou de
   uma delegação, ordena por prioridade e destaca atrasos.
5. **Pacote de delegação:** cria contexto, resultado esperado, responsável e prazo
   em um texto editável. A extensão permite copiar o pacote e nunca o envia.

### Jev

Jev atua como motor opcional de triagem probabilística. Seu papel é pontuar
urgência, conflito e necessidade de resposta, classificar a categoria executiva e
derivar prioridade por uma regra local verificável. Geração de texto, extração de
decisões e identificação de responsáveis continuam no provedor generativo. O
painel identifica a origem, mostra confiança e mantém revisão e salvamento explícitos.

Uma integração comercial com Jev depende de contrato de API, limites, observação
de custos, residência e retenção dos dados, disponibilidade e tratamento de falhas.
Ter acesso ao console ou a uma chave em ambiente de desenvolvimento não valida
esses requisitos.

## Privacidade e limites

- A captura é explícita e limitada ao texto já carregado na conversa aberta. A
  extensão não percorre chats, não rola o histórico e não usa API privada do
  WhatsApp para coletar mensagens.
- Carregar o trecho apenas cria uma prévia local. Cada botão de IA informa que o
  conteúdo será enviado ao backend e ao provedor configurado.
- Salvar no servidor exige consentimento separado. Itens são cifrados, isolados
  por conta, exportáveis e excluíveis segundo a retenção documentada.
- Transcrições temporárias permanecem no cache cifrado da sessão até o usuário
  escolher salvá-las.
- A extensão não preenche, clica ou envia mensagens no WhatsApp. Briefings,
  handoffs e respostas podem ser copiados após revisão humana.
- Evidências ajudam a conferir a origem, mas não eliminam erros de classificação,
  omissões ou inferências da IA.

## Gates para publicar e vender

Os testes automatizados e o smoke no navegador comprovam funcionamento técnico,
não demanda de mercado. Publicação e venda precisam passar por gates separados:

| Gate | Evidência mínima antes de considerar aprovado |
| --- | --- |
| Segurança e privacidade | revisão de permissões e fluxos de dados; política pública consistente; exclusão e exportação verificadas; nenhum envio automático |
| Confiabilidade | suíte unitária e E2E verde; teste com WhatsApp Web real; falhas do provedor tratadas sem perder ou duplicar itens |
| Qualidade de IA | conjunto representativo em português com precisão medida para decisões, riscos e tarefas; rastreabilidade por evidência; revisão humana obrigatória |
| Utilidade | pilotos com executivos usando conversas próprias e repetindo o fluxo; redução mensurável do tempo de triagem e de follow-ups perdidos |
| Disposição a pagar | entrevistas não bastam; usuários do perfil-alvo aceitam preço e pelo menos um piloto paga ou assume compromisso verificável |
| Economia | custo de IA e suporte medido por usuário ativo; margem e limites compatíveis com o preço; proteção contra abuso |
| Plataforma | política da Chrome Web Store atendida; descrição das práticas de dados completa; revisão das mudanças do DOM do WhatsApp |
| Operação | monitoramento, suporte, processo de incidente, backup, recuperação e runbook para mudanças do WhatsApp ou dos provedores |

Não se deve declarar 99% de confiança comercial a partir de concorrentes, testes
locais ou intenção verbal. Esse nível só pode ser sustentado depois que os gates de
utilidade, disposição a pagar e economia forem observados em pilotos reais.

### Benchmark de triagem

`npm run eval:triage:fixture` valida o runner com 30 casos sintéticos em português.
O conjunto cobre urgência, conflito, expectativa de resposta, categoria executiva
e tentativas de prompt injection. O resultado fixture de 100% é apenas uma prova do
cálculo das métricas e não mede o Jev.

`npm run eval:triage` usa `TYPESAFE_API_KEY` para executar o mesmo conjunto no Jev.
O relatório mostra acurácia e baixa confiança por dimensão, falhas do provedor e
abstenções, sem imprimir os textos dos casos ou a chave. Só um resultado live pode
ser usado como evidência de qualidade, e ele ainda precisa ser complementado por
casos reais anonimizados e revisados com autorização.

## Critérios de aceite do painel executivo

- O dashboard mostra pendências abertas, atrasadas, de alta prioridade, decisões e
  riscos usando somente itens da conta atual.
- Uma tarefa preserva prioridade, responsável, estado de acompanhamento, prazo,
  conversa e pasta após recarregar o painel.
- Busca e filtros podem ser combinados e não chamam IA.
- Decisões e riscos extraídos exibem evidência antes de permitir o salvamento.
- Briefing e handoff são editáveis e somente copiados por ação explícita.
- Resultado de triagem Jev informa sua origem e não dispara envio ao WhatsApp.
- Logout ou troca de conta remove dados da sessão visível antes de carregar a nova
  conta.
- O teste E2E usa WhatsApp sintético e provedores simulados e prova que nenhuma
  mensagem foi enviada.
