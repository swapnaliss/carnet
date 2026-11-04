# One image, two modes (ADR 0014, M1-06): PROCESS_MODE=web (default) or PROCESS_MODE=worker.
# Release step (Render preDeployCommand): node runtime/release.mjs. Setup: node runtime/setup.mjs.
# No .env and no secrets enter the image (.dockerignore); configuration comes from the environment.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/airwallex/package.json packages/airwallex/
COPY packages/agent/package.json packages/agent/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && node scripts/build-runtime.mjs

FROM node:24-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 PROCESS_MODE=web
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/dist/runtime ./runtime
USER node
EXPOSE 3000
ENTRYPOINT ["node", "runtime/entry.mjs"]
