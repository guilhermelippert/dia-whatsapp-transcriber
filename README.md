# Transcritor de áudios do WhatsApp para Dia

Extensão local Manifest V3 para o navegador Dia. Ela detecta notas de voz no
WhatsApp Web, transcreve os áudios em fila e exibe o texto abaixo da mensagem.
Cada resultado permite **Refazer**, **Resumir**, alternar entre resumo e
transcrição e **Copiar**.

A chave do OpenRouter fica apenas no serviço local. Ela não é gravada na
extensão nem exposta ao WhatsApp.

## Instalar e rodar

1. Garanta que `.env.local` contém `OPENROUTER_API_KEY=...`.
2. Inicie o serviço:

   ```bash
   npm start
   ```

3. No Dia, abra `dia://extensions` (ou `chrome://extensions`).
4. Ative o **Modo do desenvolvedor**.
5. Clique em **Carregar sem compactação** / **Load unpacked**.
6. Selecione a pasta `extension` deste projeto.
7. Abra ou recarregue `https://web.whatsapp.com/`.

O serviço escuta somente em `127.0.0.1:43110` e aceita requisições vindas de
extensões locais. Páginas web comuns não podem usar o serviço para consumir os
créditos da chave.

## Casos de uso

- Transcrição automática de áudios visíveis com identidade estável.
- Transcrição manual, nova tentativa e refazer.
- Notas recebidas e enviadas.
- Mensagens já abertas, adicionadas dinamicamente e re-renderizadas.
- Áudios expostos diretamente ou via Blob, XHR/fetch e MediaSource.
- Resumo sob demanda e alternância entre resumo/transcrição.
- Cópia do texto atualmente exibido.
- Diagnóstico do serviço e escolha do modelo pelo popup.
- Rótulos de nota de voz em português ou inglês.
- Formatos OGG/Opus, WebM, MP3, M4A, WAV, FLAC e AAC até 24 MB.

Em notas sem elemento de áudio direto, o player pode iniciar por uma fração de
segundo para que a extensão associe o Blob correto e o pausa em seguida.

## Desenvolvimento

```bash
npm test
npm run check
npm run lint:extension
npm run fixture
```

A fixture visual fica em
`http://127.0.0.1:43111/tests/fixture.html`.
O teste isolado do bridge fica em
`http://127.0.0.1:43111/tests/bridge-fixture.html`.

Opcionalmente, defina `SUMMARY_MODEL` em `.env.local`. O padrão é
`google/gemini-2.5-flash-lite`.
