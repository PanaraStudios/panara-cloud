#!/bin/sh
# Build and backup tools of the panel host's agent, fetched on first use
# instead of carried in the image: nixpacks, railpack, pack, rclone, git-lfs
# and the docker compose and buildx plugins. Each name is a link to this
# script, which downloads the pinned release for this architecture into
# /etc/panara-cloud/tools (on the host, so it outlives agent updates), checks
# it against the SHA-256 pinned below before it ever runs, and then runs it.
#
#   panara-cloud-tools fetch [name...]   download now (default: all)
#   panara-cloud-tools list              pinned versions and what is cached
#
# Servers added over SSH get these tools from server Setup, not from here.
# Bump a version together with both of its checksums (amd64, arm64), taken
# from the release's published checksum file.
set -eu

TOOLS_DIR=${PANARA_CLOUD_TOOLS_DIR:-/etc/panara-cloud/tools}
ALL_TOOLS="nixpacks railpack pack rclone git-lfs compose buildx"

fail() {
	printf '%s\n' "$*" >&2
	exit 1
}

case "$(uname -m)" in
x86_64 | amd64) ARCH=amd64 ;;
aarch64 | arm64) ARCH=arm64 ;;
*) fail "Panara Cloud has no build tools for $(uname -m); only amd64 and arm64 are supported" ;;
esac

# Sets version, url, sum, mb (download size), format (bin, tgz or zip),
# member (the binary inside an archive) and version_text (what the tool
# prints for --version, so a version check needs no download).
pin() {
	case "$1:$ARCH" in
	nixpacks:*)
		version=1.41.0 format=tgz member=nixpacks
		version_text="nixpacks $version"
		case "$ARCH" in
		amd64) mb=4 sum=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6 triple=x86_64 ;;
		arm64) mb=4 sum=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39 triple=aarch64 ;;
		esac
		url="https://github.com/railwayapp/nixpacks/releases/download/v$version/nixpacks-v$version-$triple-unknown-linux-musl.tar.gz"
		;;
	railpack:*)
		version=0.15.4 format=tgz member=railpack
		version_text="railpack version $version"
		case "$ARCH" in
		amd64) mb=8 sum=459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1 triple=x86_64 ;;
		arm64) mb=7 sum=035856398a88894a7e57dbea44e8c88aacca33a86900d3b8c7750216b424806f triple=arm64 ;;
		esac
		url="https://github.com/railwayapp/railpack/releases/download/v$version/railpack-v$version-$triple-unknown-linux-musl.tar.gz"
		;;
	pack:*)
		version=0.39.1 format=tgz member=pack
		version_text="$version"
		case "$ARCH" in
		amd64) mb=11 sum=77109791ec8ad73749bc9efc5ecd3905f49175a5071c50e4be59840041ee4b42 suffix=linux ;;
		arm64) mb=10 sum=6ffe978d5fe59ecc17ed685f51da35b7d6a003aeaa3676e831e7aeeb0ddd09c8 suffix=linux-arm64 ;;
		esac
		url="https://github.com/buildpacks/pack/releases/download/v$version/pack-v$version-$suffix.tgz"
		;;
	rclone:*)
		version=1.71.2 format=zip member="rclone-v$version-linux-$ARCH/rclone"
		version_text="rclone v$version"
		case "$ARCH" in
		amd64) mb=25 sum=ab9fa5877cee91c64fdfd61a27028a458cf618b39259e5c371dc2ec34a12e415 ;;
		arm64) mb=23 sum=e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1 ;;
		esac
		url="https://downloads.rclone.org/v$version/rclone-v$version-linux-$ARCH.zip"
		;;
	git-lfs:*)
		version=3.3.0 format=tgz member="git-lfs-$version/git-lfs"
		version_text="git-lfs/$version (GitHub; linux $ARCH)"
		case "$ARCH" in
		amd64) mb=5 sum=6a4e6bd7d06d5c024bc70c8ee8c9da143ffc37d2646e252a17a6126d30cdebc1 ;;
		arm64) mb=4 sum=e97c477981a9b6a40026cadc1bf005541d973fc32df2de2f398643b15df6b5c6 ;;
		esac
		url="https://github.com/git-lfs/git-lfs/releases/download/v$version/git-lfs-linux-$ARCH-v$version.tar.gz"
		;;
	compose:*)
		version=2.40.3 format=bin member=""
		version_text="Docker Compose version v$version"
		case "$ARCH" in
		amd64) mb=77 sum=dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372 triple=x86_64 ;;
		arm64) mb=74 sum=d26373b19e89160546d15407516cc59f453030d9bc5b43ba7faf16f7b4980137 triple=aarch64 ;;
		esac
		url="https://github.com/docker/compose/releases/download/v$version/docker-compose-linux-$triple"
		;;
	buildx:*)
		version=0.29.1 format=bin member=""
		version_text="github.com/docker/buildx v$version"
		case "$ARCH" in
		amd64) mb=68 sum=7d2d7d6d4680aa349614965aaa33ccec43f1a9a21e908a5ce4cb6adfa5ad5141 ;;
		arm64) mb=65 sum=50e85c4e290b698908421161c1aee069bcc5d4a65b7b7201bfac3a176b223a7e ;;
		esac
		url="https://github.com/docker/buildx/releases/download/v$version/buildx-v$version.linux-$ARCH"
		;;
	*) fail "panara-cloud-tools: unknown tool $1 (one of: $ALL_TOOLS)" ;;
	esac
	dir="$TOOLS_DIR/$1-$version-$ARCH"
	binary="$dir/$1"
}

# A file someone put in downloads/ by hand (a server without internet) is
# used when its checksum matches, like a download.
install_tool() {
	name=$1
	pin "$name"
	[ -x "$binary" ] && return 0
	mkdir -p "$TOOLS_DIR/downloads"
	chmod 755 "$TOOLS_DIR"
	exec 9>"$TOOLS_DIR/.$name.lock"
	flock 9
	if [ -x "$binary" ]; then
		exec 9>&-
		return 0
	fi
	file="${url##*/}"
	work=$(mktemp -d "$TOOLS_DIR/.fetch-$name.XXXXXX")
	trap 'rm -rf "$work"' EXIT
	if [ -f "$TOOLS_DIR/downloads/$file" ]; then
		printf 'Using %s %s from %s/downloads, first use on this server\n' "$name" "$version" "$TOOLS_DIR" >&2
		cp "$TOOLS_DIR/downloads/$file" "$work/$file"
	else
		printf 'Downloading %s %s (%s MB), first use on this server\n' "$name" "$version" "$mb" >&2
		if ! error=$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$work/$file" "$url" 2>&1); then
			error=$(printf '%s\n' "$error" | tail -n 1)
			fail "❌ Could not download $name $version from $url (${error:-no answer}).
This server needs HTTPS access to that address the first time a job uses $name.
Without internet access: download that file elsewhere (SHA-256 $sum) and copy it to
$TOOLS_DIR/downloads/$file on this server, then run the job again."
		fi
	fi
	actual=$(sha256sum "$work/$file" | cut -d' ' -f1)
	if [ "$actual" != "$sum" ]; then
		rm -f "$TOOLS_DIR/downloads/$file"
		fail "❌ $name $version ($file) does not match its pinned SHA-256: expected $sum, got $actual.
It was deleted without being run. Run the job again; if this repeats, something between this server
and $url changes the file."
	fi
	mkdir "$work/$name-$version-$ARCH"
	case "$format" in
	bin) mv "$work/$file" "$work/$name-$version-$ARCH/$name" ;;
	tgz) tar -xzf "$work/$file" -C "$work" "$member" && mv "$work/$member" "$work/$name-$version-$ARCH/$name" ;;
	zip) unzip -q -j "$work/$file" "$member" -d "$work/$name-$version-$ARCH" ;;
	esac
	chmod 755 "$work/$name-$version-$ARCH/$name"
	rm -rf "$dir"
	mv "$work/$name-$version-$ARCH" "$dir"
	rm -rf "$work"
	trap - EXIT
	exec 9>&-
}

# Docker lists plugins (docker info, docker --help) by asking each for its
# metadata: answered here, so listing them downloads nothing.
plugin_metadata() {
	pin "$1"
	case "$1" in
	compose) description="Docker Compose" ;;
	buildx) description="Docker Buildx" ;;
	esac
	printf '{"SchemaVersion":"0.1.0","Vendor":"Docker Inc.","Version":"v%s","ShortDescription":"%s"}\n' "$version" "$description"
}

# True when the arguments only ask for the version.
version_query() {
	name=$1
	shift
	case "$name" in
	compose | buildx) [ "${1:-}" = "$name" ] && shift ;;
	esac
	case "$name:$*" in
	nixpacks:--version | nixpacks:-V | railpack:--version | pack:--version | pack:version | \
		rclone:--version | rclone:version | git-lfs:version | git-lfs:--version | \
		compose:version | compose:--version | buildx:version) return 0 ;;
	compose:"version --short") return 0 ;;
	esac
	return 1
}

tool=${0##*/}
tool=${tool#docker-}

if [ "$tool" = panara-cloud-tools ]; then
	command=${1:-}
	[ $# -gt 0 ] && shift
	case "$command" in
	fetch)
		# shellcheck disable=SC2086 # one word per tool
		[ $# -gt 0 ] || set -- $ALL_TOOLS
		for name in "$@"; do
			install_tool "$name"
			printf '%s %s: %s\n' "$name" "$version" "$binary"
		done
		;;
	list)
		for name in $ALL_TOOLS; do
			pin "$name"
			if [ -x "$binary" ]; then state="$binary"; else state="not downloaded ($mb MB)"; fi
			printf '%-9s %-7s %s\n' "$name" "$version" "$state"
		done
		;;
	*) fail "Usage: panara-cloud-tools fetch [name...] | list" ;;
	esac
	exit 0
fi

case " $ALL_TOOLS " in
*" $tool "*) ;;
*) fail "panara-cloud-tools: run as one of: $ALL_TOOLS" ;;
esac

if [ "${1:-}" = docker-cli-plugin-metadata ]; then
	plugin_metadata "$tool"
	exit 0
fi

pin "$tool"
if [ ! -x "$binary" ] && version_query "$tool" "$@"; then
	case "$tool:$*" in
	*"version --short") printf '%s\n' "$version" ;;
	*) printf '%s\n' "$version_text" ;;
	esac
	exit 0
fi

install_tool "$tool"
exec "$binary" "$@"
