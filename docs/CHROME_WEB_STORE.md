# Chrome Web Store: material e checklist

Esta PR prepara código, build e textos. Não garante aprovação do Google nem substitui a submissão da conta proprietária.

## Ficha sugerida (pt-BR)

**Nome:** Dia Executive para WhatsApp

**Categoria:** Produtividade

**Resumo:** Transforme áudios e conversas do WhatsApp Web em clareza, decisões e follow-ups revisáveis.

**Descrição:** Leia notas de voz sem precisar ouvir cada áudio e transforme trechos revisados de conversas em resumos, tarefas, decisões, riscos, briefings, handoffs e rascunhos de resposta. Organize itens em pastas, defina prioridade, responsável, prazo e estado de follow-up, e recupere tudo com busca e filtros. A triagem Jev classifica urgência, conflito, necessidade de resposta e categoria com confiança visível. Toda sugestão passa por revisão e salvamento explícito; a extensão nunca envia mensagens. O processamento por IA é opcional e depende de consentimento. A transcrição automática vem desativada. O gratuito inclui 30 ações de IA por mês; experimente o Pro por 14 dias sem cartão, sem renovação automática do trial. Um único plano Pro mensal oferece ações sem cota mensal, respeitados limites técnicos e antiabuso. O preço atual aparece na extensão e no Checkout Stripe antes da contratação. Produto independente, sem afiliação a WhatsApp, Meta ou ao navegador Dia.

Se alterar `TRIAL_DAYS`/`FREE_MONTHLY_ACTIONS`, atualize a ficha. Não anuncie funcionalidades exclusivas de outra branch até incluí-las no ZIP enviado.

## Propósito único e permissões

Propósito: ajudar o usuário a ler e organizar comunicações do WhatsApp Web, com processamento de conteúdo explicitamente escolhido.

- `storage`: preferências, sessão e cache de resultados cifrado no perfil local.
- `https://web.whatsapp.com/*`: adicionar controles, ler o áudio escolhido e, somente por ação no cockpit, capturar até 50 mensagens ou 32.000 caracteres já carregados na conversa aberta para revisão local antes da IA. A extensão não percorre outras conversas nem envia mensagens.
- Origem HTTPS do backend: autenticação, status/cota, processamento IA e cobrança. Deve ser domínio real controlado pelo operador.
- Scripts MAIN e isolado são empacotados. A ponte associa o áudio selecionado ao elemento de mídia; nenhum JS remoto, `eval`, código baixado ou execução de respostas do modelo.
- Não pede acesso a todos os sites, microfone, histórico ou contatos. Não automatiza envio de mensagens.

## Privacidade no formulário da loja

Informe honestamente as categorias aplicáveis: identificação pessoal (e-mail), informações de autenticação (sessão), comunicações pessoais/conteúdo de sites (áudios e textos escolhidos), dados de uso (cotas) e dados de pagamento/assinatura (identificadores/status). Cartões são processados pelo Stripe; a extensão não recebe números completos.

Declare a transferência do conteúdo ao backend, OpenRouter e provedor de IA. A triagem Jev também transfere o trecho revisado à TypeSafe AI. Resend entrega códigos; Stripe processa cobrança. Não prometa criptografia ponta a ponta durante a inferência, retenção zero dos provedores ou impossibilidade de acesso por quem controla o dispositivo.

A política pública deve estar em `${PUBLIC_BASE_URL}/privacy`, com nome do responsável e suporte reais. Os termos ficam em `/terms`; suporte em `/support`. Certifique as declarações de Uso Limitado somente se as práticas operacionais também forem verdadeiras. Revise obrigações legais aplicáveis ao titular antes de lançar.

## Material visual

`npm run build` gera ícones originais PNG 16/32/48/128 px. Não usamos a marca gráfica oficial do WhatsApp. `npm run test:browser` gera screenshots da extensão real com conversas fictícias em `artifacts/`, incluindo 1280x800 do fluxo de transcrição. Não use conversas privadas de clientes em imagens da loja.

Selecione capturas aprovadas visualmente para a ficha. Popup alto é evidência de QA, não substitui uma imagem 1280x800 da loja. Informe nas imagens de demonstração que os dados são fictícios. Materiais promocionais opcionais devem respeitar os formatos exigidos pelo Dashboard no momento do envio.

## Instruções para revisão

Instale o pacote, abra WhatsApp Web com conta de teste própria, entre no popup com e-mail que possa receber o código e autorize o processamento por IA. Sem autorização não há envio. Clique Transcrever em um áudio; depois Resumir e Copiar. Abra o cockpit, carregue uma conversa de teste, revise a prévia e experimente resumo, tarefas, decisões, riscos, briefing, handoff, triagem Jev e rascunho. Salve apenas itens escolhidos, use busca e filtros, e confirme que nenhum botão envia mensagens. Consulte a cota e ative trial sem cartão. O modo automático precisa ser marcado voluntariamente. Apagar dados locais, exportar conta e excluir conta estão no popup. Não forneça credenciais reais privadas nas notas de revisão.

O backend deve estar ativo e permitir exatamente o ID da extensão submetida. Revisor deve conseguir testar grátis sem cartão nem chave de API própria. Credenciais/dados de demonstração eventualmente exigidos pelo Google precisam ser fornecidos pelo titular.

## Gate final do titular

- Conta de desenvolvedor, dados do publicador, verificação e pagamento da taxa do Google quando aplicável.
- ID definitivo incluído em `EXTENSION_ORIGINS`; domínio, API, privacidade, termos e suporte públicos funcionando.
- Stripe live habilitado, preço/portal/webhook reais; Resend verificado; OpenRouter com crédito; TypeSafe configurada para a triagem Jev anunciada.
- `npm run preflight`, compra/cancelamento autorizados e smoke em WhatsApp real.
- `PUBLIC_BASE_URL=https://dominio-real npm run build:release`; validar ZIP com manifesto na raiz, somente recursos da extensão, sem localhost ou segredos.
- Ficha/privacidade/imagens/notas consistentes com o pacote e práticas reais; submeter e acompanhar a revisão.

Referências: https://developer.chrome.com/docs/webstore/program-policies e https://developer.chrome.com/docs/webstore/publish

O cache de comunicações é temporário: a chave AES-GCM fica somente na sessão do navegador. Ao reiniciar o navegador, sair ou revogar consentimento, o cache deixa de estar disponível. Não anunciar backup permanente de transcrições.
