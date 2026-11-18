# Transcritor para WhatsApp Web

Uma extensão pessoal para ler notas de voz direto na conversa. Ela transcreve os áudios visíveis em fila, coloca o texto abaixo de cada mensagem e deixa os controles de mídia livres para a sua música. Você também pode copiar o texto ou refazer uma transcrição.

**Whisper local** processa o áudio no seu computador e funciona sem chave de API. **OpenRouter** envia o áudio ao provedor configurado e permite resumir o texto sob demanda. Você escolhe o modo no serviço local. Uma falha no Whisper nunca muda o processamento para a nuvem.

## Instalação

Você precisa de Node.js 22 ou superior e de um navegador Chromium com suporte a extensões descompactadas. O serviço Node usa apenas a biblioteca padrão.

1. Baixe o projeto e crie sua configuração local.

   ```sh
   git clone https://github.com/guilhermelippert/dia-whatsapp-transcriber.git
   cd dia-whatsapp-transcriber
   cp .env.example .env.local
   ```

2. No Helium ou em outro navegador Chromium, abra `chrome://extensions`, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta `extension` deste projeto.
3. Copie o **ID** do cartão da extensão. Em `.env.local`, preencha `ALLOWED_EXTENSION_ORIGINS=chrome-extension://SEU_ID`. Para usar vários navegadores, separe as origens por vírgulas.
4. Configure um dos modos abaixo e execute `npm start` na pasta do projeto. Abra o popup da extensão para conferir o modo ativo. Recarregue sua aba do WhatsApp Web.

### Whisper local

No macOS com Homebrew, instale o conversor de áudio e o motor de transcrição. Quem já tem um modelo GGML multilíngue do whisper.cpp pode reutilizar o arquivo.

```sh
brew install ffmpeg whisper.cpp
command -v ffmpeg
command -v whisper-cli
```

Para baixar o modelo `base` multilíngue e conferir sua integridade no macOS, execute os comandos na pasta do projeto.

```sh
mkdir -p models
curl --fail --location --output models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin
echo '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe  models/ggml-base.bin' | shasum -a 256 -c -
```

Em `.env.local`, defina `TRANSCRIPTION_PROVIDER=local`. Em `FFMPEG_PATH` e `WHISPER_CLI_PATH`, use os caminhos completos exibidos por `command -v`. Em `WHISPER_MODEL_PATH`, use o caminho completo do arquivo do modelo. Para português, escolha um modelo multilíngue. Os modelos com sufixo `.en` são específicos para inglês. Consulte o [guia do whisper.cpp](https://github.com/ggml-org/whisper.cpp).

### OpenRouter

Em `.env.local`, defina `TRANSCRIPTION_PROVIDER=openrouter` e preencha `OPENROUTER_API_KEY`. Reinicie o serviço e escolha o modelo de transcrição no popup. Ao abrir uma conversa, os áudios visíveis elegíveis são enviados automaticamente. Clicar em **Resumir** envia o texto ao OpenRouter e pode gerar uma cobrança adicional. Você pode definir `SUMMARY_MODEL` para trocar o modelo de resumo.

## O que fica salvo

O histórico recente de transcrições e resumos fica no armazenamento local da extensão, no perfil do navegador. O serviço escuta em `127.0.0.1:43110`. O modo local usa arquivos temporários durante o processamento e os remove ao terminar. Ele aceita uma transcrição por vez, com limite de 24 MiB por arquivo e 15 minutos por gravação. Mantenha o arquivo `.env.local`, os modelos e o perfil do navegador fora de qualquer pacote que compartilhar.

A extensão tenta obter a mídia da própria mensagem. Quando a versão do WhatsApp Web não disponibiliza o áudio para leitura silenciosa, o painel informa a falha e permite tentar novamente. A integração com o WhatsApp Web é independente e pode precisar de ajustes após atualizações do site.

## Desenvolvimento

```sh
npm test
npm run check
npm run fixture
```

No macOS, com o Whisper configurado e a voz Luciana instalada, `TEST_LOCAL_WHISPER=1 npm test` também verifica uma transcrição real de fala sintética em português. A suíte de navegador usa o Helium instalado no Mac ou o executável Chromium indicado por `HELIUM_BINARY`.

Com a fixture em execução, abra [a conversa simulada](http://127.0.0.1:43111/tests/fixture.html) ou [o teste de leitura da mídia](http://127.0.0.1:43111/tests/bridge-fixture.html).

O código é distribuído sob a [licença MIT](LICENSE). Para relatar uma vulnerabilidade, consulte a [política de segurança](SECURITY.md).
