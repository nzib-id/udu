FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY shared /shared
COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY frontend/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY frontend/server.mjs ./server.mjs
COPY --from=build /app/dist ./dist
EXPOSE 4246
CMD ["node", "server.mjs"]
