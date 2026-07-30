# syntax=docker/dockerfile:1
#
# Built from the repository root, not from this directory: npm workspaces keep a
# single lockfile there, so the build context has to include it. Kamal passes
# `context: ../..` (see config/deploy.yml).

FROM node:22-alpine AS build

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci

COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN npm run compile -w @rnm-dev/overseer-server
RUN npm run build -w @rnm-dev/overseer-web

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    OVERSEER_HOST=0.0.0.0 \
    OVERSEER_PORT=5000

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci --omit=dev --workspace @rnm-dev/overseer-server --include-workspace-root \
    && npm cache clean --force

# The server resolves its static assets as path.resolve("web/dist") against the
# working directory, so the runtime layout stays /app/dist + /app/web/dist.
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web/dist

RUN mkdir -p /data/releases \
    && chown -R node:node /app /data/releases

USER node

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
