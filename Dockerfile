# Multi-stage Dockerfile for the API only — web ships to Cloudflare
# Pages so it isn't built here.
#
# We build inside a Bun image (matches the dev environment) but RUN
# under Node, because the production runtime command in apps/api is
# `node dist/server.js` — keeps behavior identical to local.

# ── Stage 1: install + typecheck + tsc -> dist ──────────────────────
FROM oven/bun:1.2.21-alpine AS build
WORKDIR /app

# Copy workspace manifests first so the layer cache survives source edits.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

# Install all workspaces (web is needed because it's referenced by the
# root, but we won't ship its build artifact). Native modules: the
# alpine image has python + build tools available out of the box, so
# node-gyp succeeds.
RUN bun install --frozen-lockfile

# Now copy the actual source for the workspaces we ship.
COPY packages/shared packages/shared
COPY apps/api apps/api

# Compile TS → dist/. The api workspace already has `bun run build`
# wired to `tsc -p tsconfig.json`.
RUN bun run --filter @consolidate/api build

# ── Stage 2: lean Node runtime ──────────────────────────────────────
FROM node:24.15.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring in production node_modules and the compiled dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

# Fly's per-machine healthcheck hits /health on this port.
EXPOSE 4000
ENV API_PORT=4000

# Bind to 0.0.0.0 (server.ts already does this) so the Fly proxy can
# forward inbound traffic into the machine.
CMD ["node", "apps/api/dist/server.js"]
