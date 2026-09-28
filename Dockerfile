# Один образ: Nitro-сервер отдаёт страницы приложения и наш /api (docs/ARCHITECTURE.md).
# Конфигурация — только окружением во время запуска (NUXT_PUBLIC_SITE_URL тоже читается в рантайме),
# поэтому один образ годится для любого сервера. Переменные — .env.example, выкат — docs/DEPLOY.md.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/.output ./.output
# Токены установки порталов (fs-хранилище Nitro, `nitro.storage.portals`) — сюда монтируется том.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
# Коммит сборки для GET /api/health (`commit`). Задаёт джоба deploy в CI; в локальной сборке
# пусто — health вернёт null. Стоит последним: меняется на каждом коммите и не сбивает кэш слоёв.
ARG COMMIT_SHA=""
ENV COMMIT_SHA=$COMMIT_SHA
CMD ["node", ".output/server/index.mjs"]
