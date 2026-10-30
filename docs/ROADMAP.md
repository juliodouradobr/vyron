# Roadmap, riscos e limitações

## Etapas

| Etapa | Escopo | Estado |
|---|---|---|
| 1 — Fundação | monorepo, protocolo compartilhado, backend, migrações, autenticação completa, gateway com heartbeat, design system, login e layout principal, shell Tauri | **implementada** (ver `docs/STAGE1_REPORT.md`) |
| 2 — Social | perfis, amigos, bloqueios, DMs, servidores, canais, cargos, permissões, convites, chat | **implementada** (ver `docs/STAGE2_REPORT.md`) |
| 3 — Voz | canais de voz, chamadas privadas, mute/deafen reais, VAD/PTT, Opus adaptativo, TURN, diagnóstico | **implementada** — P2P até 8 pessoas; áudio real ainda não testado (ver `docs/STAGE3_REPORT.md`) |
| 4 — Ruído | RNNoise local em AudioWorklet, 7 modos, automático por SNR, fallback por CPU, A/B, bancada SI-SDR com regressão | **implementada** — validada com fala sintética; falta avaliação com fala real (ver `docs/STAGE4_REPORT.md`) |
| 5 — Transmissão | captura de tela/janela/aba, qualidade escolhida (360p–2160p, 15/30/60 FPS), adaptação por espectador, estatísticas reais, permissão STREAM | **implementada** — vídeo só para quem assiste (P2P, até 7 espectadores); seletor real do sistema e WebView2 ainda não testados (ver `docs/STAGE5_REPORT.md`). Simulcast/SFU ficam para quando houver SFU. |
| 5b — Câmera (VYRON 8.4) | câmera em canais de voz e chamadas, 360p/720p, permissão VIDEO, prévia e teste | **implementada** — câmera física não testada neste ambiente (ver `docs/CAMERA_REPORT.md`) |
| 5c — Arquivos (VYRON 5.2/6.3) | anexos em mensagens, avatar e banner, detecção de tipo pelo conteúdo, remoção de metadados, download com permissão | **implementada** (ver `docs/FILES_REPORT.md`); sem antivírus no servidor |
| 5d — Notificações (VYRON 12) | avisos do sistema e sons, regras por categoria/servidor, silenciar com prazo, "Não perturbe", caixa de menções, contagem no título | **implementada** (ver `docs/NOTIFICATIONS_REPORT.md`); aviso nativo do Windows escrito, não compilado |
| Distribuição | app escolhe o servidor na entrada (só HTTPS), CSP do app corrigida, ícones, servidor em Docker (Postgres, Caddy/HTTPS, coturn), backups, instalador Windows via GitHub Actions | **pronta para usar** (ver `docs/DEPLOY.md`); Docker e o build do instalador ainda não executados de verdade |
| 6 — Jogar Juntos | pedido e aprovação, permissões por tipo de entrada, prazo, revogação imediata, guarda de entradas | **parcial** — fluxo completo testado no navegador (entradas só exibidas); injeção nativa no Windows escrita mas **não compilada nem testada**; sem gamepad e sem mouse relativo (ver `docs/REMOTE_PLAY_REPORT.md`) |
| 7 — Acabamento | notificações, bandeja, atualizador assinado, instalador, acessibilidade, testes em 2 PCs | pendente |

## Principais riscos técnicos

1. **NAT/firewall** — conexões diretas falham em parte das redes. Mitigação: SFU + TURN (TCP/TLS 443).
2. **Supressão de ruído vs. naturalidade** — RNNoise remove bem ruído estacionário e teclado, mas
   pode cortar consoantes e não remove bem fala de fundo/TV. Mitigação: modos graduados, VAD com
   histerese, bancada de regressão SI-SDR + escuta. Limitação real a documentar, não a prometer.
3. **Captura de jogos** — jogos em tela cheia exclusiva e anti-cheat podem bloquear captura ou
   injeção de entrada. Windows Graphics Capture mostra borda amarela (indicador do SO, respeitado).
4. **Entrada remota** — `SendInput` não pode ser restrita perfeitamente a uma janela; mitigação é
   verificar a janela em primeiro plano antes de cada injeção e pausar ao perder o foco. UIPI impede
   injetar em processos elevados sem elevação — **não** elevaremos por padrão.
5. **Custo de CPU do WebView + WebRTC** em máquinas modestas. Mitigação: modo economia, AudioWorklet
   fora da thread de UI, listas virtualizadas, medição real antes de definir metas.
6. **E2EE** — não está no escopo inicial. Mídia é criptografada em trânsito (DTLS-SRTP) mas o SFU
   tem acesso a ela. Não declararemos E2EE sem implementação e validação.

## Limitações conhecidas deste ambiente

- Sem Rust/Cargo: o shell Tauri foi escrito mas **não compilado** aqui. Instale Rust para gerar o `.exe`.
- Sem PostgreSQL/Docker: todos os testes rodaram contra PGlite (Postgres 17 em WASM).
  `docker-compose.yml` está pronto para Postgres real.
