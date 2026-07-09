# Overseer web (dev). Installs deps and runs the Vite dev server (HMR).
# src is bind-mounted by docker-compose, so this image is just runtime + deps.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
