# syntax=docker/dockerfile:1
# Panara Cloud web app: the static build of the UI and the small server that
# serves it and proxies the panel's /api routes to Convex (apps/web/server).
# No Node.js at run time. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t panara-cloud-web .
ARG NODE_VERSION=24.22.1
ARG RUST_VERSION=1.91
ARG ALPINE_VERSION=3.22

FROM node:${NODE_VERSION}-bookworm-slim AS ui
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --filter "@panara-cloud/web..."
COPY apps/web apps/web
COPY packages/backend packages/backend
RUN pnpm --filter @panara-cloud/web build

FROM rust:${RUST_VERSION}-alpine${ALPINE_VERSION} AS server
# ring (HTTPS to a Convex Cloud site URL) compiles a little C.
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY apps/web/server/Cargo.toml apps/web/server/Cargo.lock ./
COPY apps/web/server/src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/src/target \
	cargo build --release --locked && \
	cp target/release/panara-cloud-web /panara-cloud-web

FROM scratch
COPY --from=server /panara-cloud-web /panara-cloud-web
COPY --from=ui /src/apps/web/dist /srv/panara-cloud-web
ARG PANARA_CLOUD_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Panara Cloud web" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=MIT
ENV PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION \
	PANARA_CLOUD_WEB_ROOT=/srv/panara-cloud-web \
	PORT=3000
# The uid the Node image's `node` user had.
USER 1000:1000
EXPOSE 3000
# The server checks itself: no shell or curl in the image. It fails on a
# refused connection, on any status but 200, and when no status line
# arrives within 4 s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["/panara-cloud-web", "health"]
ENTRYPOINT ["/panara-cloud-web"]
