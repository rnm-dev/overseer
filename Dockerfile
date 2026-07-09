# Overseer (dev). Installs deps incl. tsx/typescript; runs `npm run dev` (tsx watch).
# src/ is bind-mounted by docker-compose, so this image is just the runtime + deps.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
EXPOSE 5000
CMD ["npm", "run", "dev"]
