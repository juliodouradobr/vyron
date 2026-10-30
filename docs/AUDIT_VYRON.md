# Auditoria — estado real do projeto frente à especificação VYRON

Data: 2026-10-25. O projeto foi construído até aqui com o nome provisório **Nexo**; a especificação
VYRON o substitui. Nada foi descartado: esta auditoria mapeia o que existe para as seções do VYRON.

## Tecnologias em uso

| Camada | Tecnologia | Observação |
|---|---|---|
| Desktop | Tauri 2 (Rust) + React 18 + TypeScript + Vite 7 + Zustand | Shell Rust **compila** (instalador gerado pelo GitHub Actions em 30/10/2026); uso real no Windows ainda a testar. |
| Backend | Node.js + TypeScript + Fastify 5 + WebSocket | Processo único, modular por domínio. |
| Banco | PostgreSQL (produção) / PGlite (dev e testes) | 2 migrações versionadas. |
| Mídia | WebRTC P2P em malha (até 8), Opus, RNNoise local em AudioWorklet | Sem SFU, sem TURN configurado. |
| Redis | **não usado** | Presença e salas de voz em memória: não escala além de 1 processo. |

## Testes (executados)
153 automatizados passando: protocolo 21, desktop 49, servidor 83 (PostgreSQL real via PGlite +
WebSocket real). Bancada de ruído com regressão. Verificações manuais no navegador por etapa.

## Mapa por seção do VYRON

| Seção | Estado | Detalhe |
|---|---|---|
| 4 Identidade visual / navegação | ✅ funcional | Tokens, temas claro/escuro/sistema, alto contraste, movimento reduzido, layout responsivo. **Marca ainda é "Nexo".** |
| 5.1 Cadastro/entrada/sessões | ✅ funcional | Argon2id, tokens opacos revogáveis, sessões ativas, bloqueio por tentativas, rate limit, códigos de recuperação. |
| 5.1 Identificador `Name#00000` | ✅ implementado | Migração `003_tags.sql`: discriminador 00001–99999 sorteado pelo servidor (aleatório, não sequencial), único por (nome sem distinção de maiúsculas, número). Nome preserva maiúsculas, aceita acentos (NFC), sem espaço/#/@. Login, recuperação e pedido de amizade aceitam `Nome#00000`, ou só o nome quando há uma única conta com ele (senão `AMBIGUOUS_USERNAME`). Menções viram `@Nome#00000`. Contas antigas receberam número na migração (verificado no banco de dev). |
| 5.2 Perfil | 🟡 parcial | Nome, bio, status, **avatar e banner** (metadados removidos, download com login). Falta status personalizado e atualização em tempo real do perfil para outras pessoas. |
| 5.3 Sincronização | ✅ funcional | Preferências no backend com padrões. Dispositivos de áudio também sincronizam (o VYRON pede para não sincronizar hardware) → ajustar. |
| 6.1 Amigos/bloqueio | ✅ funcional | Inclui privacidade de pedidos e de DMs. |
| 6.2 Mensagens | 🟡 parcial | DMs 1:1, respostas, reações, edição, exclusão, menções, busca, não lidas, idempotência. **Sem grupos, sem fixar.** |
| 6.3 Anexos | ✅ implementado | Até 10 por mensagem, 10 MB cada; tipo detectado pelo conteúdo (SVG/HTML nunca como imagem/página); EXIF/GPS removidos; download só com login e permissão no canal; colar/arrastar/progresso. Sem antivírus no servidor. Ver `docs/FILES_REPORT.md`. |
| 6.4 Busca global | 🟡 parcial | Só por canal. |
| 7 Servidores/cargos/permissões | ✅ funcional | Hierarquia, overwrites, anti-escalonamento testado, convites, auditoria. **Sem banimento, sem servidores públicos/descoberta.** |
| 8.1–8.3 Voz | ✅ funcional (sem áudio real testado) | Canais de voz, chamadas DM, volume por pessoa, VAD/PTT, reconexão, diagnóstico. |
| 8.2 Supressão de ruído | ✅ funcional | RNNoise local, 7 modos, A/B, bancada (fala sintética). |
| 8.4 Vídeo (câmera) | ✅ implementado | Botão na chamada, 360p/720p, permissão própria VIDEO (verificada e revalidada no servidor), escolha de câmera só no computador, prévia espelhada opcional, teste nas configurações. Testado com WebRTC real e duas contas; câmera física ainda a conferir num PC (ver `docs/CAMERA_REPORT.md`). |
| 8.5 SFU | ❌ ausente | P2P até 8; limitação documentada. |
| 9.1–9.2 Compartilhamento de tela | ✅ implementado | Tela/janela/aba via seletor oficial, 360p–2160p × 15/30/60 FPS, escolhido × real com motivos, adaptação por espectador, permissão STREAM no servidor, vídeo só para quem assiste. Testado com WebRTC real e duas contas; seletor real do sistema e WebView2 ainda a conferir num PC. |
| 9.4–9.5 Remote Play | 🟡 parcial | Autorização explícita no servidor (pedido, tipos de entrada, prazo, revogação, atalho de emergência), canal P2P de entradas, guarda que bloqueia atalhos do sistema. Testado com duas contas no navegador, onde as entradas só são exibidas. Injeção no Windows (Rust, só na janela escolhida e em primeiro plano) compila, mas não foi testada em uso. Falta gamepad e mouse relativo. Ver `docs/REMOTE_PLAY_REPORT.md`. |
| 10 Recursos gamer | ❌ ausente | Atividade, eventos, torneios. |
| 11 Soundboard | ❌ ausente | |
| 12 Notificações | ✅ implementado | Avisos do sistema (navegador; nativo no app para Windows — compila, não testado em uso), sons, regras por categoria, padrão e ajuste por servidor, silenciar canal/servidor com prazo, "Não perturbe", caixa de entrada de menções (com checagem de acesso), contagem de menções e título "(N) VYRON". Ver `docs/NOTIFICATIONS_REPORT.md`. |
| 13 Site oficial | ❌ ausente | Não haverá links de download até existir um instalador real. |
| 14 Segurança | 🟡 sólido na base | Falta: notificações de segurança, retenção, CSP revisada para mídia. |
| 18–20 Mobile | ❌ ausente | Fase posterior. |
| Desktop empacotado | ❌ não verificado | Sem Rust/instalador nesta máquina. |

## Recursos apenas visuais
Nenhum botão finge funcionar: itens futuros aparecem desabilitados com a etapa indicada
("Jogar Juntos", "Explorar comunidades", "Atalhos").

## Dependências de infraestrutura
TURN (coturn) para redes restritivas; SFU para salas grandes; Redis para mais de um processo;
Rust + certificado de assinatura para o instalador; contas de desenvolvedor para lojas mobile.

## Prioridade das próximas tarefas
1. ~~Marca VYRON na interface~~ — feito.
2. ~~Identificador `Name#00000`~~ — feito (167 testes passando; ver tabela acima).
3. ~~Compartilhamento de tela/janela com qualidade selecionável e estatísticas reais~~ — feito (ver `docs/STAGE5_REPORT.md`; falta conferir o seletor real do sistema num PC).
4. ~~Câmera~~ — feito (ver `docs/CAMERA_REPORT.md`). 5. Remote Play — parcial (falta compilar/testar o núcleo nativo, gamepad e mouse relativo); 6. ~~Anexos/avatares~~ — feito (ver `docs/FILES_REPORT.md`); 7. ~~Notificações~~ — feito (ver `docs/NOTIFICATIONS_REPORT.md`); 8. Grupos/fixar/ban.
