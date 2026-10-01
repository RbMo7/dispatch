FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY signer/package.json signer/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY signer/tsconfig.json signer/tsconfig.build.json ./
COPY signer/src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY signer/keys.dev.json ./keys.dev.json
CMD ["node", "dist/index.js"]
