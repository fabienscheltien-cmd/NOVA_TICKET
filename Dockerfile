FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@nova/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @nova/shared build && pnpm --filter @nova/api build

FROM node:22-bookworm-slim
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod --frozen-lockfile --filter "@nova/api..."
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# Migrations SQL : le CLI (node dist/src/db/cli.js migrate) les lit dans /app/db/migrations
COPY db /app/db
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
