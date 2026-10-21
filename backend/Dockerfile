FROM node:24-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN --mount=type=secret,id=custom_ca \
    if [ -f /run/secrets/custom_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/custom_ca; fi; \
    npm ci --no-audit --no-fund
COPY . /app
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node","dist/server.js"]
