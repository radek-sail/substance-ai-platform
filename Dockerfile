FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json pnpm-workspace.yaml tsconfig*.json ./
COPY src/shared/package*.json ./src/shared/
COPY src/server/package*.json ./src/server/
COPY src/client/package*.json ./src/client/

RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY config ./config
COPY src ./src

RUN pnpm build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server/dist/server.js"]