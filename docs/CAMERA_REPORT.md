# Câmera (VYRON 8.4)

## O que foi implementado

### Permissão e servidor
- Nova permissão **VIDEO** ("Câmera", bit 21), separada de STREAM: um servidor pode liberar tela e
  bloquear câmera, ou o contrário. Aparece em cargos e nos ajustes por canal.
- Migração `004_video_permission.sql`: servidores existentes herdam a decisão que já tinham para
  STREAM (onde @everyone podia transmitir, passa a poder usar câmera; negações/liberações de canal
  são copiadas). Verificado no banco de desenvolvimento.
- `VoiceParticipantState.camera = { streamId, startedAt } | null`; operações `camera_on` / `camera_off`.
- Permissão verificada no servidor a cada `camera_on`; sem VIDEO → `STREAM_ERROR` com `kind: 'camera'`
  e nada é anunciado. Perder VIDEO durante a chamada desliga a câmera na hora (revalidação).
- Em chamada privada (DM) os dois podem usar câmera.
- Ids de mídia validados no servidor (`MEDIA_STREAM_ID_RE`); mensagem malformada fecha a conexão.

### Mídia (cliente)
- A malha P2P foi generalizada: tela e câmera são "tipos de mídia" com transceptores próprios,
  reaproveitados ao desligar/religar. Cada tipo usa um MediaStream contêiner com **id estável**, que
  é anunciado ao servidor; quem recebe distingue câmera de tela por esse id (verificado: o id chega
  idêntico do outro lado e não muda ao trocar de câmera).
- Câmera vai para todos da sala (como a voz); a tela continua indo só para quem assiste.
- Qualidade: **360p** (padrão, até 600 kbps) ou **720p** (até 1,5 Mbps), 30 FPS. Restrições "ideal"
  (abre mesmo em câmeras limitadas); se a câmera entregar mais (ex.: 1080p fixo), o codificador reduz.
  `degradationPreference: balanced`, prioridade de rede baixa (voz passa na frente).
- Câmera escolhida que sumiu → tenta a padrão e avisa. Câmera desconectada no meio da chamada →
  desliga e avisa. Erros do sistema viram mensagens claras (negado, inexistente, em uso).
- Sair da chamada, perder a permissão ou desligar **param a faixa** (a luz da câmera apaga).
- Estatísticas reais de envio por pessoa (`cameraSend`) e de recepção por stream (`mediaRecv`).
- Correção junto: as estatísticas de voz agora contam só a m-line do microfone (o áudio da tela
  não distorce mais perda/jitter da voz).

### Interface
- Botão de câmera no painel de voz (verde quando ligada; sem permissão, o botão diz isso).
- Quadro do participante mostra o vídeo no lugar do avatar; a própria prévia pode ser espelhada
  (só na sua tela — os outros recebem a imagem normal). Câmera nunca toca áudio.
- Configurações → Voz e vídeo → **Câmera**: dispositivo (fica só neste computador, como pede o
  VYRON 5.3), qualidade, espelhar, e **testar câmera** com prévia local mostrando a resolução/FPS
  que a câmera realmente entrega. Fechar a tela libera a câmera do teste.

## Testes
- Automatizados: **196 passando** (protocolo 30, desktop 70, servidor 96); typecheck limpo; build OK.
  - Servidor (4 novos): liga/desliga anuncia; sem VIDEO recusa câmera mas tela continua permitida;
    perder VIDEO desliga na hora; id malformado fecha a conexão.
  - Cliente (4 novos): restrições, redução no codificador, mensagens de erro, preferências locais
    (inclusive valores corrompidos voltando ao padrão).
- **WebRTC real no Chromium** (três malhas, fontes = canvas): A com câmera (para todos) e tela (só
  para B), B com câmera. B recebeu câmera e tela de A separadas pelo id; C recebeu só a câmera; câmera
  1080p reduzida para 360p (~360 kbps). Desligar → nada enviado, faixa do outro lado `muted`;
  religar com outra fonte → mesmo id, mesmo transceptor, imagem de volta.
- **App completo com duas contas**: botão "Ligar câmera" nas duas → confirmação do servidor → cada
  lado vê a câmera do outro no quadro (640×360, latência estimada ~10 ms, rede local) e a própria
  prévia espelhada. Negar VIDEO no canal durante a chamada → a câmera da conta sem permissão desligou
  sozinha, com aviso, e o botão passou a dizer "Sem permissão". O ajuste de canal foi removido depois.

### Observação do ambiente de teste
Uma aba do navegador de desenvolvimento que nunca foi exibida não completou a coleta de candidatos
ICE (ficou em "gathering" sem candidatos); depois de exibida, sair e entrar de novo conectou
normalmente. Uma conexão nova criada na mesma aba coletava normalmente, então tratamos como limitação
do painel de pré-visualização — mas fica anotado para conferir em PCs reais.

## O que NÃO foi testado (e por quê)
- **Câmera física**: o navegador do ambiente bloqueia dispositivos; no teste do app, só o
  `getUserMedia` de vídeo foi substituído por um canvas — botão, servidor e WebRTC foram reais.
- **Tauri/WebView2**: não compilado (sem Rust).
- **Dois PCs pela internet**: só testes locais.

## Limites desta versão
- P2P: cada pessoa envia uma cópia da câmera para cada participante (até 7). Com 8 pessoas em 720p,
  o envio chega a ~10 Mbps — por isso 360p é o padrão. Grades grandes exigem SFU.
- Sem adaptação própria do app para a câmera: fica com o controle de congestionamento do navegador.
- Sem fundo desfocado/substituição de fundo e sem opção "não receber câmeras" (para economizar banda
  de quem recebe) — candidatos para a próxima rodada.
