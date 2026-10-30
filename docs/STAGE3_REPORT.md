# Relatório — Etapa 3 (Voz)

Data: 2026-10-25.

## Decisão de arquitetura

**WebRTC P2P em malha, até 8 pessoas por sala**, com sinalização pelo gateway existente e toda
autorização no servidor. Escolhida porque roda sem infraestrutura extra e dá a menor latência
possível para grupos pequenos. O transporte fica isolado (`PeerMesh`) para ser trocado por um SFU
(LiveKit, Apache-2.0) sem mudar a interface nem o protocolo de salas.

Limitações reais desta topologia (não escondidas):
- **IP visível** para quem está na mesma chamada. Mitigação: opção "Ocultar meu IP", que força
  relay TURN; o servidor emite credenciais TURN temporárias (padrão TURN REST API / coturn
  `use-auth-secret`), e o segredo nunca sai do servidor.
- **"Falar" não é imposto no transporte**: o servidor nega entrada sem CONNECT_VOICE e marca
  quem não tem SPEAK como suprimido; os demais clientes não reproduzem esse áudio. Um cliente
  modificado poderia enviar áudio mesmo assim — imposição real exige SFU.
- Upload cresce com o número de pessoas (cada um envia para todos). Por isso o teto de 8.

## Implementado

**Servidor**
- Registro de salas em memória; uma chamada por pessoa (entrar em outra sala, ou por outro
  dispositivo, encerra a anterior); saída automática quando a conexão cai.
- Autorização: canal de voz + CONNECT_VOICE; SPEAK define "suprimido"; DMs só entre os dois
  participantes e nunca com bloqueio; não-membros recebem "não encontrado".
- **Reavaliação ao vivo**: mudar cargos/overwrites, expulsar ou excluir o servidor tira a pessoa da
  sala ou atualiza "suprimido" na hora.
- Sinalização retransmitida só entre duas pessoas da mesma sala, conexão a conexão, com o remetente
  carimbado pelo servidor; SDP limitado a 12 kB; limite de taxa próprio para candidatos ICE.
- Chamadas privadas: tocar, recusar (sem abrir mídia), atender.
- `GET /voice/states` com só as salas visíveis ao usuário.

**Cliente**
- Captura com AEC/AGC/supressão clássica do WebRTC (configuráveis), ganho de entrada, medidor.
- **Microfone desligado = faixa desabilitada na origem**: nenhum áudio capturado sai.
- Ativação por voz com histerese (abre rápido, fecha 0,4 s após o silêncio) e push-to-talk.
- Opus ajustado no SDP: FEC, DTX, mono, teto de 40 kbps; **bitrate adaptativo** 16–40 kbps pela
  pior conexão da sala (desce rápido, sobe devagar).
- Negociação perfeita (sem travar em colisão de ofertas), reinício de ICE em falha, volta
  automática à sala após reconexão do gateway.
- Volume por pessoa (até 200%, salvo nas preferências), volume de saída, ensurdecer, troca de
  dispositivo de saída, troca de microfone sem renegociar, e **queda para o padrão quando o headset
  é desconectado**.
- **Modo só ouvir** quando não há microfone ou o acesso é negado.
- Interface: quem está em cada sala na barra lateral (com anel de fala e ícones de mute/deafen/
  suprimido), sala de voz com blocos e volume, painel "Voz conectada" com ping, diagnóstico com
  latência/jitter/perda/bitrate/rota (local, direta ou relay), chamada recebida (atender/recusar),
  faixa de chamada na DM, sons curtos de entrar/sair/mute, indicador de microfone transmitindo.
- Configurações de Voz e vídeo: dispositivos, volumes, modo, tecla do PTT, limiar com teste de
  microfone ao vivo (e opção de ouvir a própria voz), processamento, "ocultar meu IP", restaurar.

## Testes (resultados reais)

| Suíte | Resultado |
|---|---|
| servidor — voz (autorização, retransmissão, queda, revogação, DMs, TURN) | 12/12 ✅ |
| desktop — Opus/SDP, adaptação de bitrate, portão VAD/PTT, corrida retrato×evento | 12 novos ✅ |
| total do projeto | **148/148** ✅ · `tsc` e `vite build` ok |

### Verificação manual (duas contas, duas abas com origens distintas)
- Entrar no canal de voz pela barra lateral; a outra conta vê a pessoa na sala em tempo real.
- **Conexão WebRTC real estabelecida** entre as duas: `connected`, 2 ms de latência, 5 ms de jitter,
  0% de perda, rota local; ~1 kbps em silêncio (DTX funcionando).
- Chamada privada: tocou do outro lado, "Chamando…", atendida, os dois na chamada.
- **Áudio real não foi testado**: o painel de navegador desta sessão bloqueia o microfone. Por isso
  as duas contas entraram no modo só ouvir. Falta testar voz de verdade, eco, ruído e entre dois
  computadores — isso exige o app rodando fora do painel (navegador comum ou o executável Tauri).

### Bugs encontrados e corrigidos nesta etapa
1. Sem microfone, era impossível entrar na sala → modo "só ouvir".
2. Retrato REST de presenças/salas podia sobrescrever eventos mais novos (a amiga aparecia offline
   estando online) → retrato recarregado quando o gateway fica pronto e eventos recentes vencem.
3. Dicas (tooltips) alargavam contêineres e o foco rolava a barra lateral → dicas em portal com
   posição fixa, contidas na janela.
4. Corrida no teste de troca de sala (teste corrigido; o comportamento estava certo).

## Não feito / próximos passos
- Supressão neural (RNNoise) e comparação original × processado → **Etapa 4**.
- Câmera (vídeo) e compartilhamento de tela → Etapa 5.
- SFU para salas grandes e imposição de SPEAK no transporte.
- Atalho global de push-to-talk (exige o núcleo nativo; hoje funciona com o app em foco).
- Notificação do sistema para chamada recebida (hoje: cartão + toque dentro do app).
- Medições de CPU/memória da chamada — nenhum número de desempenho é afirmado.
