# Painel de produtividade (branch codex/whatsapp-productivity)

Esta branch parte de `codex/chrome-store-billing`. Integre primeiro a PR comercial;
retargete a PR de produtividade para `main` depois do merge da base. Versão 0.4.0.

## Quatro funcionalidades

1. Resumo contextual da conversa com decisões, pendências e perguntas. Abra o
   painel pelo popup, escolha uma aba, clique em Carregar e revise o trecho.
   Só o clique em Resumir envia o texto revisado ao OpenRouter.
2. Extração de tarefas com evidência literal validada no servidor. Edite a sugestão,
   defina um prazo opcional e salve explicitamente. Inclui tarefas manuais,
   pendentes/atrasadas/concluídas e reabertura. Não há notificação fora do painel.
3. Rascunhos com tom direto, cordial ou formal e biblioteca de respostas rápidas.
   Revise, edite e copie. Não inserimos nem enviamos mensagens no WhatsApp.
4. Biblioteca com busca local sem IA, consulta a transcrições da sessão, resumos,
   tarefas e respostas salvas, exclusão individual e exportação JSON da conta,
   biblioteca e cache da sessão. Copiar preserva o conteúdo completo.

## Consentimento e limites de escopo

A extensão lê apenas texto já carregado na conversa aberta, até 50 mensagens ou
32.000 caracteres; não percorre outras conversas, não rola automaticamente e não
usa APIs privadas para coletar o histórico. Alterar o trecho durante uma geração
faz a interface descartar o resultado antigo. A IA pode errar mesmo com evidência;
a aprovação e o envio são humanos.

A autorização de IA é separada da autorização de armazenamento ao salvar. Sem
salvar, resumos e rascunhos ficam apenas na página e no cache temporário de
idempotência do backend. O painel avisa antes do processamento e do armazenamento.
A revogação limpa a página/cache e impede novos processamentos; os itens
explicitamente salvos continuam disponíveis para exportar ou excluir.

## Dados e segurança

`workspace_items` é criado automaticamente, sem dependências externas. Cada registro
é cifrado AES-256-GCM com contexto autenticado que inclui conta e ID. Toda consulta
ou escrita é limitada à conta da sessão; exclusão da conta faz cascade. Revisões
otimistas impedem sobrescrever uma edição em outra aba. Não edite o banco à mão.

Itens expiram após 90 dias sem edição, inclusive em leitura; limpeza de fundo a cada
minuto. Limites técnicos: 1.000 itens/10 MB cifrados por conta. Perder a chave do
backend torna a biblioteca ilegível. Aplique a política de backup e exclusão em
DEPLOYMENT.md. O cache local de transcrições permanece temporário, com chave em
storage.session; salvar uma transcrição na biblioteca é sempre uma ação explícita.

Nenhuma permissão nova foi adicionada. Scripts são empacotados. Nenhum conteúdo
recebido é interpretado como HTML/JS. O service worker valida remetente, sessão e
época antes e depois de operações; a página limpa conteúdo ao sair/trocar a conta.

## Plano e testes

As três ações de IA novas usam o mesmo OpenRouter, quota mensal, trial 7/14 dias,
plano Pro sem cota mensal, controle de concorrência e idempotência. Resultados
inválidos/falhas não cobram ações. Tarefas exigem JSON válido e evidência encontrada
no texto enviado. O usuário não fornece modelo/chave.

`npm run build && npm run check && npm test` cobre armazenamento, isolamento,
criptografia, expiração, reinício, revisões, limites, cotas, exportação e contrato
OpenRouter. `npm run test:browser` abre a extensão MV3 real e valida também o painel,
busca, preview, tarefas, rascunhos, exportação, persistência e viewport estreito.
WhatsApp, e-mail, cobrança e inferência são sintéticos/stubbed nesses testes: não
substituem o smoke de produção nem aprovação da Chrome Web Store.

## Ficha da loja para 0.4.0

Resumo: Transcreva áudios, resuma conversas e organize tarefas e respostas no WhatsApp.

Acrescente à descrição: Painel para resumir trechos revisados de conversas, extrair
tarefas com evidências, criar rascunhos de resposta e pesquisar resultados. Salvar
itens na biblioteca é opcional, com retenção de 90 dias. Nenhuma mensagem é enviada
automaticamente. O escopo é somente texto já carregado e escolhido pelo usuário.

Declare leitura de textos selecionados/carregados mediante ação no painel, além
dos áudios, e armazenamento de comunicações explicitamente salvas no backend.
Use capturas de `productivity-workspace.png` e `productivity-library.png` da CI
somente após revisar visualmente; todos os dados são fictícios.
