# syntax=docker/dockerfile:1
# Panara Cloud monitoring collector: host and container metrics served on the
# port from METRICS_CONFIG. Build from the repo root:
#   docker build -f apps/monitoring/Dockerfile -t panara-cloud-monitoring .
#
# It runs as root: it reads the host's Docker socket (`docker stats`), whose
# group id differs per host, and the host's /proc and /sys mounted at
# /host/proc and /host/sys.
ARG GO_VERSION=1.24
ARG ALPINE_VERSION=3.22

FROM golang:${GO_VERSION}-alpine${ALPINE_VERSION} AS build
# go-sqlite3 needs cgo; linking against musl statically keeps the binary
# free of runtime library dependencies.
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY apps/monitoring/go.mod apps/monitoring/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY apps/monitoring/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
	--mount=type=cache,target=/root/.cache/go-build \
	CGO_ENABLED=1 go build -trimpath -tags sqlite_omit_load_extension \
	-ldflags '-s -w -linkmode external -extldflags "-static"' \
	-o /out/panara-cloud-monitoring .

FROM alpine:${ALPINE_VERSION}
RUN apk add --no-cache ca-certificates docker-cli tzdata
COPY --from=build /out/panara-cloud-monitoring /usr/local/bin/panara-cloud-monitoring
COPY apps/monitoring/LICENSE.md /usr/share/licenses/panara-cloud-monitoring/LICENSE.md
ARG PANARA_CLOUD_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Panara Cloud monitoring" \
	org.opencontainers.image.version=$PANARA_CLOUD_VERSION \
	org.opencontainers.image.source="https://github.com/PanaraStudios/panara-cloud" \
	org.opencontainers.image.licenses=MIT
# gopsutil reads host metrics from these instead of the container's own view.
ENV HOST_PROC=/host/proc \
	HOST_SYS=/host/sys \
	PANARA_CLOUD_VERSION=$PANARA_CLOUD_VERSION
# The agent bind-mounts the metrics database at /app/monitoring.db.
WORKDIR /app
EXPOSE 3001
ENTRYPOINT ["panara-cloud-monitoring"]
