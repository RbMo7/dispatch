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
RUN corepack enable
ENV NODE_ENV=production
COPY signer/package.json signer/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
# Development keys and the config naming their addresses. Only Compose points
# SIGNER_CONFIG and SIGNER_KEYFILE at them; the image sets neither, so a
# deployment that forgets its own config refuses to start instead of signing
# with these.
COPY signer/keys.dev.json signer/signer.config.dev.json ./
CMD ["node", "dist/index.js"]
