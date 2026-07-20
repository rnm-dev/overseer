# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run compile

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    OVERSEER_HOST=0.0.0.0 \
    OVERSEER_PORT=5000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data/releases \
    && chown -R node:node /app /data/releases

USER node

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
