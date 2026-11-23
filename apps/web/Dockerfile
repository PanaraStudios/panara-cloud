# syntax=docker/dockerfile:1
# Panara Cloud web app (Next.js standalone server). Build from the repo root:
#   docker build -f apps/web/Dockerfile -t panara-cloud-web .
ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

FROM base AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --filter "@panara-cloud/web..."
COPY apps/web apps/web
COPY packages/backend packages/backend
ENV NEXT_TELEMETRY_DISABLED=1
# Connection settings are read per request at runtime; these placeholders
# only satisfy the build.
RUN CONVEX_INTERNAL_URL=http://convex.invalid:3210 \
	CONVEX_INTERNAL_SITE_URL=http://convex.invalid:3211 \
	CONVEX_PUBLIC_URL=http://convex.invalid:3210 \
	pnpm --filter @panara-cloud/web build

FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOSTNAME=0.0.0.0 \
	KEEP_ALIVE_TIMEOUT=120000 \
	PORT=3000
COPY --from=build --chown=node:node /src/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /src/apps/web/public ./apps/web/public
ARG PANARA_CLOUD_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Panara Cloud web" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=MIT
ENV PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION
USER node
EXPOSE 3000
# bash's own /dev/tcp, because the image has no curl or wget and a `node -e`
# probe starts a whole Node process (about 0.1 s of CPU, 40-80 MiB) every
# 30 s. It fails on a refused connection, on any status but 200, and when no
# status line arrives within 4 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-3000} && printf 'GET /api/health HTTP/1.0\\r\\n\\r\\n' >&3 && read -r -t 4 status <&3 && [[ $status == *' 200 '* ]]"]
CMD ["node", "apps/web/server.js"]
