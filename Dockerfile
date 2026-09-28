# A single image: the Nitro server serves the app pages and our /api (docs/ARCHITECTURE.md).
# Configuration is done via environment only at runtime (NUXT_PUBLIC_SITE_URL is also read at runtime),
# so one image works for any server. Variables — .env.example, deploy — docs/DEPLOY.md.

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
# Portal install tokens (Nitro fs storage, `nitro.storage.portals`) — a volume is mounted here.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
# Build commit for GET /api/health (`commit`). Set by the deploy job in CI; empty in a local
# build — health returns null. Placed last: it changes on every commit and doesn't bust the layer cache.
ARG COMMIT_SHA=""
ENV COMMIT_SHA=$COMMIT_SHA
CMD ["node", ".output/server/index.mjs"]
