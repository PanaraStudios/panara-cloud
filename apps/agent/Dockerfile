# syntax=docker/dockerfile:1
# Panara Cloud agent and migrate images. Build from the repo root:
#   docker build -f apps/agent/Dockerfile -t panara-cloud-agent .
#   docker build -f apps/agent/Dockerfile --target migrate -t panara-cloud-migrate .
#
# agent (the default target): the job runner of the panel host, always
# running, plus the installer steps `panel-setup`, `create-admin`,
# `reset-password` and `setup-link` (docker/entrypoint.sh). It runs as root:
# it drives the host's Docker socket, owns /etc/panara-cloud and runs builds
# for the panel host. nixpacks, railpack, pack, rclone, git-lfs and the
# compose and buildx plugins are fetched on first use (docker/tools.sh).
#
# migrate: the Convex functions and the CLI that deploys them (`migrate`,
# docker/migrate-entrypoint.sh), run once per install, upgrade and in-panel
# update, then removed.
#
# Both start from the Node image the web image is built on, whose layers a
# host stores once for all three.
ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM node AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/backend/package.json packages/backend/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --filter . --filter "@panara-cloud/agent..."
COPY apps/agent apps/agent
COPY packages/backend packages/backend
# The agent needs no node_modules but the Convex CLI that the panel backup
# runs for `convex export`, as one file where the CLI expects to be.
RUN pnpm --filter @panara-cloud/agent build \
	&& mkdir -p /out/app/agent /out/app/node_modules/convex/bin /out/app/node_modules/convex/dist \
	&& cp apps/agent/dist/*.mjs apps/agent/dist/*.mjs.map /out/app/agent/ \
	&& cp apps/agent/node_modules/convex/package.json /out/app/node_modules/convex/ \
	&& cp apps/agent/node_modules/convex/bin/main.js /out/app/node_modules/convex/bin/ \
	&& cp apps/agent/dist/convex-cli.cjs /out/app/node_modules/convex/dist/cli.bundle.cjs

# The functions source with what `convex deploy` reads to bundle it against
# the panel's own Convex backend (docker/prune-functions.mjs). Test files
# are dropped first because their dev dependencies aren't installed.
FROM build AS functions
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm --filter @panara-cloud/backend --prod deploy --legacy /migrate \
	&& find /migrate/convex \( -name '*.test.ts' -o -name test.setup.ts \) -delete \
	&& rm -f /migrate/vitest.config.ts \
	&& node apps/agent/docker/prune-functions.mjs /migrate
COPY apps/agent/docker/migrate-entrypoint.sh /migrate/entrypoint.sh

FROM debian:bookworm-slim AS docker-cli
ARG TARGETARCH
ARG DOCKER_VERSION=28.5.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
# SHA-256 per architecture: bump them with the version.
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) a=x86_64; sum=7e9ff298b05aa62898f85a0a191bba714754fe5ff34e164c473566e8b3bfec0c ;; \
		arm64) a=aarch64; sum=419a6cf482a8e500cfc84063aa947faf1e35fa388acab57a3193fcc4e6f9503c ;; \
		*) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	curl -fsSL -o /docker.tgz "https://download.docker.com/linux/static/stable/$a/docker-$DOCKER_VERSION.tgz"; \
	echo "$sum  /docker.tgz" | sha256sum -c -; \
	tar -xzf /docker.tgz --strip-components=1 -C /usr/local/bin docker/docker; \
	rm /docker.tgz

FROM node AS migrate
WORKDIR /migrate
# One layer, the last: the agent image's `migrate` (src/migrate/fetch.ts)
# downloads the image's layers from the last one back until one holds
# /migrate, so anything added after it must stay out of /migrate.
COPY --from=functions /migrate /migrate
ARG PANARA_CLOUD_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Panara Cloud functions deploy" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=MIT
ENV NODE_ENV=production \
	PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION
ENTRYPOINT ["/migrate/entrypoint.sh"]
CMD ["migrate"]

FROM node AS agent
# What the agent's own scripts run on the panel host, besides Node and the
# docker CLI: bash, coreutils, tar, flock (base image); curl (downloads,
# the installer's health probes); git and openssh-client (clones, SSH keys);
# iproute2 (ip, ss); tini; zip and unzip (uploads, backups). git pulls in
# perl, which no git command the agent runs uses (perl-base stays for the
# mounts reader), and its manual pages.
RUN apt-get update && apt-get install -y --no-install-recommends \
		bash ca-certificates curl git iproute2 openssh-client tini unzip zip \
	&& dpkg --remove --force-depends perl perl-modules-5.36 libperl5.36 liberror-perl git-man \
	&& git config --system filter.lfs.process "git-lfs filter-process" \
	&& git config --system filter.lfs.required true \
	&& git config --system filter.lfs.clean "git-lfs clean -- %f" \
	&& git config --system filter.lfs.smudge "git-lfs smudge -- %f" \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY apps/agent/docker/tools.sh /usr/local/bin/panara-cloud-tools
RUN for tool in nixpacks railpack pack rclone git-lfs; do \
		ln -s panara-cloud-tools "/usr/local/bin/$tool"; \
	done \
	&& mkdir -p /usr/local/lib/docker/cli-plugins \
	&& for plugin in compose buildx; do \
		ln -s /usr/local/bin/panara-cloud-tools "/usr/local/lib/docker/cli-plugins/docker-$plugin"; \
	done
COPY --from=build /out/app /app
COPY apps/agent/docker/entrypoint.sh /usr/local/bin/panara-cloud-agent
# Declared last so a version bump only rebuilds these layers. The migrate
# repository is where the release workflow publishes this version's migrate
# image; the agent's `migrate` fetches it from there.
ARG PANARA_CLOUD_VERSION=0.0.0-dev
ARG PANARA_CLOUD_MIGRATE_IMAGE=ghcr.io/panarastudios/panara-cloud-migrate
LABEL org.opencontainers.image.title="Panara Cloud agent" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=MIT
ENV NODE_ENV=production \
	PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION \
	PANARA_CLOUD_MIGRATE_IMAGE=$PANARA_CLOUD_MIGRATE_IMAGE
WORKDIR /app
EXPOSE 7100
ENTRYPOINT ["/usr/bin/tini", "--", "panara-cloud-agent"]
CMD ["agent"]
