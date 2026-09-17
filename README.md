# Dia Transcriber para WhatsApp

Extensão Chromium Manifest V3 para transcrever e resumir áudios do WhatsApp Web, com backend próprio e **OpenRouter preservado**. Produto independente de WhatsApp, Meta e do navegador Dia.

## Modelo comercial

| Modalidade | Acesso |
| --- | --- |
| Gratuito | 30 ações de IA bem-sucedidas por mês civil UTC |
| Trial | Pro por 14 dias, sem cartão; configurável para 7; volta ao gratuito sem cobrança |
| Pro | Um único plano mensal, sem cota mensal de ações |

Cada transcrição ou novo resumo consome uma ação; falhas e repetição idempotente não consomem novamente. O setup sugere **R$29,90/mês**, alterável antes de criar o preço. O valor exibido vem do preço real configurado no Stripe, nunca de texto fixo no popup. Assinar durante o trial inicia cobrança imediata, com aviso explícito.

Ilimitado significa sem franquia mensal, não capacidade computacional infinita: 24 MB por áudio, 2 processamentos simultâneos por conta, 20 requisições de IA/minuto e 12 processamentos globais. O provedor continua cobrando por uso; acompanhe margem e orçamento no OpenRouter. Proteções técnicas não são uma segunda modalidade paga.

## Desenvolvimento

Node **22.16+ dentro da linha 22**, sem dependências npm de produção. `node:sqlite` ainda emite aviso experimental nessa linha; valide upgrades antes de produção.

```sh
cp .env.example .env.local
# Preencha a chave de cifragem e credenciais somente em .env.local.
npm run build
npm run check
npm test
npm start
```

Carregue `dist/development` em `chrome://extensions` > Modo desenvolvedor > Carregar sem compactação. O backend de desenvolvimento é `http://127.0.0.1:43110`. Login depende de domínio de e-mail verificado no Resend; testes substituem provedores sem exigir credenciais.

A transcrição automática vem desligada. Abra o popup, entre com código de e-mail e autorize o processamento. Recarregue o WhatsApp após mudar o modo automático. Chaves OpenRouter/Stripe/Resend nunca entram na extensão.

## Implementação

- Backend HTTP: e-mail verificado, sessões aleatórias armazenadas por hash, cotas e trials no servidor, SQLite WAL persistente, rate limit e reservas transacionais.
- Stripe Checkout e Customer Portal: preço único controlado pelo servidor, cliente vinculado à conta autenticada, sessões idempotentes, bloqueio de assinaturas duplicadas, webhooks assinados e deduplicados.
- Webhooks reconciliam o estado atual no Stripe; um evento antigo não reativa um Pro cancelado. URL de sucesso não concede acesso. Cancelamento mantém acesso até o fim do período pago; inadimplência/pausa não concede Pro.
- Dados sensíveis persistidos cifrados com AES-256-GCM, cache local acessível apenas a contextos confiáveis da extensão, exportação/exclusão de conta e revogação de consentimento.
- Conteúdo de WhatsApp só segue para IA após consentimento. Não automatiza envio de mensagens, não captura microfone nem carrega código remoto.

## Testes e pacote

```sh
npm test                         # testes unitários/integrados, provedores simulados
npm run test:browser              # Chrome real + extensão MV3 + WhatsApp sintético
PUBLIC_BASE_URL=https://seu-dominio-real npm run build:release
node scripts/validate-manifest.mjs dist/chrome-store
```

`test:browser` exige Chrome com carregamento de extensão permitido. Usa CDP nativo sem dependência de automação. A CI executa o fluxo e publica relatório/screenshots + ZIP de desenvolvimento. Testes não comprovam aprovação Google, pagamento live ou compatibilidade com toda versão futura do WhatsApp.

O ZIP de publicação é `dist/chrome-store.zip`, com manifesto na raiz e somente código/recursos empacotados. Builds de release recusam localhost e placeholders comuns. Tags `v*` geram o artefato usando a variável GitHub `PUBLIC_BASE_URL`, sem publicar automaticamente.

## Para lançar

Siga [implantação](docs/DEPLOYMENT.md) e [ficha da Chrome Web Store](docs/CHROME_WEB_STORE.md). Código e testes não ativam contas externas: ainda são necessários domínio HTTPS, backend implantado, ID da extensão, credenciais reais, Stripe live habilitado, domínio de e-mail verificado e submissão/revisão Google.

**Uma réplica somente.** Não escale horizontalmente sem migrar persistência e locks. Guarde a chave de cifragem, implemente backups cifrados com retenção máxima de 30 dias e execute os smokes reais antes de vender.
