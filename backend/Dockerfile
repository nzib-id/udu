FROM node:22-bookworm-slim AS deps
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/tsconfig.json ./tsconfig.json
COPY backend/src ./src
COPY shared /app/shared
COPY data/migrations /app/data/migrations
EXPOSE 4247
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
