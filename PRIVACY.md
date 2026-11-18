# Privacidade do Transcritor para WhatsApp Web

A extensão lê as notas de voz visíveis na conversa aberta para exibir a transcrição junto à mensagem. O identificador da mensagem associa cada resultado à nota correspondente. O serviço local recebe o áudio pelo endereço de loopback do computador.

## Onde os dados são processados

- **Whisper local.** O serviço converte o áudio com FFmpeg e executa o modelo no computador. Ele cria arquivos temporários para essa operação e os remove ao encerrar o processamento. Uma falha aparece na conversa e pode ser tentada novamente.
- **OpenRouter.** Quando você configura esse provedor no serviço e autoriza o envio no popup, as notas elegíveis das conversas abertas são enviadas ao OpenRouter para transcrição. Ao pedir um resumo, o serviço envia também o texto daquela transcrição. O OpenRouter pode encaminhar esses dados ao provedor do modelo escolhido. O tratamento externo depende do provedor e das configurações da sua conta. Consulte a [documentação de privacidade do OpenRouter](https://openrouter.ai/docs/guides/privacy/data-collection).
- **Controle do envio.** Você pode revogar a autorização no popup a qualquer momento. A revogação vale para os próximos pedidos. Para continuar transcrevendo no computador, configure o Whisper local.

## Armazenamento e remoção

O navegador guarda preferências, identificadores das mensagens, transcrições e resumos no armazenamento local da extensão. Ao remover a extensão do perfil, o Chromium remove esse armazenamento. A chave opcional do OpenRouter fica na configuração do serviço no computador. Para removê-la, apague a chave de sua configuração e reinicie o serviço. Você também pode revogá-la no painel do OpenRouter.

O projeto não mantém um servidor central de transcrições nem inclui telemetria de uso. Para comunicar um problema de privacidade, use o [canal privado de segurança](https://github.com/guilhermelippert/whatsapp-transcriber/security/advisories/new).
