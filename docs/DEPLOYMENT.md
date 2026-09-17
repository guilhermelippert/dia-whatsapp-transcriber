# Implantação comercial

## Pré-requisitos do titular

Domínio HTTPS/DNS, servidor Linux com Docker, conta Stripe habilitada para cobrança e saques, crédito OpenRouter, domínio de e-mail verificado no Resend e conta de desenvolvedor Chrome Web Store. PR/CI não ativa esses serviços externos.

1. Copie `.env.example` para `.env.local` fora do Git. Gere `DATA_ENCRYPTION_KEY` aleatória de 32 bytes em hexadecimal. Guarde backup seguro: perder/trocar a chave sem migração torna dados existentes ilegíveis.
2. Preencha `PUBLIC_BASE_URL` com origem HTTPS real sem barra final, `PUBLISHER_NAME`, `SUPPORT_EMAIL`, `EMAIL_FROM`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`. Não use endereços `.invalid` em produção.
3. No Stripe **test**, configure chave secreta e execute `npm run stripe:setup -- --apply`. O script cria/reutiliza produto/preço BRL 29,90 e prepara portal/webhook. `PRO_MONTHLY_AMOUNT` altera o valor em centavos antes da primeira criação. Execute interativamente: a saída contém o segredo do webhook; não publique em logs/CI. Grave `STRIPE_PRICE_ID` e `STRIPE_WEBHOOK_SECRET` em `.env.local`.
4. Configure o portal criado como padrão no painel Stripe e preencha detalhes públicos, URL de termos `${PUBLIC_BASE_URL}/terms`, política `${PUBLIC_BASE_URL}/privacy`, suporte e descrição no extrato. Checkout com concordância exige URL de termos válida no Dashboard. O script não substitui KYC nem obrigações fiscais.
5. Crie o item em rascunho no Chrome Web Store para obter seu ID. Defina `EXTENSION_ORIGINS=chrome-extension://ID_EXATO` (32 letras a-p). Em staging, liste separadamente o ID de desenvolvimento. Não permita todas as extensões em produção.
6. Prepare o volume: `sudo install -d -m 700 -o 1000 -g 1000 data`. Aponte DNS para o servidor, abra 80/443 e execute `docker compose up -d --build`. Não exponha 43110. Caddy termina TLS e sobrescreve `X-Real-IP`; o backend só confia no proxy fixado no compose.
7. Valide login/consentimento/áudio real e todo o ciclo Stripe test. API e webhook usam `2026-08-26.dahlia`.
8. Repita setup em **live**, com preço e segredo de webhook live distintos. Não misture modos. Execute `npm run preflight` e uma compra/cancelamento live autorizados antes da submissão pública.

## Operação

**Uma réplica apenas.** Locks de cliente atravessam chamadas Stripe em memória; SQLite protege reservas transacionais. Não rode workers Node adicionais nem duas réplicas no mesmo banco. Escala horizontal exige banco compartilhado e locks distribuídos.

Não troque `STRIPE_PRICE_ID` de um produto em operação sem migrar as assinaturas existentes: a elegibilidade aceita somente o preço configurado. A configuração inicial define um único plano, não uma migração automática de preços.

Backup: pare brevemente o app ou use backup consistente SQLite incluindo WAL. Cifre backups, restrinja acesso e expire-os em até 30 dias. Registre exclusões separadamente para reaplicá-las antes de restaurar backup. Essa política exige configuração operacional real.

Retenção implementada: resultados cifrados de idempotência por aproximadamente 10 minutos, metadados de uso/eventos por 90 dias, códigos por 10 minutos, sessões por 30 dias, marcador HMAC de trial por 180 dias após uso/exclusão. Limpeza a cada minuto e antes de reservar ações. Falhas de IA devolvem reservas; leases abandonados expiram em 2 minutos.

IA tem timeout de 25 segundos, cliente 27, evitando ultrapassar o tempo de resposta do service worker. Processamentos demorados falham sem consumir cota. A captura por reprodução tem limite de 5 minutos; prefira o blob original disponível. Compatibilidade depende do DOM do WhatsApp, que pode mudar.

Cancelamento no portal mantém Pro até o fim do período pago. `past_due`, `unpaid`, cancelado ou pausa de cobrança não concedem Pro. Webhooks e reconciliação a cada 5 minutos quando a conta é acessada atualizam a assinatura. Stripe indisponível após esse prazo falha fechado. Exclusão com falha Stripe fica pendente e retorna erro; repetir com a mesma sessão conclui.

## Smoke obrigatório antes de vender

| Caso | Resultado esperado |
| --- | --- |
| Instalar/reiniciar | Sem envio automático; login e consentimento necessários |
| Gratuito no limite | Ação adicional bloqueada mesmo após reinstalar |
| Trial 7/14 dias | Sem cartão; expira para gratuito; não reinicia |
| Checkout duplicado | Um cliente/sessão; assinatura existente direciona ao portal |
| Webhook repetido/antigo | Não duplica benefício nem restaura cancelado |
| Pagamento falhou | URL de retorno não concede Pro |
| Cancelar | Acesso até término do período pago |
| Excluir | Cancela Stripe, remove conta e dados locais |
| Revogar consentimento | Limpa cache e bloqueia novas solicitações |
| Reiniciar servidor | Conta/cota/trial persistem; sem chaves no ZIP |

## Referências verificadas em 16/09/2026

- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/changelog
- https://openrouter.ai/docs/guides/overview/multimodal/stt
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

## Isolamento do proxy e privacidade do cache

Antes de `docker compose up`, copie `.env.proxy.example` para `.env.proxy` e defina
somente `PUBLIC_BASE_URL`, com a mesma origem HTTPS de `.env.local`. Não copie
credenciais, `DATA_ENCRYPTION_KEY` ou o restante do ambiente do backend. O Caddy
não necessita desses segredos. Proteja ambos os arquivos com `chmod 600`.

A chave do cache de comunicações da extensão reside exclusivamente em
`chrome.storage.session`. Ao fechar o navegador, essa chave desaparece. No próximo
uso, o cache cifrado antigo é descartado. Reiniciar apenas o service worker não
perde a chave. Sair, revogar o consentimento ou limpar dados também destrói o cache.
O cache não é backup; copie resultados importantes antes de encerrar o navegador.

As requisições de IA adquirem capacidade antes de ler o corpo (2 por conta,
`GLOBAL_AI_CONCURRENCY` global), além das cotas e limites de frequência.
`GET /plan` permite 30 consultas por IP/minuto. Consultas concorrentes de preço
são agregadas; falhas do Stripe têm intervalo de 10 segundos antes de nova tentativa.
O setup repara eventos ausentes no webhook existente; o preflight rejeita um
webhook sem cobertura de todos os eventos obrigatórios.
