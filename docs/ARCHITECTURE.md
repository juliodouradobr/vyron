# Nexo — Arquitetura

Nexo é uma plataforma desktop de comunicação para gamers: comunidades, chat, voz com
supressão de ruído local, transmissão de tela e sessões remotas autorizadas ("Jogar Juntos").
A organização da interface é familiar a quem usa Discord, mas a identidade visual, o código
e os nomes são próprios.

## Visão geral

```
┌──────────────────────── Cliente desktop (Windows) ────────────────────────┐
│  WebView (React + TS + Vite)            │  Núcleo nativo (Rust / Tauri 2)  │
│  ─ telas, stores, design system         │  ─ cofre de credenciais (DPAPI)  │
│  ─ cliente REST + gateway WebSocket     │  ─ bandeja, notificações, atalhos│
│  ─ WebRTC (voz/vídeo) + AudioWorklet    │  ─ captura WGC / entrada remota  │
│        (RNNoise WASM)                   │    (etapas 5–6, sob autorização) │
│            ▲   invoke() somente para comandos na allowlist (capabilities)  │
└────────────┼───────────────────────────────────────────────────────────────┘
             │ HTTPS / WSS
┌────────────▼───────────── Backend (Node.js + TypeScript) ─────────────────┐
│ REST /api/v1  (Fastify)    Gateway /gateway (WebSocket)    Sinalização RTC │
│ auth · users · friends · servers · channels · messages · sessions remotas  │
│ camada de segurança: hash Argon2id, tokens opacos revogáveis, rate limit,  │
│ validação zod em todas as rotas, autorização sempre no servidor            │
└────────────┬───────────────────────────────┬──────────────────────────────┘
             │                               │
      PostgreSQL (prod)              SFU de mídia (etapa 3+: LiveKit/mediasoup)
      PGlite (dev/testes)            + TURN (coturn) para NAT/firewall
```

## Componentes e responsabilidades

| Componente | Onde | Responsabilidade |
|---|---|---|
| Frontend | `apps/desktop/src` | Telas, navegação, estado de UI. Nunca decide permissões — só reflete o que o backend autoriza. |
| Núcleo nativo | `apps/desktop/src-tauri` | APIs privilegiadas do SO. Expostas apenas por comandos explícitos listados em `capabilities/`. |
| Protocolo | `packages/protocol` | Tipos, esquemas zod, códigos de erro, opcodes do gateway e o cálculo de permissões — compartilhado entre cliente e servidor. |
| Backend | `apps/server` | Contas, sessões, presença, e (próximas etapas) amizades, servidores, mensagens, sinalização. |
| Banco | `apps/server/migrations` | Migrações SQL versionadas e idempotentes. |
| Serviço de voz | etapa 3 | SFU dedicado; o backend emite tokens de sala de curta duração após checar permissões. |
| Motor de áudio | etapa 4 | Cadeia: captura → AEC/AGC do WebRTC → RNNoise (WASM, local) → limitador → Opus. |
| Motor de transmissão | etapa 5 | `getDisplayMedia` / Windows Graphics Capture, codificação por hardware quando disponível. |
| Motor de sessão remota | etapa 6 | Convites temporários, aprovação explícita do anfitrião, injeção de entrada só na janela autorizada. |

## Decisões técnicas (ADR resumido)

1. **Backend em Node.js + TypeScript (Fastify)** em vez de Rust: compartilha tipos e validação com o
   frontend, iteração mais rápida; o caminho quente de mídia não passa por ele (vai para o SFU).
2. **PostgreSQL em produção, PGlite em dev/testes.** PGlite é o Postgres real compilado para WASM, então
   as mesmas migrações e queries rodam em ambos. Selecionado por `DATABASE_URL`.
3. **Tokens de sessão opacos** (32 bytes aleatórios), armazenados no banco apenas como SHA-256.
   Revogação é imediata (inclusive derruba conexões WebSocket abertas). Expiração deslizante de 30 dias.
   JWT foi descartado: não é revogável sem lista de bloqueio.
4. **Argon2id** (`@node-rs/argon2`, MIT, binários pré-compilados para Windows) com parâmetros OWASP:
   m=19 MiB, t=2, p=1. Senhas limitadas a 128 caracteres para evitar abuso de CPU.
5. **Recuperação de acesso por códigos de recuperação** (10 códigos de uso único, mostrados uma vez,
   guardados com hash). Não exige servidor de e-mail; e-mail pode ser acrescentado depois.
6. **Login informa "conta inexistente"** (exigência de UX). Nomes de usuário já são públicos (aparecem em
   perfis e no cadastro), então o vazamento adicional é pequeno; a proteção contra força bruta vem do
   rate limit por IP + bloqueio temporário por conta após 5 falhas.
7. **Avatar sem URL externa arbitrária**: carregar imagens de terceiros vazaria o IP de quem visualiza.
   Avatares serão enviados ao próprio backend (etapa 2); até lá usamos iniciais + cor derivada.
8. **Token no cliente**: no Tauri, guardado no Gerenciador de Credenciais do Windows (crate `keyring`,
   MIT/Apache). No navegador de desenvolvimento, `localStorage` (documentado como só-dev).
9. **Permissões como bitfield** (`packages/protocol/src/permissions.ts`), com resolução documentada:
   base `@everyone` → OR dos cargos → overwrites de canal (cargos, depois membro: deny antes de allow) →
   `ADMINISTRATOR` e proprietário ignoram overwrites.

10. **Voz em P2P (malha) na v1, até 8 pessoas** — sinalização pelo gateway, autorização e reavaliação
    no servidor, TURN opcional com credenciais temporárias para ocultar IP. Troca futura por SFU
    isolada em `apps/desktop/src/voice/PeerMesh.ts`. Detalhes e limitações em `docs/STAGE3_REPORT.md`.
11. **Estado efêmero (presença, salas de voz) vem por retrato + eventos**: o retrato é refeito a cada
    READY do gateway e eventos recebidos durante a busca prevalecem sobre ele.

12. **Supressão de ruído: RNNoise instanciado direto do WASM** (sem a "cola" do Emscripten) para rodar
    igual no AudioWorklet, no thread principal (A/B) e no Node (bancada). O build da Shiguredo foi
    descartado porque só roda em `window`/Worker (nem AudioWorklet, nem Node). GTCRN, mais recente,
    fica como candidato: o WASM disponível tem API minificada. Detalhes em `docs/STAGE4_REPORT.md`.

## Licenças das dependências principais

| Dependência | Licença | Uso |
|---|---|---|
| Tauri 2 | MIT / Apache-2.0 | shell desktop |
| React, Vite, Zustand | MIT | interface |
| Fastify e plugins | MIT | API |
| zod | MIT | validação |
| @electric-sql/pglite | Apache-2.0 / PostgreSQL | banco dev/testes |
| pg (node-postgres) | MIT | banco produção |
| @node-rs/argon2 | MIT | hash de senha |
| RNNoise (Xiph.Org) | BSD-3-Clause | supressão neural local |
| rnnoise-wasm (Shiguredo, build WASM) | Apache-2.0 | binário WebAssembly do RNNoise |
| @sapphi-red/web-noise-suppressor | MIT | distribui os .wasm (usamos só os binários) |
| LiveKit server (etapa 3, candidato) | Apache-2.0 | SFU |
