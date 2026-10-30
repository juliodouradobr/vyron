# Nexo

Plataforma desktop de comunicação para gamers: comunidades, chat, voz com supressão de ruído
local, transmissão e sessões remotas autorizadas ("Jogar Juntos"). Interface familiar a quem usa
Discord, com identidade própria.

> **Estado:** Etapa 1 (Fundação) concluída. Não está pronto para produção.
> Veja [docs/ROADMAP.md](docs/ROADMAP.md) e [docs/STAGE1_REPORT.md](docs/STAGE1_REPORT.md).

## Estrutura

```
apps/
  desktop/            React + TypeScript + Vite (interface)
    src-tauri/        núcleo nativo Rust / Tauri 2 (cofre de credenciais, bandeja)
  server/             API REST + gateway WebSocket (Fastify, Node.js)
    migrations/       migrações SQL versionadas
packages/
  protocol/           tipos, validação (zod), opcodes do gateway e permissões compartilhados
docs/                 arquitetura, roadmap, relatórios de etapa
```

## Rodando em desenvolvimento

Requisitos: Node.js 20+. Para o executável Windows, também Rust (rustup) e o WebView2.

```bash
npm install
```

```bash
npm run dev:server
```

```bash
npm run dev:desktop
```

- API e gateway: `http://127.0.0.1:4100` (sem `DATABASE_URL`, usa PGlite em `apps/server/.data/`).
- Interface no navegador: `http://127.0.0.1:5173`.
- Para PostgreSQL real: `docker compose up -d` e defina `DATABASE_URL` em `apps/server/.env`
  (modelo em `.env.example`).

### Aplicativo desktop (Tauri)

Com Rust instalado, gere os ícones uma vez e rode o shell nativo:

```bash
npm run tauri -w @nexo/desktop -- icon caminho/para/logo-1024.png
```

```bash
npm run tauri -w @nexo/desktop -- dev
```

## Testes

```bash
npm test
```

```bash
npm run typecheck
```

Os testes do servidor rodam contra Postgres de verdade (PGlite em memória), não contra mocks.

## Documentação

- [Arquitetura e decisões](docs/ARCHITECTURE.md)
- [Roadmap, riscos e limitações](docs/ROADMAP.md)
- [Relatório da Etapa 1](docs/STAGE1_REPORT.md)
