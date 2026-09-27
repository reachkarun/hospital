FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci && npm run build:shared && npm run build -w @rounding/gateway && npm prune --omit=dev

FROM node:22.19.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/gateway/dist ./services/gateway/dist
COPY --from=build --chown=node:node /app/services/gateway/package.json ./services/gateway/package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "services/gateway/dist/main.js"]
