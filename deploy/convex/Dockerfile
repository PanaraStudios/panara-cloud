# The self-hosted Convex backend the panel runs, repackaged: the binaries,
# scripts and Node.js of the upstream image below, unchanged, on the same
# Ubuntu release without the build toolchain's leftovers. docs/convex-image.md
# has what the backend needs at run time and how each part was checked.
#
# Moving to another Convex release is this one line: the digest of a
# multi-arch ghcr.io/convex/convex-backend index (docs/convex-image.md,
# "Moving to another Convex release").
ARG CONVEX_UPSTREAM=ghcr.io/convex/convex-backend@sha256:6644f704e3a22444d5e166c3071a97be429915db962b38d1df1776876b102320

FROM ${CONVEX_UPSTREAM} AS upstream

# Upstream's own runtime base (Dockerfile.backend: FROM ubuntu:noble), so the
# binary finds the glibc and libstdc++ it was built against.
FROM ubuntu:noble@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289

# Upstream installs libclang1, curl and ca-certificates here. libclang (with
# LLVM, ICU and libxml2, 190 MB) is what bindgen needs while V8 and RocksDB
# compile; the binary neither links nor loads it. curl is the health check
# every installed panara-cloud-convex service runs; ca-certificates brings the
# roots for actions' outbound HTTPS and the openssl command run_backend.sh
# uses to create the instance secret on first start.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# Node.js runs "use node" actions; the backend starts `node` from PATH. npm and
# npx are left out: the backend never calls them.
COPY --from=upstream /usr/bin/node /usr/bin/node

WORKDIR /convex
COPY --from=upstream /convex/convex-local-backend /convex/generate_key /convex/run_backend.sh /convex/read_credentials.sh /convex/generate_admin_key.sh ./
COPY LICENSE.md /convex/LICENSE.md
# The licence of Node.js v24.22.3, the upstream image's; a pin bump that
# changes the Node.js version replaces it (docs/convex-image.md).
COPY NODE-LICENSE /usr/share/doc/nodejs/LICENSE

LABEL org.opencontainers.image.title="Panara Cloud Convex backend" \
	org.opencontainers.image.licenses="FSL-1.1-Apache-2.0" \
	org.opencontainers.image.description="Convex self-hosted backend (unmodified binary, https://github.com/convex/convex-backend) repackaged for Panara Cloud"

VOLUME /convex/data
ENTRYPOINT ["./run_backend.sh"]
EXPOSE 3210 3211
