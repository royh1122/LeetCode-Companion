# LeetCode Companion dashboard in server mode (docs/SERVER_MODE.md).
# The image holds the dashboard only; build the browser extension on your own computer
# (npm run ext:build) and pair it from the dashboard's Settings → Devices.
#
# There is no login: run this only on a private network (Tailscale, a home LAN, a VPN) and never
# publish its port to the public internet. See compose.yaml for an example.
#
#   docker build -t leetcode-companion .
#   docker run -v lcc-data:/data -e LCC_ALLOWED_HOSTS=my-server.tailnet-name.ts.net:4317 \
#     -p 127.0.0.1:4317:4317 leetcode-companion

# ---- build ----
FROM node:22-bookworm-slim AS build
# Compilers, in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/extension/package.json apps/extension/
COPY packages/shared/package.json packages/shared/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/db/package.json packages/db/
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @lcc/web

# ---- run ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    LCC_DATA_DIR=/data \
    LCC_LISTEN=network \
    PORT=4317
# The full app (with tsx, used for migrations): simple, and the same layout as a normal checkout.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4317
# 127.0.0.1 is always an allowed host, so the check works whatever LCC_ALLOWED_HOSTS says.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/revision').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run first (with an automatic backup in /data/backups). LCC_ALLOWED_HOSTS must name the
# address other devices use; without it the server refuses to start (listening on the network
# with no allowed address would accept nobody).
CMD ["sh", "-c", "npx tsx scripts/db.ts migrate && cd apps/web && exec node ../../node_modules/next/dist/bin/next start -H 0.0.0.0 -p \"$PORT\""]
