# Dev image for both Node workspaces on nid-dev.
#
# It installs the whole workspace dependency tree (devDependencies included —
# tsx and vite live there) and nothing else: sources arrive through bind mounts
# from the repository root, and an anonymous volume keeps /repo/node_modules
# from being shadowed by them. The production image is apps/server/Dockerfile.
#
# After a dependency or Dockerfile change, renew that anonymous volume:
#   docker compose up -d --build -V

FROM node:22-alpine

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci

CMD ["npm", "run", "dev", "-w", "@rnm/overseer-server"]
