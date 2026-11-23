# The Convex image

The panel's Convex backend runs from `panara-cloud-convex`, released with the panel at the
panel's version (`<registry>/panara-cloud-convex:<x.y.z>`, amd64 and arm64). It is the
upstream self-hosted image with the build toolchain's leftovers taken out: the Convex
binary, its start-up scripts and its Node.js are copied unchanged from the upstream image
that `deploy/convex/Dockerfile` names, onto the same Ubuntu release upstream builds on.

| | upstream `ghcr.io/convex/convex-backend` | `panara-cloud-convex` |
|---|---|---|
| Unpacked size (amd64) | 597 MB | 383 MB |
| Download, compressed layers (amd64) | 208 MB | 139 MB |
| Convex binary, `generate_key`, scripts, `node` | | the same files (identical SHA-256) |
| Convex memory 5 min after a workload, 3 runs each | 179–210 MiB | 204–214 MiB |
| Libraries the running backend maps | ld-linux, libc, libgcc_s, libm, libstdc++ | the same five files (identical SHA-256) |

Both images run the same process: the same binary with the same five libraries. The memory
figures differ by what one run differs from the next; in a first pair run side by side the
new image was the lower one (243 against 252 MiB). Functions deploy, Convex after its
restart (35–42 MiB) and right after the workload were alike too.

Releases before 0.1.6 have no `panara-cloud-convex` image; installing one of them runs the
upstream image that release was installed with.

## What the backend needs at run time

Checked for the pinned revision (`21f6fe42`, image
`ghcr.io/convex/convex-backend@sha256:6644f704…`), amd64 by running it and arm64 by reading
its binaries:

- **The Convex binary** (`convex-local-backend`) links libc, libm, libstdc++ and libgcc_s
  only (`ldd`, `readelf -d` on arm64), needing glibc 2.39: Ubuntu 24.04's. Nothing loads
  another library at run time: the one library loader in its dependency tree is
  `libloading`, which `clang-sys` uses for bindgen, and the binary holds no library path
  and no `libclang` string.
- **libclang and LLVM are build tools.** Upstream's runtime stage installs `libclang1`, which
  pulls in LLVM 18, ICU 74 and libxml2 (190 MB). In the dependency tree only `bindgen`
  (through `clang-sys`/`libloading`) uses libclang, and only `v8`'s and `librocksdb-sys`'s
  build scripts use bindgen. ICU comes along as libxml2's dependency; V8 inside the binary
  carries its own ICU data, and Node.js is built with its own ICU.
- **Node.js** runs `"use node"` actions (the panel has them: SSH keys, GitHub, DNS,
  notifications, the vault and others). The backend starts `node` from `PATH` and accepts
  v22, v24 or v26. It never runs `npm` or `npx` (the panel has no `externalPackages`), so
  those are left out.
- **bash**, **coreutils** and **openssl**: `run_backend.sh` is a bash script, and
  `read_credentials.sh` makes the instance secret with `openssl rand` on first start.
- **CA certificates** for outbound HTTPS from actions: the binary looks for them where
  OpenSSL and `rustls-native-certs` look (`/etc/ssl/certs`, `SSL_CERT_FILE`). Both images
  hold the same bundle (same SHA-256, from the same `ca-certificates` and OpenSSL package
  versions). Outbound HTTPS itself was not exercised: the actions in the checks below send
  nothing outside.
- **curl**: not used by Convex, but the health check of every installed
  `panara-cloud-convex` service is `curl -fsS http://localhost:3210/version`, and a Swarm
  service keeps its health check when its image changes.

No time zone data is in either image, so both run in UTC.

## How it was checked

Old and new image as throwaway stacks on one host, one stack at a time, each the way the
installer runs it (the same environment, the Swarm service's health check, functions deployed with
the migrate image, Convex restarted afterwards, then web and agent), three of each:

- sign-in through the web app, four signed-in pages, an organization created;
- a query (`account:organizations`) and a mutation that queues a job, which the agent
  claimed and reported;
- a `"use node"` action that sends nothing outside: `sources/sshKeygen:generateKeyPair`,
  ed25519 and RSA keys.

On one more stack of the new image:

- crons: `jobs:reapExpiredLeases`, `live/cleanup:expireSessions` and
  `live/accessLog:enqueueCleanups` in the function log;
- `convex export --include-file-storage` with two 20 MB stored files, `convex import
  --replace-all` (40 MB, 30 s), and a second export: the stored files came back byte for
  byte;
- the data volume swapped to the upstream image and back: `db metadata version up to date`
  (no data migration) on each start, and sign-in, the query, the mutation, the action and
  an export with the stored files all as before on each image.

## Moving existing installs

The binary is the same file, so the data volume is the same format for both images, and
moving is one restart of Convex:

- `install.sh upgrade` (and `install` with a new version) moves Convex to the release's
  image before the functions deploy, as it moved it to a new pin before.
- The panel's Update does the same from 0.1.6 on: it pulls the release's
  `panara-cloud-convex`, moves the service to it (stop-first) before `migrate`, and rolls
  it back and stops if the new task doesn't come up. An update is run by the agent of the
  version being left, so the 0.1.5 → 0.1.6 update does not move Convex yet; the next update
  or `upgrade` does.
- Convex stays where it is when `PANARA_CLOUD_CONVEX_IMAGE` was chosen
  (`PANARA_CLOUD_CONVEX_REPOSITORY=none` on the agent), or when it runs an image the panel
  did not give it.

The upstream image Convex ran before stays on disk until it is removed (`docs/install.md`,
"From the shell").

## Moving to another Convex release

The upstream image is named in one place, the `CONVEX_UPSTREAM` line of
`deploy/convex/Dockerfile`:

1. Take the digest of the multi-arch index of the new `ghcr.io/convex/convex-backend` image
   (`docker buildx imagetools inspect ghcr.io/convex/convex-backend:<tag>`), and put it in
   `CONVEX_UPSTREAM`.
2. Read that revision's `self-hosted/docker-build/Dockerfile.backend` (the image's
   `org.opencontainers.image.revision` label names it) for new run-time packages or files,
   and `run_backend.sh` for new commands; check `ldd` of the new binary.
3. Replace `deploy/convex/LICENSE.md` with that revision's `LICENSE.md`, and
   `deploy/convex/NODE-LICENSE` with the `LICENSE` of the Node.js version in the image
   (`node --version`) when it changed.
4. Check the settings in `apps/agent/src/infra/convexSettings.ts` against that revision's
   `crates/common/src/knobs.rs`.
5. Build it and run the checks above. A new binary may migrate the data in place on its
   first start (`Executing Migration …` in its log) and can't go back afterwards, so say so
   in the changelog.

The release workflow builds the image with every release, so the panel's next release
carries it to installs through `upgrade` and the panel's Update.
