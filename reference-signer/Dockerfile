FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY reference-signer/package.json reference-signer/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY reference-signer/tsconfig.json reference-signer/tsconfig.build.json ./
COPY reference-signer/src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY reference-signer/keys.dev.json ./keys.dev.json
CMD ["node", "dist/index.js"]
