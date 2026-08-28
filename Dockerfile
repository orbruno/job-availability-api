FROM node:24.19.0-bookworm-slim AS node-pinned

RUN npm install --global npm@11.6.2 --ignore-scripts && test "$(npm --version)" = "11.6.2"

FROM node-pinned AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY schemas ./schemas
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node-pinned AS runtime

LABEL org.opencontainers.image.authors="Orlando Bruno" \
      org.opencontainers.image.description="Private self-hosted API for deterministic job-availability monitoring" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/orbruno/job-availability-api"
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/job-availability && chown node:node /var/lib/job-availability
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/schemas ./schemas
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
USER node
EXPOSE 5002
VOLUME ["/var/lib/job-availability"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/index.js"]
