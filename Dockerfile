# Imagem do servidor VYRON (API + gateway em tempo real).
# Só o necessário para o servidor: o app desktop não entra aqui.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependências primeiro (camada reaproveitada enquanto o package-lock não muda).
# O npm confere o lockfile com todos os workspaces, então os package.json de todos vêm junto,
# mas só as dependências do servidor e do protocolo são instaladas.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
# --include=dev: o servidor roda TypeScript direto com tsx (dependência de desenvolvimento).
RUN npm ci --include=dev -w @nexo/server -w @nexo/protocol --no-audit --no-fund \
 && npm cache clean --force

COPY packages/protocol packages/protocol
COPY apps/server apps/server

# Arquivos enviados (anexos, avatares) ficam num volume; o processo não roda como root.
RUN mkdir -p /data/files && chown -R node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=4100 \
    FILES_DIR=/data/files

EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "-w", "@nexo/server"]
