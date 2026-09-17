# Chrome Web Store: material e checklist

Esta PR prepara código, build e textos. Não garante aprovação do Google nem substitui a submissão da conta proprietária.

## Ficha sugerida (pt-BR)

**Nome:** Dia Transcriber para WhatsApp

**Categoria:** Produtividade

**Resumo:** Transcreva e resuma áudios do WhatsApp Web. Gratuito com limite e plano Pro por assinatura.

**Descrição:** Leia notas de voz sem precisar ouvir cada áudio. Transcreva, resuma, copie e consulte resultados no WhatsApp Web. O processamento por IA é opcional e depende de consentimento. Transcrição automática vem desativada. O gratuito inclui 30 ações de IA por mês; experimente o Pro por 14 dias sem cartão, sem renovação automática do trial. Um único plano Pro mensal oferece ações sem cota mensal, respeitados limites técnicos e antiabuso. O preço atual aparece na extensão e no Checkout Stripe antes da contratação. Produto independente, sem afiliação a WhatsApp, Meta ou ao navegador Dia.

Se alterar `TRIAL_DAYS`/`FREE_MONTHLY_ACTIONS`, atualize a ficha. Não anuncie funcionalidades exclusivas de outra branch até incluí-las no ZIP enviado.

## Propósito único e permissões

Propósito: ajudar o usuário a ler e organizar comunicações do WhatsApp Web, com processamento de conteúdo explicitamente escolhido.

- `storage`: preferências, sessão e cache de resultados cifrado no perfil local.
- `https://web.whatsapp.com/*`: adicionar controles e ler somente o áudio selecionado ou carregado quando o usuário optar pelo modo automático.
- Origem HTTPS do backend: autenticação, status/cota, processamento IA e cobrança. Deve ser domínio real controlado pelo operador.
- Scripts MAIN e isolado são empacotados. A ponte associa o áudio selecionado ao elemento de mídia; nenhum JS remoto, `eval`, código baixado ou execução de respostas do modelo.
- Não pede acesso a todos os sites, microfone, histórico ou contatos. Não automatiza envio de mensagens.

## Privacidade no formulário da loja

Informe honestamente as categorias aplicáveis: identificação pessoal (e-mail), informações de autenticação (sessão), comunicações pessoais/conteúdo de sites (áudios e textos escolhidos), dados de uso (cotas) e dados de pagamento/assinatura (identificadores/status). Cartões são processados pelo Stripe; a extensão não recebe números completos.

Declare a transferência do conteúdo ao backend, OpenRouter e provedor de IA. Resend entrega códigos; Stripe processa cobrança. Não prometa criptografia ponta a ponta durante a inferência, retenção zero dos provedores ou impossibilidade de acesso por quem controla o dispositivo.

A política pública deve estar em `${PUBLIC_BASE_URL}/privacy`, com nome do responsável e suporte reais. Os termos ficam em `/terms`; suporte em `/support`. Certifique as declarações de Uso Limitado somente se as práticas operacionais também forem verdadeiras. Revise obrigações legais aplicáveis ao titular antes de lançar.

## Material visual

`npm run build` gera ícones originais PNG 16/32/48/128 px. Não usamos a marca gráfica oficial do WhatsApp. `npm run test:browser` gera screenshots da extensão real com conversas fictícias em `artifacts/`, incluindo 1280x800 do fluxo de transcrição. Não use conversas privadas de clientes em imagens da loja.

Selecione capturas aprovadas visualmente para a ficha. Popup alto é evidência de QA, não substitui uma imagem 1280x800 da loja. Informe nas imagens de demonstração que os dados são fictícios. Materiais promocionais opcionais devem respeitar os formatos exigidos pelo Dashboard no momento do envio.

## Instruções para revisão

Instale o pacote, abra WhatsApp Web com conta de teste própria, entre no popup com e-mail que possa receber o código e autorize o processamento por IA. Sem autorização não há envio. Clique Transcrever em um áudio; depois Resumir e Copiar. Consulte a cota e ative trial sem cartão. O modo automático precisa ser marcado voluntariamente. Apagar dados locais, exportar conta e excluir conta estão no popup. Não forneça credenciais reais privadas nas notas de revisão.

O backend deve estar ativo e permitir exatamente o ID da extensão submetida. Revisor deve conseguir testar grátis sem cartão nem chave de API própria. Credenciais/dados de demonstração eventualmente exigidos pelo Google precisam ser fornecidos pelo titular.

## Gate final do titular

- Conta de desenvolvedor, dados do publicador, verificação e pagamento da taxa do Google quando aplicável.
- ID definitivo incluído em `EXTENSION_ORIGINS`; domínio, API, privacidade, termos e suporte públicos funcionando.
- Stripe live habilitado, preço/portal/webhook reais; Resend verificado; OpenRouter com crédito.
- `npm run preflight`, compra/cancelamento autorizados e smoke em WhatsApp real.
- `PUBLIC_BASE_URL=https://dominio-real npm run build:release`; validar ZIP com manifesto na raiz, somente recursos da extensão, sem localhost ou segredos.
- Ficha/privacidade/imagens/notas consistentes com o pacote e práticas reais; submeter e acompanhar a revisão.

Referências: https://developer.chrome.com/docs/webstore/program-policies e https://developer.chrome.com/docs/webstore/publish

O cache de comunicações é temporário: a chave AES-GCM fica somente na sessão do navegador. Ao reiniciar o navegador, sair ou revogar consentimento, o cache deixa de estar disponível. Não anunciar backup permanente de transcrições.
