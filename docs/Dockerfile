FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY docs ./docs
RUN npx vitepress build docs

FROM nginx:alpine AS runtime
COPY --from=build /app/docs/.vitepress/dist /usr/share/nginx/html
COPY docs/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
