FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @nova/api build

FROM node:22-alpine
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
