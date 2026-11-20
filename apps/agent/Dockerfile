# syntax=docker/dockerfile:1
# Panara Cloud agent: the job runner for the panel host plus the Convex
# functions bundle and installer steps (`migrate`, `create-admin`,
# `panel-setup`, see docker/entrypoint.sh). Build from the repo root:
#   docker build -f apps/agent/Dockerfile -t panara-cloud-agent .
#
# It runs as root: it drives the host's Docker socket and owns
# /etc/panara-cloud, and builds (git, nixpacks, railpack, pack) run inside it
# for the panel host.
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
	pnpm install --frozen-lockfile --filter . --filter "@panara-cloud/agent..."
COPY apps/agent apps/agent
COPY packages/backend packages/backend
RUN pnpm --filter @panara-cloud/agent build
# The functions source with production dependencies: `convex deploy` bundles
# it at install time against the panel's own Convex backend. Test files are
# dropped because their dev dependencies aren't installed, and so are peer
# dependencies the legacy deploy auto-installs (Next.js, Prisma, Drizzle,
# TypeScript, sharp) that no Convex function imports: about 600 MB.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm --filter @panara-cloud/backend --prod deploy --legacy /out/app \
	&& find /out/app/convex \( -name '*.test.ts' -o -name test.setup.ts \) -delete \
	&& rm -f /out/app/vitest.config.ts \
	&& cd /out/app/node_modules/.pnpm \
	&& rm -rf next@* @next+swc* prisma@* @prisma+* typescript@* @typescript+* \
		@electric-sql+* drizzle-orm@* @img+sharp* playwright* @playwright+* \
	&& cd /src \
	&& mkdir /out/app/agent \
	&& cp apps/agent/dist/*.mjs apps/agent/dist/*.mjs.map /out/app/agent/

FROM debian:bookworm-slim AS tools
ARG TARGETARCH
ARG DOCKER_VERSION=28.5.0
ARG COMPOSE_VERSION=2.40.3
ARG BUILDX_VERSION=0.29.1
ARG RCLONE_VERSION=1.71.2
ARG NIXPACKS_VERSION=1.41.0
ARG RAILPACK_VERSION=0.15.4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /out
# SHA-256 of every download, per architecture: bump them with the versions.
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) a=x86_64; r=amd64; n=x86_64; p=x86_64; \
			docker_sum=7e9ff298b05aa62898f85a0a191bba714754fe5ff34e164c473566e8b3bfec0c; \
			compose_sum=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372; \
			buildx_sum=7d2d7d6d4680aa349614965aaa33ccec43f1a9a21e908a5ce4cb6adfa5ad5141; \
			rclone_sum=ab9fa5877cee91c64fdfd61a27028a458cf618b39259e5c371dc2ec34a12e415; \
			nixpacks_sum=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6; \
			railpack_sum=459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1 ;; \
		arm64) a=aarch64; r=arm64; n=aarch64; p=arm64; \
			docker_sum=419a6cf482a8e500cfc84063aa947faf1e35fa388acab57a3193fcc4e6f9503c; \
			compose_sum=d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137; \
			buildx_sum=50e85c4e290b698908421161c1aee069bcc5d4a65b7b7201bfac3a176b223a7e; \
			rclone_sum=e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1; \
			nixpacks_sum=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39; \
			railpack_sum=035856398a88894a7e57dbea44e8c88aacca33a86900d3b8c7750216b424806f ;; \
		*) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	fetch() { curl -fsSL -o "$1" "$2"; echo "$3  $1" | sha256sum -c -; }; \
	mkdir -p bin cli-plugins; \
	fetch docker.tgz "https://download.docker.com/linux/static/stable/$a/docker-$DOCKER_VERSION.tgz" "$docker_sum"; \
	tar -xzf docker.tgz --strip-components=1 -C bin docker/docker; rm docker.tgz; \
	fetch cli-plugins/docker-compose "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-$a" "$compose_sum"; \
	fetch cli-plugins/docker-buildx "https://github.com/docker/buildx/releases/download/v$BUILDX_VERSION/buildx-v$BUILDX_VERSION.linux-$r" "$buildx_sum"; \
	fetch rclone.zip "https://downloads.rclone.org/v$RCLONE_VERSION/rclone-v$RCLONE_VERSION-linux-$r.zip" "$rclone_sum"; \
	unzip -q -j rclone.zip "*/rclone" -d bin; rm rclone.zip; \
	fetch nixpacks.tgz "https://github.com/railwayapp/nixpacks/releases/download/v$NIXPACKS_VERSION/nixpacks-v$NIXPACKS_VERSION-$n-unknown-linux-musl.tar.gz" "$nixpacks_sum"; \
	tar -xzf nixpacks.tgz -C bin nixpacks; rm nixpacks.tgz; \
	fetch railpack.tgz "https://github.com/railwayapp/railpack/releases/download/v$RAILPACK_VERSION/railpack-v$RAILPACK_VERSION-$p-unknown-linux-musl.tar.gz" "$railpack_sum"; \
	tar -xzf railpack.tgz -C bin railpack; rm railpack.tgz; \
	chmod +x bin/* cli-plugins/*

FROM buildpacksio/pack:0.39.1 AS pack

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
		apache2-utils bash ca-certificates curl git git-lfs iproute2 openssh-client \
		rsync tini unzip zip \
	&& git lfs install --system \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=tools /out/bin/ /usr/local/bin/
COPY --from=tools /out/cli-plugins/ /usr/local/lib/docker/cli-plugins/
COPY --from=pack /usr/local/bin/pack /usr/local/bin/pack
COPY --from=build /out/app /app
COPY apps/agent/docker/entrypoint.sh /usr/local/bin/panara-cloud-agent
# Declared last so a version bump only rebuilds these layers.
ARG PANARA_CLOUD_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Panara Cloud agent" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=Apache-2.0
ENV NODE_ENV=production \
	PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION
WORKDIR /app
EXPOSE 7100
ENTRYPOINT ["/usr/bin/tini", "--", "panara-cloud-agent"]
CMD ["agent"]
