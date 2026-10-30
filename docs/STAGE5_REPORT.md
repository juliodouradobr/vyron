# Etapa 5 — Compartilhamento de tela e transmissão

Também nesta rodada (pré-requisitos do prompt VYRON): marca VYRON na interface e identificador
público `Nome#00000` (ver `docs/AUDIT_VYRON.md`).

## O que foi implementado

### Servidor (autoridade sobre quem transmite e quem assiste)
- `VoiceParticipantState.stream`: `{ surface, hasAudio, startedAt, viewers[] }` ou `null`.
- Operações do gateway: `stream_start`, `stream_stop`, `stream_watch` (validadas com zod).
- **Permissão STREAM verificada no servidor** a cada `stream_start`; em DM, os dois podem transmitir.
  Sem permissão → `STREAM_ERROR` e nada é anunciado; o cliente encerra a captura local na hora.
- **Revalidação**: se um cargo/canal muda e a pessoa perde STREAM, a transmissão é encerrada
  imediatamente e a sala é avisada (mesmo mecanismo que já tirava SPEAK/CONNECT).
- Assistir só é possível estando na mesma sala e com a transmissão ativa; máximo de 7 espectadores
  (limite da malha P2P). Sair da sala remove a pessoa de todas as listas de espectadores.
- Limite de SDP subiu de 12 KB para 48 KB (ofertas com vídeo são maiores).

### Cliente
- **Captura**: `getDisplayMedia` (API oficial; a escolha de tela/janela/aba é sempre feita no seletor
  do sistema). O próprio app é excluído do seletor quando suportado (`selfBrowserSurface: 'exclude'`).
- **Qualidade escolhida**: 360p, 480p, 720p, 1080p, 1440p, 2160p × 15/30/60 FPS, e tipo de conteúdo:
  - *Jogo/vídeo*: `contentHint = motion`, `degradationPreference = maintain-framerate`.
  - *Texto/código*: `contentHint = detail`, `maintain-resolution`, ~25% menos bitrate.
  - Resolução/FPS são **máximos**: a captura não amplia a imagem; se o sistema entregar mais que o
    pedido, o codificador reduz (`scaleResolutionDownBy`).
  - Bitrate-alvo por espectador (ex.: 720p30 = 2,5 Mbps; 1080p60 = 6,75 Mbps; teto 20 Mbps). O diálogo
    mostra a estimativa de envio total (P2P = uma cópia por espectador) e avisa acima de 15 Mbps.
  - Qualidade pode ser mudada durante a transmissão (`applyConstraints` + novos parâmetros) e a fonte
    pode ser trocada sem derrubar quem assiste (`replaceTrack`).
- **Vídeo só para quem assiste**: quem não clica em "Assistir" não recebe nada e não gasta banda.
  Transceptores são reaproveitados (parar = `inactive`, recomeçar = `sendonly`).
- **Áudio da tela** (opcional, marcado pela pessoa): sem cancelamento de eco/supressão/AGC; Opus da
  seção da tela em estéreo, 128 kbps, sem DTX. O microfone continua mono 40 kbps com DTX.
- **Prioridade**: voz `high`, vídeo `low` — se a rede apertar, a voz passa na frente.
- **Estatísticas reais** (`getStats`, a cada 2 s):
  - Quem transmite, por espectador: resolução e FPS enviados, resolução/FPS da captura, kbps, perda
    (RTCP), RTT, motivo de limitação do codificador e o nível de adaptação.
  - Quem assiste: resolução, FPS, kbps, perda do intervalo, buffer de recepção, **latência estimada**
    (RTT/2 + buffer; não inclui captura/codificação), quadros descartados, travadas.
  - **Escolhido × real**: a interface mostra o que foi escolhido e o que está saindo, com o motivo em
    português (fonte menor que o pedido, rede, processador, adaptação, captura com poucos FPS).
- **Adaptação por espectador**: perda > 5% ou RTT > 400 ms por 2 amostras baixa o teto um degrau
  (100/75/55/40/28%); 5 amostras boas sobem um degrau. Um espectador com rede ruim não piora os outros.
- **Indicador sempre visível** no painel de voz ("Transmitindo: Janela · N assistindo · Parar"),
  selo AO VIVO nos participantes, prévia local muda (sem eco), botão Parar; parar pelo controle do
  sistema também encerra.
- **Visualização**: área de destaque com volume da transmissão, tela cheia, estatísticas sob demanda;
  ensurdecer silencia também o áudio das transmissões. Um erro de exibição de vídeo fica isolado
  (error boundary) e não derruba o app.

## Testes

- Automatizados: **188 passando** (protocolo 30, desktop 66, servidor 92); typecheck limpo; build OK.
  - Servidor (5 novos): anunciar/assistir/parar; recusa sem STREAM; perda de STREAM durante a
    transmissão encerra; não assistir quem não transmite nem de fora da sala; sair da sala deixa de
    assistir; DM permite transmitir.
  - Cliente (16 novos): presets e bitrates, opções de captura, escala do codificador, estatísticas de
    envio/recepção, explicações, adaptação (inclusive o caso do ciclo abaixo), Opus por seção.
- **WebRTC real no Chromium** (três malhas na mesma página, fonte = canvas animado 1920×1080):
  - B (assistindo) recebeu 1280×720 a 30 FPS, ~2,5 Mbps, com fonte 1080p reduzida no codificador; C
    (não assistindo) não recebeu nada; o áudio da tela não foi confundido com o microfone.
  - Parar → faixa do espectador fica `muted` e nada é enviado; recomeçar com outra fonte reaproveita
    os transceptores. C com teto em 40% → codificador caiu para 360p mantendo 30 FPS (`maintain-framerate`).
- **App completo com duas contas** (duas abas, origens diferentes, sala "Geral"): botão Compartilhar →
  diálogo (1080p60) → AO VIVO confirmado pelo servidor → "Ninguém está assistindo: nenhum vídeo está
  sendo enviado" → a outra conta clicou Assistir e viu a imagem com estatísticas → subiu de 360p para
  1080p em ~16 s, ~4,8 Mbps, latência estimada ~18 ms (rede local) → Parar de assistir zerou o envio →
  Parar de transmitir limpou indicador e estado dos dois lados.

### Problemas encontrados nos testes e corrigidos
1. **Tela branca ao iniciar a transmissão**: um seletor do Zustand devolvia `[]` novo a cada leitura
   enquanto o servidor não confirmava → laço infinito de renderização. Corrigido (constante) e a área de
   transmissões ganhou error boundary.
2. **Ciclo de queda de qualidade**: a adaptação usava a limitação `bandwidth` do codificador, que o
   Chrome também reporta enquanto sobe a estimativa de banda *e* quando bate no nosso próprio teto —
   o app baixava o teto, o navegador dizia "bandwidth" de novo, até 28%. Agora só perda e RTT mexem no
   teto; a limitação continua sendo exibida como explicação. Teste de regressão adicionado.
3. **Latência estimada inflada** (217 ms após uma pausa): usava a média do buffer desde o início;
   agora usa o intervalo da última coleta.

## O que NÃO foi testado (e por quê)
- **Seletor real do sistema**: o navegador do ambiente de desenvolvimento não abre o seletor de
  tela; no teste do app, só `getDisplayMedia` foi substituído por um canvas — botões, servidor e WebRTC
  foram os reais. A captura de uma tela/janela de verdade precisa ser conferida num PC.
- **Áudio do sistema**: não testado (a captura simulada não tem áudio de sistema). No Windows, o
  Chromium oferece áudio ao compartilhar a tela inteira ou uma aba; janelas avulsas normalmente não
  têm. Com áudio da tela inteira, as vozes da chamada podem ser capturadas — o diálogo recomenda fone.
  `restrictOwnAudio` é pedido, mas só vale onde o navegador suportar.
- **Tauri/WebView2**: o shell não foi compilado (sem Rust). O WebView2 suporta `getDisplayMedia`, mas
  isso não foi verificado aqui.
- **Duas máquinas / internet real**: os testes foram locais (RTT 1–9 ms). Comportamento com perda real,
  NAT e TURN precisa de teste entre dois PCs.
- **Jogos em tela cheia exclusiva**: podem aparecer pretos na captura do sistema; a recomendação é usar
  modo janela sem bordas. Não contornamos proteções do sistema nem anti-cheat.

## Limites desta versão
- Topologia P2P: cada espectador recebe uma cópia → o envio cresce com o número de espectadores
  (máx. 7). Para mais espectadores e simulcast, é preciso um SFU (avaliação prevista no VYRON).
- Codificação por software na maioria dos casos (o navegador decide o codec; o nome do codificador só
  aparece quando o navegador o expõe).
- Sem câmera ainda (próxima prioridade da auditoria).
