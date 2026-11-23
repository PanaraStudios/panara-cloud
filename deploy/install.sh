#!/bin/sh
# Panara Cloud installer and upgrader for the panel host.
#
#   curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh
#   curl -fsSL .../install.sh | sudo sh -s upgrade
#   curl -fsSL .../install.sh | sudo sh -s create-admin
#   curl -fsSL .../install.sh | sudo sh -s reset-password admin@example.com
#   curl -fsSL .../install.sh | sudo sh -s setup-link
#   curl -fsSL .../install.sh | sudo sh -s status
#   curl -fsSL .../install.sh | sh -s -- --help
#
# Settings come from the environment (see docs/install.md) and are kept in
# /etc/panara-cloud/install.env for later runs. Secrets never leave the host:
# the Convex admin key and the agent's enrollment secret live in
# /etc/panara-cloud/secrets (root, 0600); generated deployment secrets are
# written straight into Convex and never printed.
#
# POSIX sh on purpose: `curl | sh` runs it with dash on Debian/Ubuntu.
set -eu

COMMAND="${1:-}"

BASE=/etc/panara-cloud
SECRETS="$BASE/secrets"
CONFIG="$BASE/install.env"
NETWORK=panara-cloud-network
ADMIN_KEY_FILE="$SECRETS/convex-admin-key"
AGENT_SECRET_FILE="$SECRETS/agent-secret"
CONVEX_ENV_FILE="$SECRETS/convex.env"
PROXY_SECRET_FILE="$SECRETS/proxy-secret"

SVC_CONVEX=panara-cloud-convex
SVC_DASHBOARD=panara-cloud-convex-dashboard
SVC_WEB=panara-cloud-web
SVC_AGENT=panara-cloud-agent

# The Convex backend is released with the panel, as panara-cloud-convex at the
# panel's version: the upstream binary repackaged (deploy/convex/Dockerfile,
# which names the upstream image; docs/convex-image.md). Releases before 0.1.6
# have no such image and run the upstream one their installer pinned, below.
CONVEX_IMAGE_BEFORE_0_1_6=ghcr.io/convex/convex-backend@sha256:6644f704e3a22444d5e166c3071a97be429915db962b38d1df1776876b102320
# The official dashboard, pinned by digest (a multi-arch index).
# ghcr.io/get-convex/* no longer serves pulls.
DEFAULT_CONVEX_DASHBOARD_IMAGE=ghcr.io/convex/convex-dashboard@sha256:3cabc039ab4b4e3a75cc02338b6c70f37f5c0c356e1b79499151b43ec8d83e34

# Every image an earlier installer pinned, both kinds. When the dashboard pin
# changes, add the old value here: installs made up to 0.1.4 have the pins in
# install.env and would otherwise stay on them.
FORMER_CONVEX_IMAGES="$CONVEX_IMAGE_BEFORE_0_1_6"

DOCKER_VERSION=28.5.0

# What the Convex backend runs with besides its addresses (docs/install.md,
# "Convex settings"). A new service gets all of them; an existing one gets the
# ones it lacks, so a value set by hand stays. The line between the markers is
# generated from apps/agent/src/infra/convexSettings.ts (convexSettingsBlock());
# its test fails when they differ.
# BEGIN generated convex settings
CONVEX_SETTINGS="MALLOC_ARENA_MAX=2 DOCUMENT_RETENTION_DELAY=172800 DISABLE_BEACON=true TMPDIR=/tmp FUNRUN_CODE_CACHE_SIZE=64000000 FUNRUN_MODULE_CACHE_SIZE=64000000"
# END generated convex settings

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }

INSTALL_URL=https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh

# Piped into sh (`curl ... | sudo sh`), $0 is the shell and there is no file
# to run again, so the commands this script prints go through curl as well.
SCRIPT_FILE=""
if [ -f "$0" ] && head -n 2 "$0" 2>/dev/null | grep -q 'Panara Cloud installer'; then
	SCRIPT_FILE="$0"
fi

# rerun "VAR=value ..." "command args": the command line that runs this
# script again the way it was run this time.
rerun() {
	if [ -n "$SCRIPT_FILE" ]; then
		printf 'sudo%s sh %s%s' "${1:+ $1}" "$SCRIPT_FILE" "${2:+ $2}"
	else
		printf 'curl -fsSL %s | sudo%s sh%s' "$INSTALL_URL" "${1:+ $1}" "${2:+ -s $2}"
	fi
}

usage() {
	cat <<EOF
Panara Cloud installer and upgrader for the panel host.

Usage: $(rerun "" "[command]")

Commands:
  install                 Install Panara Cloud, or apply new settings to an
                          installed host. The default. Keeps the running version.
  upgrade                 Move to the newest release, or to PANARA_CLOUD_VERSION.
  setup-link              Print a new one-time link that creates the first account.
  create-admin            Create the first administrator from the shell.
  reset-password <email>  Print a one-time password reset link for an account.
  status                  Show the running version and services.
  help                    Show this text.

Main settings (environment variables; saved in $CONFIG for later runs):
  PANARA_CLOUD_DOMAIN             Panel domain, e.g. panel.example.com. Without one
                                  the panel is served over plain HTTP on
                                  http://<server address>:3000.
  PANARA_CLOUD_LETSENCRYPT_EMAIL  Email of the Let's Encrypt account for the domain.
  PANARA_CLOUD_HTTPS              false serves the domain over plain HTTP.
  PANARA_CLOUD_VERSION            x.y.z, latest (the default) or a channel such as canary.
  PANARA_CLOUD_HOST               The server's address when it is not detected.
  PANARA_CLOUD_PORT               Panel port without a domain (3000).
  PANARA_CLOUD_CONVEX_PORT, PANARA_CLOUD_CONVEX_SITE_PORT, PANARA_CLOUD_LIVE_PORT
                                  Backend and live ports without a domain
                                  (3210, 3211, 7100).

Example:
  $(rerun "PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_LETSENCRYPT_EMAIL=you@example.com" "")

Every setting and what each command does: docs/install.md in
https://github.com/PanaraStudios/panara-cloud
EOF
}
service_exists() { docker service inspect "$1" >/dev/null 2>&1; }

# Version label of the image the agent service runs; the panel's own Update
# moves the services without touching install.env.
running_version() {
	command_exists docker || return 0
	ref=$(docker service inspect "$SVC_AGENT" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null) || return 0
	docker image inspect "$ref" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true
}

load_config() {
	# Values given on the command line win over the saved ones.
	VERSION_ARG="${PANARA_CLOUD_VERSION:-}"
	HAVE_SAVED=0
	if [ -f "$CONFIG" ]; then
		saved=$(mktemp)
		env | grep '^PANARA_CLOUD_' >"$saved" || true
		# shellcheck disable=SC1090
		. "$CONFIG"
		# What the last run left, to tell a setting that changes from one that
		# is only repeated: published ports follow the first kind alone.
		HAVE_SAVED=1
		SAVED_DOMAIN="${PANARA_CLOUD_DOMAIN:-}"
		SAVED_HTTPS="${PANARA_CLOUD_HTTPS:-}"
		SAVED_LETSENCRYPT_EMAIL="${PANARA_CLOUD_LETSENCRYPT_EMAIL:-}"
		SAVED_HOST="${PANARA_CLOUD_HOST:-}"
		SAVED_PORT="${PANARA_CLOUD_PORT:-3000}"
		SAVED_CONVEX_PORT="${PANARA_CLOUD_CONVEX_PORT:-3210}"
		SAVED_CONVEX_SITE_PORT="${PANARA_CLOUD_CONVEX_SITE_PORT:-3211}"
		SAVED_LIVE_PORT="${PANARA_CLOUD_LIVE_PORT:-7100}"
		SAVED_DASHBOARD_PORT="${PANARA_CLOUD_DASHBOARD_PORT:-6791}"
		# An IP-only install saved HTTPS=false; it must not stick once a
		# domain is added later.
		if [ -z "${PANARA_CLOUD_DOMAIN:-}" ]; then unset PANARA_CLOUD_HTTPS; fi
		while IFS= read -r line; do
			export "${line?}"
		done <"$saved"
		rm -f "$saved"
		# Re-running the installer must not roll back an Update made from the panel.
		if [ -z "$VERSION_ARG" ]; then
			current=$(running_version)
			if [ -n "$current" ]; then PANARA_CLOUD_VERSION="$current"; fi
		fi
	fi
	PANARA_CLOUD_REGISTRY="${PANARA_CLOUD_REGISTRY:-ghcr.io/panarastudios}"
	PANARA_CLOUD_WEB_IMAGE="${PANARA_CLOUD_WEB_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-web}"
	PANARA_CLOUD_AGENT_IMAGE="${PANARA_CLOUD_AGENT_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-agent}"
	PANARA_CLOUD_MONITORING_IMAGE="${PANARA_CLOUD_MONITORING_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-monitoring}"
	PANARA_CLOUD_MIGRATE_IMAGE="${PANARA_CLOUD_MIGRATE_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-migrate}"
	# Installers up to 0.1.4 saved the pinned images like a choice; one of
	# those is not a choice, and must not hold a later pin back.
	case " $FORMER_CONVEX_IMAGES " in
	*" ${PANARA_CLOUD_CONVEX_IMAGE:-none} "*) PANARA_CLOUD_CONVEX_IMAGE="" ;;
	esac
	case " $FORMER_CONVEX_IMAGES " in
	*" ${PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE:-none} "*) PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE="" ;;
	esac
	# Empty unless chosen: the backend then follows the release (convex_ref).
	PANARA_CLOUD_CONVEX_IMAGE="${PANARA_CLOUD_CONVEX_IMAGE:-}"
	PANARA_CLOUD_CONVEX_REPOSITORY="$PANARA_CLOUD_REGISTRY/panara-cloud-convex"
	PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE="${PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE:-$DEFAULT_CONVEX_DASHBOARD_IMAGE}"
	PANARA_CLOUD_RELEASE_TAG="${PANARA_CLOUD_RELEASE_TAG:-latest}"
	PANARA_CLOUD_DOMAIN="${PANARA_CLOUD_DOMAIN:-}"
	PANARA_CLOUD_LETSENCRYPT_EMAIL="${PANARA_CLOUD_LETSENCRYPT_EMAIL:-}"
	if [ -n "$PANARA_CLOUD_DOMAIN" ]; then
		PANARA_CLOUD_HTTPS="${PANARA_CLOUD_HTTPS:-true}"
	else
		PANARA_CLOUD_HTTPS=false
	fi
	PANARA_CLOUD_HOST="${PANARA_CLOUD_HOST:-}"
	PANARA_CLOUD_PORT="${PANARA_CLOUD_PORT:-3000}"
	PANARA_CLOUD_CONVEX_PORT="${PANARA_CLOUD_CONVEX_PORT:-3210}"
	PANARA_CLOUD_CONVEX_SITE_PORT="${PANARA_CLOUD_CONVEX_SITE_PORT:-3211}"
	PANARA_CLOUD_LIVE_PORT="${PANARA_CLOUD_LIVE_PORT:-7100}"
	PANARA_CLOUD_DASHBOARD="${PANARA_CLOUD_DASHBOARD:-false}"
	PANARA_CLOUD_DASHBOARD_PORT="${PANARA_CLOUD_DASHBOARD_PORT:-6791}"
	PANARA_CLOUD_VERSION_URL="${PANARA_CLOUD_VERSION_URL:-}"
	PANARA_CLOUD_PULL="${PANARA_CLOUD_PULL:-always}"
	PANARA_CLOUD_AGENT_DRAIN_SECONDS="${PANARA_CLOUD_AGENT_DRAIN_SECONDS:-600}"
	case "$PANARA_CLOUD_AGENT_DRAIN_SECONDS" in
	'' | *[!0-9]*) die "PANARA_CLOUD_AGENT_DRAIN_SECONDS must be a number of seconds" ;;
	esac
	case "$PANARA_CLOUD_DOMAIN" in
	*[!A-Za-z0-9.-]* | .* | *. | -* | *..*)
		die "PANARA_CLOUD_DOMAIN must be a host name such as panel.example.com, without http:// or a path (got \"$PANARA_CLOUD_DOMAIN\")"
		;;
	esac
	case "$PANARA_CLOUD_LETSENCRYPT_EMAIL" in
	'' | ?*@?*.?*)
		case "$PANARA_CLOUD_LETSENCRYPT_EMAIL" in
		*[[:space:]\'\"]* | *@*@*) die "PANARA_CLOUD_LETSENCRYPT_EMAIL is not an email address" ;;
		esac
		;;
	*) die "PANARA_CLOUD_LETSENCRYPT_EMAIL is not an email address" ;;
	esac
	for port in "$PANARA_CLOUD_PORT" "$PANARA_CLOUD_CONVEX_PORT" "$PANARA_CLOUD_CONVEX_SITE_PORT" \
		"$PANARA_CLOUD_LIVE_PORT" "$PANARA_CLOUD_DASHBOARD_PORT"; do
		case "$port" in
		'' | *[!0-9]* | 0*) die "\"$port\" is not a port number" ;;
		esac
		[ "$port" -le 65535 ] || die "\"$port\" is not a port number"
	done
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		ports="80 443 $PANARA_CLOUD_PORT $PANARA_CLOUD_CONVEX_PORT $PANARA_CLOUD_CONVEX_SITE_PORT $PANARA_CLOUD_LIVE_PORT"
		# shellcheck disable=SC2086
		if [ "$(printf '%s\n' $ports | sort -u | wc -l)" -ne 6 ]; then
			die "The panel, Convex, Convex site and live ports must be four different ports, and not 80 or 443 (Traefik's)"
		fi
	fi
	# The panel keeps its own copy of the domain, HTTPS, the Let's Encrypt
	# email and the server's address, and Settings → Domain can change it. The
	# installer writes that copy on a first install and when one of the four
	# changes in this run, so a run that repeats the saved settings does not
	# undo what was set in the panel. For the same reason the panel's routing
	# is only removed by the run that takes the installer's own domain away.
	WEB_SERVER_CHANGED=1
	DOMAIN_REMOVED=false
	if [ "$HAVE_SAVED" = 1 ]; then
		if [ "$SAVED_DOMAIN" = "$PANARA_CLOUD_DOMAIN" ] &&
			[ "$SAVED_HTTPS" = "$PANARA_CLOUD_HTTPS" ] &&
			[ "$SAVED_LETSENCRYPT_EMAIL" = "$PANARA_CLOUD_LETSENCRYPT_EMAIL" ] &&
			[ "$SAVED_HOST" = "$PANARA_CLOUD_HOST" ]; then
			WEB_SERVER_CHANGED=0
		fi
		if [ -n "$SAVED_DOMAIN" ] && [ -z "$PANARA_CLOUD_DOMAIN" ]; then DOMAIN_REMOVED=true; fi
	fi
	# Published ports are changed only when the settings behind them change:
	# a domain taken away, or a port given a new number. A run that repeats the
	# saved settings leaves every service's ports as they are, whatever they are.
	PORTS_CHANGED=0
	if [ "$HAVE_SAVED" = 1 ] && [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		if [ -n "$SAVED_DOMAIN" ] ||
			[ "$SAVED_PORT" != "$PANARA_CLOUD_PORT" ] ||
			[ "$SAVED_CONVEX_PORT" != "$PANARA_CLOUD_CONVEX_PORT" ] ||
			[ "$SAVED_CONVEX_SITE_PORT" != "$PANARA_CLOUD_CONVEX_SITE_PORT" ] ||
			[ "$SAVED_LIVE_PORT" != "$PANARA_CLOUD_LIVE_PORT" ]; then
			PORTS_CHANGED=1
		fi
	fi
}

# NAME=value for install.env, which later runs read with `.`: a value with
# anything a shell would act on is single-quoted.
config_line() {
	case "$2" in
	*[!A-Za-z0-9_.:/@=+,-]*)
		printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"
		;;
	*) printf '%s=%s\n' "$1" "$2" ;;
	esac
}

save_config() {
	umask 077
	# The Convex images are saved only when they were chosen: a later installer
	# brings its own.
	convex_image="$PANARA_CLOUD_CONVEX_IMAGE"
	dashboard_image="$PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE"
	if [ "$dashboard_image" = "$DEFAULT_CONVEX_DASHBOARD_IMAGE" ]; then dashboard_image=""; fi
	{
		echo "# Panara Cloud install settings, read by install.sh upgrade. No secrets here."
		config_line PANARA_CLOUD_VERSION "$VERSION"
		config_line PANARA_CLOUD_REGISTRY "$PANARA_CLOUD_REGISTRY"
		config_line PANARA_CLOUD_WEB_IMAGE "$PANARA_CLOUD_WEB_IMAGE"
		config_line PANARA_CLOUD_AGENT_IMAGE "$PANARA_CLOUD_AGENT_IMAGE"
		config_line PANARA_CLOUD_MONITORING_IMAGE "$PANARA_CLOUD_MONITORING_IMAGE"
		config_line PANARA_CLOUD_MIGRATE_IMAGE "$PANARA_CLOUD_MIGRATE_IMAGE"
		config_line PANARA_CLOUD_CONVEX_IMAGE "$convex_image"
		config_line PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE "$dashboard_image"
		config_line PANARA_CLOUD_RELEASE_TAG "$PANARA_CLOUD_RELEASE_TAG"
		config_line PANARA_CLOUD_DOMAIN "$PANARA_CLOUD_DOMAIN"
		config_line PANARA_CLOUD_HTTPS "$PANARA_CLOUD_HTTPS"
		config_line PANARA_CLOUD_LETSENCRYPT_EMAIL "$PANARA_CLOUD_LETSENCRYPT_EMAIL"
		config_line PANARA_CLOUD_HOST "$PANARA_CLOUD_HOST"
		config_line PANARA_CLOUD_PORT "$PANARA_CLOUD_PORT"
		config_line PANARA_CLOUD_CONVEX_PORT "$PANARA_CLOUD_CONVEX_PORT"
		config_line PANARA_CLOUD_CONVEX_SITE_PORT "$PANARA_CLOUD_CONVEX_SITE_PORT"
		config_line PANARA_CLOUD_LIVE_PORT "$PANARA_CLOUD_LIVE_PORT"
		config_line PANARA_CLOUD_DASHBOARD "$PANARA_CLOUD_DASHBOARD"
		config_line PANARA_CLOUD_DASHBOARD_PORT "$PANARA_CLOUD_DASHBOARD_PORT"
		config_line PANARA_CLOUD_VERSION_URL "$PANARA_CLOUD_VERSION_URL"
		config_line PANARA_CLOUD_AGENT_DRAIN_SECONDS "$PANARA_CLOUD_AGENT_DRAIN_SECONDS"
	} >"$CONFIG"
	chmod 600 "$CONFIG"
	umask 022
}

require_root_linux() {
	[ "$(uname)" = Linux ] || die "Panara Cloud runs on Linux; this is $(uname)"
	[ "$(id -u)" = 0 ] || die "Run this as root: $(rerun "" "$COMMAND")"
	case "$(uname -m)" in
	x86_64 | amd64 | aarch64 | arm64) ;;
	*) die "Panara Cloud's images are built for x86-64 and arm64; this server is $(uname -m)" ;;
	esac
}

SWAP_COMMANDS="fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"

# While the functions deploy runs, its container holds 590-740 MiB and Convex
# grows to 480-580 MiB, together 0.8 to 1.0 GB more than the server held
# before (three runs on test stacks, and 2 GB servers). With less than
# UPDATE_REQUIRED_MB free the deploy would stall the whole server, so the run
# stops before it. With less than UPDATE_COMFORT_MB, Convex is restarted
# before the deploy too: that lowers the peak by what Convex held above some
# 250 MiB (20-120 MiB after light use, several hundred on one grown for days).
UPDATE_REQUIRED_MB=1000
UPDATE_COMFORT_MB=1500

# MEM_AVAILABLE, SWAP_FREE, SWAP_TOTAL and FREE_MB (available + free swap), MB.
read_memory() {
	MEM_AVAILABLE=""
	if command_exists free; then
		report=$(free -m 2>/dev/null || true)
		MEM_AVAILABLE=$(printf '%s\n' "$report" | awk '/^Mem:/ {print $7}')
		SWAP_TOTAL=$(printf '%s\n' "$report" | awk '/^Swap:/ {print $2}')
		SWAP_FREE=$(printf '%s\n' "$report" | awk '/^Swap:/ {print $4}')
	elif [ -r /proc/meminfo ]; then
		MEM_AVAILABLE=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
		SWAP_TOTAL=$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo)
		SWAP_FREE=$(awk '/^SwapFree:/ {print int($2 / 1024)}' /proc/meminfo)
	fi
	case "$MEM_AVAILABLE" in '' | *[!0-9]*) return 1 ;; esac
	case "${SWAP_TOTAL:-}" in '' | *[!0-9]*) SWAP_TOTAL=0 ;; esac
	case "${SWAP_FREE:-}" in '' | *[!0-9]*) SWAP_FREE=0 ;; esac
	FREE_MB=$((MEM_AVAILABLE + SWAP_FREE))
}

memory_now() {
	if [ "$SWAP_FREE" -gt 0 ]; then
		echo "$FREE_MB MB free ($MEM_AVAILABLE MB of memory available, $SWAP_FREE MB of swap)"
	else
		echo "$FREE_MB MB free ($MEM_AVAILABLE MB of memory available, no swap)"
	fi
}

# Before the functions deploy. PANARA_CLOUD_SKIP_MEMORY_CHECK=1 skips it.
make_room() {
	if [ "${PANARA_CLOUD_SKIP_MEMORY_CHECK:-}" = 1 ]; then return 0; fi
	read_memory || return 0
	if [ "$FREE_MB" -lt "$UPDATE_COMFORT_MB" ] && [ "$CONVEX_EXISTED" = 1 ]; then
		info "$(memory_now): short for the functions deploy. Restarting $SVC_CONVEX first to make room"
		docker service update --quiet --detach=false --force --update-order stop-first \
			"$SVC_CONVEX" >/dev/null ||
			warn "Docker reported a problem restarting $SVC_CONVEX (docker service ps $SVC_CONVEX)"
		wait_for_convex
		read_memory || return 0
	fi
	if [ "$FREE_MB" -lt "$UPDATE_REQUIRED_MB" ]; then
		die "Not enough free memory: $(memory_now), and deploying the backend's functions needs about $UPDATE_REQUIRED_MB MB on top of what runs now. The functions were not deployed and the web and agent services were not changed. Add swap ($SWAP_COMMANDS) or stop something, then run this again. PANARA_CLOUD_SKIP_MEMORY_CHECK=1 skips this check."
	fi
	if [ "$FREE_MB" -lt $((UPDATE_REQUIRED_MB + 300)) ]; then
		warn "$(memory_now): just enough for the functions deploy. The server may be slow for a minute."
	fi
}

# Warnings only, except for a disk too full to hold the images.
check_resources() {
	memory=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true)
	if command_exists free; then
		memory=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}')
	fi
	case "$memory" in '' | *[!0-9]*) memory="" ;; esac
	SWAP_TOTAL=$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true)
	if command_exists free; then
		SWAP_TOTAL=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')
	fi
	case "$SWAP_TOTAL" in '' | *[!0-9]*) SWAP_TOTAL=0 ;; esac
	if [ -n "$memory" ] && [ "$memory" -lt 3800 ] && [ "$SWAP_TOTAL" -lt 512 ]; then
		warn "This server has $memory MB of memory and no swap. Panara Cloud itself idles at about 0.6 GB,"
		warn "but each update needs about 1 GB more for a minute while it deploys the backend's functions,"
		warn "on top of whatever you host by then. Without swap, a server that runs short stalls or kills"
		warn "processes. To add 2 GB of swap:"
		warn "  $SWAP_COMMANDS"
	fi
	root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
	[ -n "$root" ] && [ -d "$root" ] || root=/
	disk=$(df -Pm "$root" 2>/dev/null | awk 'NR == 2 {print $4}')
	case "$disk" in '' | *[!0-9]*) return 0 ;; esac
	if ! service_exists "$SVC_WEB" && [ "$disk" -lt 4000 ]; then
		die "Only $disk MB free on $root. The images need about 3 GB before anything you deploy; free some space and run this again"
	fi
	if [ "$disk" -lt 10000 ]; then
		warn "Only $disk MB free on $root. The images take about 3 GB, and builds and deployments need more."
	fi
}

ensure_docker() {
	if command_exists docker; then
		docker info >/dev/null 2>&1 || die "Docker is installed but not running; start it (systemctl start docker) and run this again"
		return
	fi
	info "Installing Docker $DOCKER_VERSION"
	command_exists curl || die "curl is needed to install Docker: apt-get install -y curl (or install Docker yourself), then run this again"
	if ! curl -fsSL https://get.docker.com | sh -s -- --version "$DOCKER_VERSION"; then
		warn "Docker $DOCKER_VERSION is unavailable here; installing the latest Docker"
		curl -fsSL https://get.docker.com | sh
	fi
	command_exists docker || die "Docker installation failed; install it manually and run this again"
}

private_ip() {
	ip -o -4 addr show scope global 2>/dev/null |
		awk '$2 !~ /^(docker|br-|veth)/ {print $4}' | cut -d/ -f1 |
		grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1 || true
}

public_ip() {
	for url in https://ifconfig.io https://api.ipify.org https://icanhazip.com; do
		if command_exists curl; then
			ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null || true)
		elif command_exists wget; then
			ip=$(wget -4 -qO- -T 5 "$url" 2>/dev/null || true)
		else
			return 0
		fi
		case "$ip" in
		*[!0-9.]* | "") ;;
		*)
			echo "$ip"
			return
			;;
		esac
	done
}

ensure_swarm() {
	state=$(docker info --format '{{.Swarm.LocalNodeState}}')
	if [ "$state" = active ]; then
		[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" = true ] ||
			die "This node is a Swarm worker; run the installer on a manager"
		info "Using the existing Docker Swarm"
		return
	fi
	addr="${ADVERTISE_ADDR:-$(private_ip)}"
	[ -n "$addr" ] || addr=$(public_ip)
	[ -n "$addr" ] || die "Could not detect an address for Swarm; set ADVERTISE_ADDR"
	info "Initializing Docker Swarm on $addr"
	# shellcheck disable=SC2086
	docker swarm init --advertise-addr "$addr" ${DOCKER_SWARM_INIT_ARGS:-} >/dev/null
}

# Swarm's ports (2377/tcp, 7946/tcp+udp, 4789/udp) listen on every address,
# so on a server with only a public address they'd answer from the internet.
# The block between the markers is generated from
# apps/agent/src/infra/swarmFirewall.ts (swarmFirewallSetup(false)); its test
# fails when they differ.
ensure_swarm_firewall() {
	conf="$BASE/swarm-firewall.env"
	case "${PANARA_CLOUD_SWARM_PUBLIC:-}" in
	'' | 0 | 1) ;;
	*) die "PANARA_CLOUD_SWARM_PUBLIC must be 0 or 1" ;;
	esac
	case "${PANARA_CLOUD_SWARM_ALLOW:-}" in
	*[!0-9A-Fa-f.:/\ ]*) die "PANARA_CLOUD_SWARM_ALLOW takes addresses or CIDRs separated by spaces" ;;
	esac
	if [ -n "${PANARA_CLOUD_SWARM_PUBLIC:-}" ] || [ -n "${PANARA_CLOUD_SWARM_ALLOW:-}" ]; then
		mkdir -p "$BASE"
		printf 'PANARA_CLOUD_SWARM_PUBLIC=%s\nPANARA_CLOUD_SWARM_ALLOW="%s"\n' \
			"${PANARA_CLOUD_SWARM_PUBLIC:-}" "${PANARA_CLOUD_SWARM_ALLOW:-}" >"$conf"
		chmod 644 "$conf"
	fi
	info "Configuring the Docker Swarm port firewall"
	SUDO_CMD=""
	# BEGIN generated swarm firewall

$SUDO_CMD mkdir -p /etc/panara-cloud
$SUDO_CMD tee /usr/local/sbin/panara-cloud-swarm-firewall >/dev/null <<'PANARA_CLOUD_SWARM_FIREWALL'
#!/bin/sh
# Panara Cloud: keeps Docker Swarm's ports (2377/tcp, 7946/tcp+udp, 4789/udp)
# reachable only from loopback, private networks, the Swarm's current nodes
# and the addresses in PANARA_CLOUD_SWARM_ALLOW.
# Settings: /etc/panara-cloud/swarm-firewall.env
#   PANARA_CLOUD_SWARM_PUBLIC=1             leave the ports open
#   PANARA_CLOUD_SWARM_ALLOW="203.0.113.7"  other nodes (addresses or CIDRs)
# Usage: panara-cloud-swarm-firewall [apply|boot|remove]
set -u
PANARA_CLOUD_SWARM_PUBLIC=
PANARA_CLOUD_SWARM_ALLOW=
if [ -f /etc/panara-cloud/swarm-firewall.env ]; then
	# shellcheck disable=SC1091
	. /etc/panara-cloud/swarm-firewall.env
fi
CHAIN=PANARA_CLOUD_SWARM
PORTS="tcp:2377 tcp:7946 udp:7946 udp:4789"
V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"
V6="fc00::/7 fe80::/10"
PEERS=/etc/panara-cloud/swarm-firewall.peers

has() { command -v "$1" >/dev/null 2>&1; }

# Nodes already in the Swarm stay allowed. The boot unit runs before Docker
# (and any docker call would wait for it through socket activation), so it
# uses the list saved by the last run.
if [ "${1:-apply}" = apply ] && has docker && docker info >/dev/null 2>&1; then
	{
		docker info --format '{{range .Swarm.RemoteManagers}}{{.Addr}} {{end}}' 2>/dev/null | tr ' ' '\n'
		docker node ls -q 2>/dev/null | xargs -r docker node inspect --format '{{.Status.Addr}}' 2>/dev/null
	} | sed -e 's/:[0-9]*$//' -e 's/^\[//' -e 's/\]$//' |
		grep -E '^[0-9a-fA-F.:]+$' | grep -vx '0.0.0.0' | sort -u >"$PEERS.tmp" || true
	mv "$PEERS.tmp" "$PEERS"
fi
if [ -f "$PEERS" ]; then PANARA_CLOUD_SWARM_ALLOW="$PANARA_CLOUD_SWARM_ALLOW $(cat "$PEERS")"; fi
for src in $PANARA_CLOUD_SWARM_ALLOW; do
	case "$src" in
	*:*) V6="$V6 $src" ;;
	*) V4="$V4 $src" ;;
	esac
done

ufw_active() { has ufw && ufw status 2>/dev/null | grep -q '^Status: active'; }

clear_chain() {
	has "$1" || return 0
	for p in $PORTS; do
		while "$1" -w -D INPUT -p "${p%%:*}" --dport "${p#*:}" -j "$CHAIN" 2>/dev/null; do :; done
	done
	"$1" -w -F "$CHAIN" 2>/dev/null || true
	"$1" -w -X "$CHAIN" 2>/dev/null || true
}

apply_chain() {
	has "$1" || return 0
	"$1" -w -N "$CHAIN" 2>/dev/null || "$1" -w -F "$CHAIN"
	"$1" -w -A "$CHAIN" -i lo -j RETURN
	for src in $2; do "$1" -w -A "$CHAIN" -s "$src" -j RETURN; done
	"$1" -w -A "$CHAIN" -j DROP
	for p in $PORTS; do
		"$1" -w -C INPUT -p "${p%%:*}" --dport "${p#*:}" -j "$CHAIN" 2>/dev/null ||
			"$1" -w -I INPUT 1 -p "${p%%:*}" --dport "${p#*:}" -j "$CHAIN"
	done
}

# ufw keeps its rules itself; prepend puts each rule first in its address
# family, so the allows end up ahead of the deny.
ufw_rules() {
	for p in $PORTS; do
		ufw "$@" deny proto "${p%%:*}" to any port "${p#*:}" >/dev/null 2>&1 || true
		for src in $V4 $V6; do
			ufw "$@" allow proto "${p%%:*}" from "$src" to any port "${p#*:}" >/dev/null 2>&1 || true
		done
	done
}

remove_all() {
	clear_chain iptables
	clear_chain ip6tables
	if has ufw; then ufw_rules delete; fi
}

if [ "${1:-apply}" = remove ] || [ "$PANARA_CLOUD_SWARM_PUBLIC" = 1 ]; then
	remove_all
	echo "Swarm ports are not filtered"
	exit 0
fi
if ufw_active; then
	clear_chain iptables
	clear_chain ip6tables
	ufw_rules prepend
	echo "Swarm ports limited to private sources (ufw)"
elif has iptables; then
	apply_chain iptables "$V4"
	apply_chain ip6tables "$V6"
	echo "Swarm ports limited to private sources (iptables)"
else
	echo "Neither ufw nor iptables found; block 2377/tcp, 7946/tcp+udp and 4789/udp in your provider's firewall" >&2
fi
PANARA_CLOUD_SWARM_FIREWALL
$SUDO_CMD chmod 755 /usr/local/sbin/panara-cloud-swarm-firewall
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	$SUDO_CMD tee /etc/systemd/system/panara-cloud-swarm-firewall.service >/dev/null <<'PANARA_CLOUD_SWARM_FIREWALL'
[Unit]
Description=Panara Cloud: keep Docker Swarm ports private
After=network-pre.target ufw.service firewalld.service netfilter-persistent.service
Before=docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/panara-cloud-swarm-firewall boot

[Install]
WantedBy=multi-user.target
PANARA_CLOUD_SWARM_FIREWALL
	$SUDO_CMD systemctl daemon-reload
	$SUDO_CMD systemctl enable panara-cloud-swarm-firewall.service >/dev/null 2>&1 || true
fi
$SUDO_CMD /usr/local/sbin/panara-cloud-swarm-firewall apply
	# END generated swarm firewall
}

ensure_network() {
	if docker network inspect "$NETWORK" >/dev/null 2>&1; then
		return
	fi
	info "Creating network $NETWORK"
	docker network create --driver overlay --attachable "$NETWORK" >/dev/null
}

ensure_dirs() {
	mkdir -p "$BASE" "$SECRETS"
	chmod 755 "$BASE"
	chmod 700 "$SECRETS"
}

port_in_use() {
	if command_exists ss; then
		ss -Hltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
	elif command_exists netstat; then
		netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
	else
		return 1
	fi
}

published_ports() {
	docker service inspect "$1" \
		--format '{{range .Spec.EndpointSpec.Ports}}{{.PublishedPort}} {{end}}' 2>/dev/null || true
}

check_ports() {
	if service_exists "$SVC_WEB"; then
		# A rerun keeps the ports its own services and Traefik already hold. A
		# port it is about to publish must be free, or the service that gets
		# it would not start again.
		if [ "$PORTS_CHANGED" != 1 ]; then return; fi
		held=" $(published_ports "$SVC_WEB") $(published_ports "$SVC_CONVEX") $(published_ports "$SVC_AGENT") "
		for port in $PANARA_CLOUD_PORT $PANARA_CLOUD_CONVEX_PORT $PANARA_CLOUD_CONVEX_SITE_PORT $PANARA_CLOUD_LIVE_PORT; do
			case "$held" in *" $port "*) continue ;; esac
			if port_in_use "$port"; then die "Port $port is already in use by something else on this server; nothing was changed"; fi
		done
		return
	fi
	ports="80 443"
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		ports="$ports $PANARA_CLOUD_PORT $PANARA_CLOUD_CONVEX_PORT $PANARA_CLOUD_CONVEX_SITE_PORT $PANARA_CLOUD_LIVE_PORT"
	fi
	if [ "$PANARA_CLOUD_DASHBOARD" = true ]; then ports="$ports $PANARA_CLOUD_DASHBOARD_PORT"; fi
	# A first install that stopped half-way left services behind; their ports
	# are this install's own.
	held=" $(published_ports "$SVC_CONVEX") $(published_ports "$SVC_AGENT") $(published_ports "$SVC_DASHBOARD") "
	for port in $ports; do
		case "$held" in *" $port "*) continue ;; esac
		if port_in_use "$port"; then
			if [ "$port" = 80 ] || [ "$port" = 443 ]; then
				docker container inspect panara-cloud-traefik >/dev/null 2>&1 && continue
				die "Port $port is already in use$(port_owner "$port"). Traefik needs ports 80 and 443 for the panel and everything you deploy: stop what holds them (a web server such as nginx, apache2 or caddy: systemctl disable --now <name>) and run this again"
			fi
			die "Port $port is already in use$(port_owner "$port"). Free it, or choose another with ${PORT_VARIABLE_HINT}, and run this again"
		fi
	done
}

PORT_VARIABLE_HINT="PANARA_CLOUD_PORT, PANARA_CLOUD_CONVEX_PORT, PANARA_CLOUD_CONVEX_SITE_PORT or PANARA_CLOUD_LIVE_PORT"

# " by nginx" when the listener's name can be read (ss, as root), else nothing.
port_owner() {
	command_exists ss || return 0
	name=$(ss -Hltnp 2>/dev/null | awk -v port="$1" '$4 ~ "[:.]" port "$" {print}' |
		sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n1)
	if [ -n "$name" ]; then printf ' by %s' "$name"; fi
}

pull() {
	if [ "$PANARA_CLOUD_PULL" = never ]; then
		docker image inspect "$1" >/dev/null 2>&1 || die "Image $1 is not available locally"
		return
	fi
	# Registries drop large layer downloads now and then ("failed to copy: ...
	# EOF"); a retry resumes from the layers already fetched.
	attempt=1
	while ! docker pull -q "$1" >/dev/null; do
		if [ "$attempt" -ge 5 ]; then
			docker image inspect "$1" >/dev/null 2>&1 ||
				die "Could not pull $1 after $attempt attempts. Run the same command again to retry."
			warn "Could not pull $1; using the local image"
			return
		fi
		warn "Pulling $1 failed; retrying ($attempt of 4)"
		sleep $((attempt * 5))
		attempt=$((attempt + 1))
	done
}

# x.y.z or vx.y.z: a release, published under that tag.
is_release() {
	case "${1#v}" in
	*[!0-9.]* | *.*.*.* | .* | *. | *..*) return 1 ;;
	*.*.*) return 0 ;;
	esac
	return 1
}

service_image() {
	docker service inspect "$1" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true
}

# What a plain `install` on an installed host runs: the version it already
# has. A release is found again by its tag. A channel build is labelled
# x.y.z-<channel>.<commit>, which is no tag anywhere, and its channel tag has
# moved on since, so the services keep the exact images they run now.
keep_running_images() {
	[ -z "$VERSION_ARG" ] && [ -f "$CONFIG" ] || return 1
	if is_release "${PANARA_CLOUD_VERSION:-}"; then return 1; fi
	WEB_REF=$(service_image "$SVC_WEB")
	AGENT_REF=$(service_image "$SVC_AGENT")
	[ -n "$WEB_REF" ] && [ -n "$AGENT_REF" ] || return 1
	CONVEX_REF="$PANARA_CLOUD_CONVEX_IMAGE"
	[ -n "$CONVEX_REF" ] || CONVEX_REF=$(service_image "$SVC_CONVEX")
	[ -n "$CONVEX_REF" ] || CONVEX_REF=$(convex_ref "$PANARA_CLOUD_RELEASE_TAG")
	VERSION="${PANARA_CLOUD_VERSION:-unknown}"
	KEEP_IMAGES=1
	info "Keeping the running images ($VERSION); to move to the newest $PANARA_CLOUD_RELEASE_TAG build: $(rerun "" upgrade)"
}

# Resolves the release to install: an explicit x.y.z, or the version label of
# the image behind a channel tag ("latest", "canary").
resolve_version() {
	requested="${1:-latest}"
	if is_release "$requested"; then
		VERSION="${requested#v}"
		return
	fi
	case "$requested" in
	[0-9]*.[0-9]*.[0-9]*-*)
		die "$requested is the version label of a channel build, not a tag in the registry. Pass the channel instead, such as PANARA_CLOUD_VERSION=canary"
		;;
	esac
	info "Resolving $PANARA_CLOUD_AGENT_IMAGE:$requested" >&2
	pull "$PANARA_CLOUD_AGENT_IMAGE:$requested"
	VERSION=$(docker image inspect "$PANARA_CLOUD_AGENT_IMAGE:$requested" \
		--format '{{index .Config.Labels "org.opencontainers.image.version"}}')
	[ -n "$VERSION" ] || die "$PANARA_CLOUD_AGENT_IMAGE:$requested has no version label"
	# Moving channels stay on their tag so the panel's update check can compare
	# digests (PANARA_CLOUD_RELEASE_TAG).
	if [ "$requested" != latest ]; then
		PANARA_CLOUD_RELEASE_TAG="$requested"
		IMAGE_TAG="$requested"
	fi
}

# Let's Encrypt reaches the domain on port 80 of the address it resolves to:
# say so now when that is not this server, not after the certificate failed.
check_domain() {
	if [ "$PANARA_CLOUD_HTTPS" = true ] && [ -z "$PANARA_CLOUD_LETSENCRYPT_EMAIL" ]; then
		warn "No PANARA_CLOUD_LETSENCRYPT_EMAIL: the certificate is requested with a placeholder address."
		warn "Pass your email so Let's Encrypt can reach you about it."
	fi
	command_exists getent || return 0
	resolved=$(getent ahostsv4 "$PANARA_CLOUD_DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
	if [ -z "$resolved" ]; then
		warn "$PANARA_CLOUD_DOMAIN does not resolve yet. Create an A record that points at this server${PANARA_CLOUD_HOST:+ ($PANARA_CLOUD_HOST)};"
		warn "the panel answers on the domain, and its certificate is issued, once it does."
		return 0
	fi
	[ -n "$PANARA_CLOUD_HOST" ] || return 0
	case " $resolved" in
	*" $PANARA_CLOUD_HOST "*) ;;
	*)
		warn "$PANARA_CLOUD_DOMAIN resolves to ${resolved% }, not to this server ($PANARA_CLOUD_HOST)."
		warn "Behind a proxy such as Cloudflare that is expected; otherwise fix the A record, or the certificate cannot be issued."
		;;
	esac
}

derive_urls() {
	if [ -n "$PANARA_CLOUD_DOMAIN" ]; then
		scheme=http
		ws=ws
		if [ "$PANARA_CLOUD_HTTPS" = true ]; then
			scheme=https
			ws=wss
		fi
		SITE_URL="$scheme://$PANARA_CLOUD_DOMAIN"
		CONVEX_PUBLIC_URL="$SITE_URL/convex"
		CONVEX_PUBLIC_SITE_URL="$SITE_URL/convex-site"
		LIVE_URL="$ws://$PANARA_CLOUD_DOMAIN"
		# The panel still needs the server's address (database connection
		# strings, DNS hints); a miss here is not fatal, it can be set in the UI.
		if [ -z "$PANARA_CLOUD_HOST" ]; then
			PANARA_CLOUD_HOST=$(public_ip) || PANARA_CLOUD_HOST=
		fi
		check_domain
	else
		if [ -z "$PANARA_CLOUD_HOST" ]; then
			PANARA_CLOUD_HOST=$(public_ip)
			if [ -z "$PANARA_CLOUD_HOST" ]; then
				PANARA_CLOUD_HOST=$(private_ip)
				[ -n "$PANARA_CLOUD_HOST" ] || die "Could not detect this server's address. Pass it: $(rerun "PANARA_CLOUD_HOST=<address>" "$COMMAND")"
				warn "Could not detect a public address; using the private one, $PANARA_CLOUD_HOST."
				warn "If you reach this server on another address, pass it: $(rerun "PANARA_CLOUD_HOST=<address>" "$COMMAND")"
			fi
		fi
		SITE_URL="http://$PANARA_CLOUD_HOST:$PANARA_CLOUD_PORT"
		CONVEX_PUBLIC_URL="http://$PANARA_CLOUD_HOST:$PANARA_CLOUD_CONVEX_PORT"
		CONVEX_PUBLIC_SITE_URL="http://$PANARA_CLOUD_HOST:$PANARA_CLOUD_CONVEX_SITE_PORT"
		LIVE_URL="ws://$PANARA_CLOUD_HOST:$PANARA_CLOUD_LIVE_PORT"
	fi
	CONVEX_INTERNAL_URL="http://$SVC_CONVEX:3210"
	CONVEX_INTERNAL_SITE_URL="http://$SVC_CONVEX:3211"
}

# create_service NAME IMAGE [create-only args...] -- [ENV=value...]
create_service() {
	name="$1"
	image="$2"
	shift 2
	count=$#
	envs=0
	for arg in "$@"; do
		if [ "$envs" = 0 ]; then
			if [ "$arg" = -- ]; then envs=1; else set -- "$@" "$arg"; fi
		else
			set -- "$@" --env "$arg"
		fi
	done
	shift "$count"
	docker service create --quiet --detach=false --with-registry-auth \
		--name "$name" "$@" "$image" >/dev/null
}

# Whether SERVICE already runs IMAGE. Swarm records an image with the digest
# it resolved ("repo:tag@sha256:..."); a tag is the same image only while the
# local one, pulled a moment ago, still has that digest.
same_image() {
	current=$(service_image "$1")
	if [ "$current" = "$2" ]; then return 0; fi
	case "$current" in
	"$2"@sha256:*)
		docker image inspect "$2" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null |
			grep -q "@${current##*@}\$"
		;;
	*) return 1 ;;
	esac
}

# update_service NAME IMAGE [ENV=value... | --flag value...]
# Sends the service only what differs from what it has, and nothing at all
# when nothing does. A variable passed again with the value it already has
# still moves within the service's list, and Swarm replaces the task for
# that alone: a re-run that changed no setting used to restart Convex, the
# agent and the web server this way. Sets UPDATED to 1 when it sent something.
update_service() {
	name="$1"
	image="$2"
	shift 2
	have=$(docker service inspect "$name" \
		--format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null || true)
	count=$#
	flag=""
	for arg in "$@"; do
		if [ -n "$flag" ]; then
			if [ "$flag" != --stop-grace-period ] || [ "$(stop_grace "$name")" != "${arg%s}000000000" ]; then
				set -- "$@" "$flag" "$arg"
			fi
			flag=""
		else
			case "$arg" in
			--*) flag="$arg" ;;
			*) printf '%s\n' "$have" | grep -qxF -- "$arg" || set -- "$@" --env-add "$arg" ;;
			esac
		fi
	done
	shift "$count"
	if ! same_image "$name" "$image"; then set -- --image "$image" "$@"; fi
	UPDATED=0
	if [ $# = 0 ]; then return 0; fi
	UPDATED=1
	docker service update --quiet --detach=false --with-registry-auth "$@" "$name" >/dev/null
}

# The service's stop grace period in nanoseconds, as Swarm stores it.
stop_grace() {
	docker service inspect "$1" \
		--format '{{json .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}' 2>/dev/null || true
}

# publish_diff SERVICE "PUBLISHED:TARGET ..." "TARGET ..."
# Prints the --publish-rm and --publish-add flags after which SERVICE
# publishes exactly the wanted pairs, in host mode, among the target ports
# named by the pairs and by the third argument (targets it may have published
# before). Publications of any other target are not its business.
publish_diff() {
	name="$1"
	wanted="$2"
	targets="${3:-}"
	for pair in $wanted; do targets="$targets ${pair#*:}"; done
	# Host-mode ports are only removed when given by their full spec;
	# `--publish-rm <target>` leaves them published.
	current=$(docker service inspect "$name" \
		--format '{{range .Spec.EndpointSpec.Ports}}{{.PublishedPort}},{{.TargetPort}},{{.PublishMode}} {{end}}' 2>/dev/null || true)
	for port in $current; do
		published="${port%%,*}"
		mode="${port##*,}"
		target="${port#*,}"
		target="${target%%,*}"
		case " $targets " in *" $target "*) ;; *) continue ;; esac
		if [ "$mode" = host ]; then
			case " $wanted " in *" $published:$target "*) continue ;; esac
		fi
		printf ' --publish-rm published=%s,target=%s,mode=%s' "$published" "$target" "$mode"
	done
	for pair in $wanted; do
		case " $current " in
		*" ${pair%%:*},${pair#*:},host "*) ;;
		*) printf ' --publish-add published=%s,target=%s,mode=host' "${pair%%:*}" "${pair#*:}" ;;
		esac
	done
}

# The port flags for an existing web, Convex or agent service.
said_updated() {
	if [ "$UPDATED" = 1 ]; then info "Updated $1"; else info "$1 is as it should be"; fi
}

# With a domain, Traefik serves the panel, Convex and the live endpoint on the
# HTTPS origin, so nothing else may be published: a direct port would bypass
# TLS. Without one the ports are published, but an existing service is only
# brought in line when the domain or a port setting changed in this run
# (PORTS_CHANGED): "Direct access on port 3000" in the panel may have closed
# a port on purpose.
port_args() {
	if [ -n "$PANARA_CLOUD_DOMAIN" ]; then
		publish_diff "$1" "" "$3 ${2#*:}"
	elif [ "$PORTS_CHANGED" = 1 ]; then
		publish_diff "$1" "$2" "$3"
	fi
}

# Prints the CONVEX_SETTINGS entries whose variable the service doesn't have.
# A variable set by hand counts as present whatever its value, an empty one
# included (an empty DISABLE_BEACON turns the beacon back on).
missing_convex_settings() {
	have=$(docker service inspect "$SVC_CONVEX" \
		--format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null |
		sed 's/=.*//')
	for setting in $CONVEX_SETTINGS; do
		printf '%s\n' "$have" | grep -qxF "${setting%%=*}" || printf ' %s' "$setting"
	done
}

deploy_convex() {
	set -- \
		"INSTANCE_NAME=panara-cloud" \
		"CONVEX_CLOUD_ORIGIN=$CONVEX_PUBLIC_URL" \
		"CONVEX_SITE_ORIGIN=$CONVEX_PUBLIC_SITE_URL" \
		"DISABLE_METRICS_ENDPOINT=true" \
		"REDACT_LOGS_TO_CLIENT=true"
	CONVEX_EXISTED=0
	if service_exists "$SVC_CONVEX"; then
		CONVEX_EXISTED=1
		# shellcheck disable=SC2046
		set -- "$@" $(missing_convex_settings) $(port_args "$SVC_CONVEX" "$PANARA_CLOUD_CONVEX_PORT:3210" "") \
			$(port_args "$SVC_CONVEX" "$PANARA_CLOUD_CONVEX_SITE_PORT:3211" "")
		if ! same_image "$SVC_CONVEX" "$CONVEX_REF"; then
			info "Moving $SVC_CONVEX to $CONVEX_REF"
		fi
		update_service "$SVC_CONVEX" "$CONVEX_REF" "$@"
		said_updated "$SVC_CONVEX"
		return
	fi
	info "Creating $SVC_CONVEX"
	# shellcheck disable=SC2086
	set -- "$@" $CONVEX_SETTINGS
	publish=""
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		publish="--publish published=$PANARA_CLOUD_CONVEX_PORT,target=3210,mode=host --publish published=$PANARA_CLOUD_CONVEX_SITE_PORT,target=3211,mode=host"
	fi
	# SQLite has a single writer: never run two backends on the same volume.
	# shellcheck disable=SC2086
	create_service "$SVC_CONVEX" "$CONVEX_REF" \
		--network "$NETWORK" \
		--constraint node.role==manager \
		--mount type=volume,source=panara-cloud-convex-data,target=/convex/data \
		--stop-signal SIGINT --stop-grace-period 30s \
		--update-order stop-first \
		--health-cmd "curl -fsS http://localhost:3210/version" \
		--health-interval 5s --health-start-period 20s --health-retries 12 \
		$publish \
		-- "$@"
}

deploy_dashboard() {
	if [ "$PANARA_CLOUD_DASHBOARD" != true ]; then return; fi
	set -- "NEXT_PUBLIC_DEPLOYMENT_URL=$CONVEX_PUBLIC_URL"
	if service_exists "$SVC_DASHBOARD"; then
		if [ "$HAVE_SAVED" = 1 ] && [ "$SAVED_DASHBOARD_PORT" != "$PANARA_CLOUD_DASHBOARD_PORT" ]; then
			# shellcheck disable=SC2046
			set -- "$@" $(publish_diff "$SVC_DASHBOARD" "$PANARA_CLOUD_DASHBOARD_PORT:6791" "")
		fi
		update_service "$SVC_DASHBOARD" "$PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE" "$@"
		return
	fi
	info "Creating $SVC_DASHBOARD on port $PANARA_CLOUD_DASHBOARD_PORT"
	create_service "$SVC_DASHBOARD" "$PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE" \
		--network "$NETWORK" \
		--constraint node.role==manager \
		--publish "published=$PANARA_CLOUD_DASHBOARD_PORT,target=6791,mode=host" \
		-- "$@"
}

convex_container() {
	docker ps -q --filter "label=com.docker.swarm.service.name=$SVC_CONVEX" | head -n1
}

wait_for_convex() {
	i=0
	while [ "$i" -lt 60 ]; do
		if docker run --rm --network "$NETWORK" "$AGENT_RUN_REF" \
			curl -fsS -o /dev/null "http://$SVC_CONVEX:3210/version" 2>/dev/null; then
			return
		fi
		i=$((i + 1))
		sleep 3
	done
	die "Convex did not come back; see: docker service logs $SVC_CONVEX"
}

# Pushing the functions leaves the backend holding several hundred MiB it never
# gives back, and its Node executor running; a restart is the only thing that
# returns them. Runs before the web and agent services move to the new images,
# so they connect to the restarted backend once. Stop-first is repeated here
# because SQLite has a single writer and the service may predate that setting.
# The new functions are live by now, so only a backend that stays down stops
# the run: the web and agent services have to follow them.
restart_convex() {
	info "Restarting $SVC_CONVEX to release the memory the functions deploy used"
	docker service update --quiet --detach=false --force --update-order stop-first \
		"$SVC_CONVEX" >/dev/null ||
		warn "Docker reported a problem restarting $SVC_CONVEX (docker service ps $SVC_CONVEX); to retry later: docker service update --force $SVC_CONVEX"
	wait_for_convex
}

ensure_admin_key() {
	if [ -s "$ADMIN_KEY_FILE" ]; then return; fi
	info "Generating the Convex admin key ($ADMIN_KEY_FILE)"
	cid=$(convex_container)
	[ -n "$cid" ] || die "$SVC_CONVEX has no running container on this node"
	umask 077
	docker exec "$cid" ./generate_admin_key.sh 2>/dev/null | tail -n1 >"$ADMIN_KEY_FILE.tmp"
	umask 022
	[ -s "$ADMIN_KEY_FILE.tmp" ] || die "Could not generate the Convex admin key"
	mv "$ADMIN_KEY_FILE.tmp" "$ADMIN_KEY_FILE"
}

# Shared by the web app's auth proxy and Convex: it vouches for the client IP
# the proxy passes on, which sign-in rate limits key on.
ensure_proxy_secret() {
	if [ -s "$PROXY_SECRET_FILE" ]; then return; fi
	umask 077
	head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$PROXY_SECRET_FILE"
	umask 022
	[ -s "$PROXY_SECRET_FILE" ] || die "Could not generate $PROXY_SECRET_FILE"
}

write_convex_env() {
	umask 077
	{
		echo "SITE_URL=$SITE_URL"
		echo "PANARA_CLOUD_PROXY_SECRET=$(cat "$PROXY_SECRET_FILE")"
		echo "PANARA_CLOUD_LIVE_URL=$LIVE_URL"
		# A file keeps the key off command lines and out of `ps`.
		if [ -n "${RESEND_API_KEY_FILE:-}" ]; then
			[ -r "$RESEND_API_KEY_FILE" ] || die "Cannot read RESEND_API_KEY_FILE"
			RESEND_API_KEY=$(tr -d '\r\n' <"$RESEND_API_KEY_FILE")
		fi
		if [ -n "${RESEND_API_KEY:-}" ]; then echo "RESEND_API_KEY=$RESEND_API_KEY"; fi
		if [ -n "${AUTH_EMAIL_FROM:-}" ]; then echo "AUTH_EMAIL_FROM=$AUTH_EMAIL_FROM"; fi
		if [ -n "${RESEND_TEST_MODE:-}" ]; then echo "RESEND_TEST_MODE=$RESEND_TEST_MODE"; fi
	} >"$CONVEX_ENV_FILE"
	umask 022
}

json_string() {
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

web_server_json() {
	if [ -n "$PANARA_CLOUD_DOMAIN" ]; then
		printf '{"host":%s,"https":%s' "$(json_string "$PANARA_CLOUD_DOMAIN")" "$PANARA_CLOUD_HTTPS"
	else
		printf '{"https":false'
	fi
	if [ -n "$PANARA_CLOUD_LETSENCRYPT_EMAIL" ]; then
		printf ',"letsEncryptEmail":%s' "$(json_string "$PANARA_CLOUD_LETSENCRYPT_EMAIL")"
	fi
	if [ -n "$PANARA_CLOUD_HOST" ]; then
		printf ',"serverIp":%s' "$(json_string "$PANARA_CLOUD_HOST")"
	fi
	printf '}'
}

# One line that differs whenever `migrate` would have something to do: the
# image whose functions are pushed, the addresses it writes into the
# backend's environment or the functions are built with, and the proxy
# secret (as a short digest).
functions_state() {
	printf '%s %s %s %s %s %s\n' "$AGENT_RUN_REF" "$CONVEX_PUBLIC_URL" "$CONVEX_PUBLIC_SITE_URL" \
		"$SITE_URL" "$LIVE_URL" "$(sha256sum <"$PROXY_SECRET_FILE" | cut -c1-12)"
}

# Pushing functions that are already there costs the same as pushing new
# ones (about 1 GB of memory for a minute, and Convex ends several hundred
# MiB larger until it is restarted), so a run that would push the same
# functions to the same addresses skips the deploy and the restart after it.
# The panel's own Update does not write this file, so it can name an older
# version than the one running: the functions on Convex are then the running
# agent's, and they are deployed again unless that agent is the one this run
# installs (a rollback after an in-panel update must not keep newer
# functions). PANARA_CLOUD_FORCE_DEPLOY=1 deploys anyway.
needs_migrate() {
	if [ "${PANARA_CLOUD_FORCE_DEPLOY:-}" = 1 ] || [ "$CONVEX_EXISTED" != 1 ] ||
		[ "$WEB_SERVER_CHANGED" = 1 ] || [ ! -s "$AGENT_SECRET_FILE" ] ||
		[ -n "${RESEND_API_KEY_FILE:-}${RESEND_API_KEY:-}${AUTH_EMAIL_FROM:-}${RESEND_TEST_MODE:-}" ]; then
		return 0
	fi
	running=$(service_image "$SVC_AGENT")
	running_id=""
	[ -n "$running" ] && running_id=$(docker image inspect --format '{{.Id}}' "$running" 2>/dev/null || true)
	[ "$running_id" != "$AGENT_RUN_REF" ] && return 0
	[ "$(cat "$BASE/functions-deployed" 2>/dev/null || true)" != "$(functions_state)" ]
}

deploy_functions() {
	if needs_migrate; then
		migrate
		restart_convex
		functions_state >"$BASE/functions-deployed"
	else
		info "The functions of $VERSION are already deployed"
	fi
}

# The functions and the CLI that deploys them are in the migrate image of
# the agent's exact build: the tag is the agent image's version label, which
# names a channel build too. Only a deploy needs it, so it is pulled here and
# removed afterwards (the next release brings its own); it gets the admin
# key, so it runs by the ID resolved now, like the agent image.
pull_migrate_image() {
	label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$AGENT_RUN_REF" 2>/dev/null || true)
	MIGRATE_REF="$PANARA_CLOUD_MIGRATE_IMAGE:${label:-$VERSION}"
	if [ "$KEEP_IMAGES" != 1 ] || ! docker image inspect "$MIGRATE_REF" >/dev/null 2>&1; then
		pull "$MIGRATE_REF"
	fi
	MIGRATE_RUN_REF=$(docker image inspect --format '{{.Id}}' "$MIGRATE_REF") ||
		die "Image $MIGRATE_REF is not available locally"
}

remove_migrate_image() {
	docker image rm "$MIGRATE_REF" >/dev/null 2>&1 || true
}

# Pushes the release's Convex functions, applies env and data migrations,
# and enrolls the panel agent on first install, before any web/agent service
# moves to the new version.
migrate() {
	pull_migrate_image
	make_room
	info "Deploying Convex functions and running migrations"
	write_convex_env
	set -- -e "PANARA_CLOUD_CONVEX_ENV_FILE=$CONVEX_ENV_FILE"
	if [ "$WEB_SERVER_CHANGED" = 1 ]; then
		set -- "$@" -e "PANARA_CLOUD_WEB_SERVER=$(web_server_json)"
	fi
	# --oom-score-adj: on a server that runs out of memory the kernel kills
	# this one-off container first, not Convex or something you host.
	if ! docker run --rm --oom-score-adj 1000 --network "$NETWORK" \
		-v "$SECRETS:$SECRETS" \
		-e "CONVEX_SELF_HOSTED_URL=$CONVEX_INTERNAL_URL" \
		-e "CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
		-e "PANARA_CLOUD_AGENT_SECRET_FILE=$AGENT_SECRET_FILE" \
		-e "PANARA_CLOUD_VERSION=$VERSION" \
		"$@" "$MIGRATE_RUN_REF" migrate; then
		rm -f "$CONVEX_ENV_FILE"
		remove_migrate_image
		die "Deploying the Convex functions failed; the web and agent services were not changed"
	fi
	rm -f "$CONVEX_ENV_FILE"
	remove_migrate_image
}

upstream_env() {
	echo "PANARA_CLOUD_CONVEX_UPSTREAM=$CONVEX_INTERNAL_URL"
	echo "PANARA_CLOUD_CONVEX_SITE_UPSTREAM=$CONVEX_INTERNAL_SITE_URL"
	echo "PANARA_CLOUD_LIVE_UPSTREAM=http://$SVC_AGENT:7100"
}

panel_setup() {
	info "Setting up Traefik and the panel routing"
	set --
	for line in $(upstream_env); do set -- "$@" -e "$line"; done
	docker run --rm \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v "$BASE:$BASE" \
		-e "PANARA_CLOUD_DOMAIN=$PANARA_CLOUD_DOMAIN" \
		-e "PANARA_CLOUD_DOMAIN_REMOVED=$DOMAIN_REMOVED" \
		-e "PANARA_CLOUD_HTTPS=$PANARA_CLOUD_HTTPS" \
		-e "PANARA_CLOUD_LETSENCRYPT_EMAIL=$PANARA_CLOUD_LETSENCRYPT_EMAIL" \
		-e "PANARA_CLOUD_PANEL_URL=http://$SVC_WEB:$PANARA_CLOUD_PORT" \
		"$@" "$AGENT_RUN_REF" panel-setup
}

deploy_web() {
	set -- \
		"PORT=$PANARA_CLOUD_PORT" \
		"CONVEX_INTERNAL_URL=$CONVEX_INTERNAL_URL" \
		"CONVEX_INTERNAL_SITE_URL=$CONVEX_INTERNAL_SITE_URL" \
		"CONVEX_PUBLIC_URL=$CONVEX_PUBLIC_URL" \
		"PANARA_CLOUD_LIVE_URL=$LIVE_URL" \
		"PANARA_CLOUD_PROXY_SECRET=$(cat "$PROXY_SECRET_FILE")"
	if service_exists "$SVC_WEB"; then
		# shellcheck disable=SC2046
		set -- "$@" $(port_args "$SVC_WEB" "$PANARA_CLOUD_PORT:$PANARA_CLOUD_PORT" "${SAVED_PORT:-}")
		update_service "$SVC_WEB" "$WEB_REF" "$@"
		said_updated "$SVC_WEB"
		return
	fi
	info "Creating $SVC_WEB"
	publish=""
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		publish="--publish published=$PANARA_CLOUD_PORT,target=$PANARA_CLOUD_PORT,mode=host"
	fi
	# shellcheck disable=SC2086
	create_service "$SVC_WEB" "$WEB_REF" \
		--network "$NETWORK" \
		--constraint node.role==manager \
		--update-order stop-first \
		$publish \
		-- "$@"
}

# What the panel's Update moves Convex along with: the repository whose
# release tags it follows, or "none" for a chosen image the Update leaves alone.
convex_follows() {
	if [ -n "$PANARA_CLOUD_CONVEX_IMAGE" ]; then
		echo none
	else
		echo "$PANARA_CLOUD_CONVEX_REPOSITORY"
	fi
}

deploy_agent() {
	# On SIGTERM the agent stops claiming jobs and lets running ones finish
	# for the drain time, then hands back the rest; the extra minute covers
	# that hand-back before Docker kills it.
	grace="$((PANARA_CLOUD_AGENT_DRAIN_SECONDS + 60))s"
	set -- \
		"CONVEX_URL=$CONVEX_INTERNAL_URL" \
		"CONVEX_SITE_URL=$CONVEX_INTERNAL_SITE_URL" \
		"AGENT_SECRET_FILE=$AGENT_SECRET_FILE" \
		"PANARA_CLOUD_CONVEX_SELF_HOSTED_URL=$CONVEX_INTERNAL_URL" \
		"PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
		"PANARA_CLOUD_IMAGES=$SVC_WEB=$PANARA_CLOUD_WEB_IMAGE,$SVC_AGENT=$PANARA_CLOUD_AGENT_IMAGE" \
		"PANARA_CLOUD_MIGRATOR=$SVC_AGENT" \
		"PANARA_CLOUD_AGENT_SERVICE=$SVC_AGENT" \
		"AGENT_DRAIN_TIMEOUT_SECONDS=$PANARA_CLOUD_AGENT_DRAIN_SECONDS" \
		"PANARA_CLOUD_MONITORING_IMAGE=$PANARA_CLOUD_MONITORING_IMAGE" \
		"PANARA_CLOUD_MIGRATE_IMAGE=$PANARA_CLOUD_MIGRATE_IMAGE" \
		"PANARA_CLOUD_CONVEX_REPOSITORY=$(convex_follows)" \
		"PANARA_CLOUD_RELEASE_TAG=$PANARA_CLOUD_RELEASE_TAG" \
		"PANARA_CLOUD_WEB_SERVICE=$SVC_WEB" \
		"PANARA_CLOUD_PANEL_PORT=$PANARA_CLOUD_PORT" \
		"PANARA_CLOUD_PANEL_URL=http://$SVC_WEB:$PANARA_CLOUD_PORT" \
		"LIVE_PORT=7100" \
		"LIVE_ALLOWED_ORIGINS=$SITE_URL"
	for line in $(upstream_env); do set -- "$@" "$line"; done
	if [ -n "$PANARA_CLOUD_VERSION_URL" ]; then
		set -- "$@" "PANARA_CLOUD_VERSION_URL=$PANARA_CLOUD_VERSION_URL"
	fi
	if service_exists "$SVC_AGENT"; then
		# shellcheck disable=SC2046
		set -- "$@" --stop-grace-period "$grace" $(port_args "$SVC_AGENT" "$PANARA_CLOUD_LIVE_PORT:7100" "")
		if ! same_image "$SVC_AGENT" "$AGENT_REF"; then
			info "Moving $SVC_AGENT to $AGENT_REF (running jobs get up to $PANARA_CLOUD_AGENT_DRAIN_SECONDS s to finish)"
		fi
		update_service "$SVC_AGENT" "$AGENT_REF" "$@"
		said_updated "$SVC_AGENT"
		return
	fi
	info "Creating $SVC_AGENT"
	publish=""
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		publish="--publish published=$PANARA_CLOUD_LIVE_PORT,target=7100,mode=host"
	fi
	# Runs as root with the Docker socket and /etc/panara-cloud at the same
	# path as on the host, because the paths it writes are bind-mounted into
	# Traefik and the services it deploys.
	# shellcheck disable=SC2086
	create_service "$SVC_AGENT" "$AGENT_REF" \
		--network "$NETWORK" \
		--constraint node.role==manager \
		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
		--mount "type=bind,source=$BASE,target=$BASE" \
		--mount type=volume,source=panara-cloud-docker-config,target=/root/.docker \
		--stop-grace-period "$grace" \
		--update-order stop-first \
		$publish \
		-- "$@"
}

wait_for_web() {
	info "Waiting for the panel to answer"
	i=0
	while [ "$i" -lt 60 ]; do
		if docker run --rm --network "$NETWORK" "$AGENT_REF" \
			curl -fsS -o /dev/null "http://$SVC_WEB:$PANARA_CLOUD_PORT/api/health" 2>/dev/null; then
			return
		fi
		i=$((i + 1))
		sleep 3
	done
	die "The panel did not become healthy; see: docker service logs $SVC_WEB"
}

# Whether x.y.z $1 is an earlier release than x.y.z $2.
version_before() {
	printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n -C && [ "$1" != "$2" ]
}

# The Convex image for the panel's image tag $1: the chosen one, else the
# release's panara-cloud-convex, else (a release from before it existed) the
# upstream image that release was installed with.
convex_ref() {
	if [ -n "$PANARA_CLOUD_CONVEX_IMAGE" ]; then
		printf '%s\n' "$PANARA_CLOUD_CONVEX_IMAGE"
	elif is_release "$1" && version_before "${1#v}" 0.1.6; then
		printf '%s\n' "$CONVEX_IMAGE_BEFORE_0_1_6"
	else
		printf '%s:%s\n' "$PANARA_CLOUD_CONVEX_REPOSITORY" "$1"
	fi
}

image_refs() {
	IMAGE_TAG="${IMAGE_TAG:-$VERSION}"
	WEB_REF="$PANARA_CLOUD_WEB_IMAGE:$IMAGE_TAG"
	AGENT_REF="$PANARA_CLOUD_AGENT_IMAGE:$IMAGE_TAG"
	CONVEX_REF=$(convex_ref "$IMAGE_TAG")
}

pull_images() {
	if [ "$KEEP_IMAGES" = 1 ]; then
		docker image inspect "$WEB_REF" >/dev/null 2>&1 || pull "$WEB_REF"
		docker image inspect "$AGENT_REF" >/dev/null 2>&1 || pull "$AGENT_REF"
	else
		info "Pulling Panara Cloud $VERSION"
		pull "$WEB_REF"
		pull "$AGENT_REF"
	fi
	# The agent image gets the admin key and the Docker socket below; run it by
	# the ID resolved now, because any build on this daemon (a member's compose
	# with `image:` naming this repository) can move the tag later.
	AGENT_RUN_REF=$(docker image inspect --format '{{.Id}}' "$AGENT_REF") ||
		die "Image $AGENT_REF is not available locally"
	if [ "$KEEP_IMAGES" = 1 ]; then
		docker image inspect "$CONVEX_REF" >/dev/null 2>&1 || pull "$CONVEX_REF"
	else
		pull "$CONVEX_REF"
	fi
	if [ "$PANARA_CLOUD_DASHBOARD" = true ]; then pull "$PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE"; fi
}

tty_available() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }

create_admin() {
	[ -s "$ADMIN_KEY_FILE" ] || die "Panara Cloud is not installed on this host"
	email="${PANARA_CLOUD_ADMIN_EMAIL:-}"
	password=""
	if [ -n "${PANARA_CLOUD_ADMIN_PASSWORD_FILE:-}" ]; then
		password=$(cat "$PANARA_CLOUD_ADMIN_PASSWORD_FILE")
	fi
	if [ -z "$email" ] || [ -z "$password" ]; then
		tty_available || die "Set PANARA_CLOUD_ADMIN_EMAIL and PANARA_CLOUD_ADMIN_PASSWORD_FILE, or run this in a terminal"
	fi
	if [ -z "$email" ]; then
		printf 'Administrator email: ' >/dev/tty
		read -r email </dev/tty
	fi
	if [ -z "$password" ]; then
		printf 'Password (12+ characters): ' >/dev/tty
		stty -echo </dev/tty
		read -r password </dev/tty
		stty echo </dev/tty
		printf '\nRepeat the password: ' >/dev/tty
		stty -echo </dev/tty
		read -r again </dev/tty
		stty echo </dev/tty
		printf '\n' >/dev/tty
		[ "$password" = "$again" ] || die "The passwords don't match"
	fi
	AGENT_REF=$(docker service inspect "$SVC_AGENT" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)
	[ -n "$AGENT_REF" ] || die "$SVC_AGENT is not running"
	printf '{"email":%s,"password":%s}' "$(json_string "$email")" "$(json_string "$password")" |
		docker run --rm -i --network "$NETWORK" \
			-v "$SECRETS:$SECRETS:ro" \
			-e "CONVEX_SELF_HOSTED_URL=http://$SVC_CONVEX:3210" \
			-e "CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
			"$AGENT_REF" create-admin
}

reset_password() {
	[ -s "$ADMIN_KEY_FILE" ] || die "Panara Cloud is not installed on this host"
	email="${1:-${PANARA_CLOUD_ADMIN_EMAIL:-}}"
	if [ -z "$email" ]; then
		tty_available || die "Give the account's email: $(rerun "" "reset-password <email>")"
		printf 'Account email: ' >/dev/tty
		read -r email </dev/tty
	fi
	AGENT_REF=$(docker service inspect "$SVC_AGENT" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)
	[ -n "$AGENT_REF" ] || die "$SVC_AGENT is not running"
	printf '{"email":%s}' "$(json_string "$email")" |
		docker run --rm -i --network "$NETWORK" \
			-v "$SECRETS:$SECRETS:ro" \
			-e "CONVEX_SELF_HOSTED_URL=http://$SVC_CONVEX:3210" \
			-e "CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
			"$AGENT_REF" reset-password
}

# Prints a new one-time link that creates the first account (the instance
# administrator). Sign-up refuses the first account without it, so whoever
# reaches a fresh panel first can't claim it. Returns 2 once an administrator
# exists.
new_setup_link() {
	[ -n "${AGENT_REF:-}" ] ||
		AGENT_REF=$(docker service inspect "$SVC_AGENT" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)
	[ -n "$AGENT_REF" ] || die "$SVC_AGENT is not running"
	docker run --rm --network "$NETWORK" \
		-v "$SECRETS:$SECRETS:ro" \
		-e "CONVEX_SELF_HOSTED_URL=http://$SVC_CONVEX:3210" \
		-e "CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
		"$AGENT_REF" setup-link
}

setup_link() {
	[ -s "$ADMIN_KEY_FILE" ] || die "Panara Cloud is not installed on this host"
	rc=0
	link=$(new_setup_link) || rc=$?
	if [ "$rc" = 2 ]; then
		die "This instance already has an administrator. Lost access? Run: $(rerun "" "reset-password <email>")"
	fi
	if [ "$rc" != 0 ] || [ -z "$link" ]; then die "Could not create the setup link"; fi
	echo
	info "Open this link to create the administrator account (valid 7 days, works once):"
	echo "    $link"
	echo "    Running this again replaces the link."
}

plain_http_warning() {
	if [ "$PANARA_CLOUD_HTTPS" = true ]; then return; fi
	warn "Panara Cloud is served over plain HTTP ($SITE_URL)."
	warn "Passwords, session cookies, terminals and logs cross the network unencrypted."
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		warn "Convex (:$PANARA_CLOUD_CONVEX_PORT, :$PANARA_CLOUD_CONVEX_SITE_PORT) and the live endpoint (:$PANARA_CLOUD_LIVE_PORT) are published too."
	fi
	warn "To serve it on a domain with HTTPS, point the domain at this server and run:"
	warn "  $(rerun "PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_LETSENCRYPT_EMAIL=you@example.com" "")"
	warn "Never send the Convex admin key over plain HTTP: use an SSH tunnel (docs/install.md)."
}

# While no administrator exists: a fresh setup link (replacing the previous
# one), since nobody can sign up without it.
first_run_link() {
	rc=0
	link=$(new_setup_link) || rc=$?
	if [ "$rc" = 0 ] && [ -n "$link" ]; then
		info "Create the administrator account with this one-time link (valid 7 days):"
		echo "    $link"
		echo "    Sign-up of the first account only works through it. Lost it? Run:"
		echo "    $(rerun "" setup-link)"
	elif [ "$rc" != 2 ]; then
		warn "Could not create the setup link; run: $(rerun "" setup-link)"
	fi
}

summary() {
	echo
	info "Panara Cloud $VERSION is running"
	echo "    Panel:   $SITE_URL"
	if [ "$PANARA_CLOUD_DASHBOARD" = true ]; then
		echo "    Convex dashboard: http://<this server>:$PANARA_CLOUD_DASHBOARD_PORT (admin key: $ADMIN_KEY_FILE)"
	fi
	echo "    Settings: $CONFIG    Secrets: $SECRETS"
	if [ -n "$PANARA_CLOUD_DOMAIN" ]; then
		echo "    If it does not open: ports 80 and 443 must be open in your provider's firewall, and"
		echo "    $PANARA_CLOUD_DOMAIN must point at this server. The first certificate can take a minute."
	else
		echo "    If it does not open: allow TCP $PANARA_CLOUD_PORT, $PANARA_CLOUD_CONVEX_PORT, $PANARA_CLOUD_CONVEX_SITE_PORT and $PANARA_CLOUD_LIVE_PORT (and 80 and 443 for"
		echo "    what you deploy) in your provider's firewall."
	fi
	plain_http_warning
}

install() {
	require_root_linux
	load_config
	ensure_docker
	check_resources
	ensure_swarm
	ensure_swarm_firewall
	ensure_network
	ensure_dirs
	check_ports
	IMAGE_TAG=""
	KEEP_IMAGES=0
	if ! keep_running_images; then
		requested="${PANARA_CLOUD_VERSION:-latest}"
		# A saved channel build label with its services gone: follow the channel.
		if [ -z "$VERSION_ARG" ] && ! is_release "$requested"; then
			requested="$PANARA_CLOUD_RELEASE_TAG"
		fi
		resolve_version "$requested"
		image_refs
	fi
	derive_urls
	pull_images
	deploy_convex
	ensure_admin_key
	ensure_proxy_secret
	deploy_functions
	panel_setup
	deploy_dashboard
	deploy_web
	deploy_agent
	save_config
	wait_for_web
	summary
	echo
	first_run_link
	echo
	echo "    Email is optional. Without it, teammates join through invitation links"
	echo "    you copy from Settings → Members. To send account email, connect"
	echo "    opensend.cc (https://opensend.cc) or Resend in Settings → Email."
}

upgrade() {
	require_root_linux
	[ -f "$CONFIG" ] || die "No installation found ($CONFIG); run the installer first"
	requested="${PANARA_CLOUD_VERSION:-}"
	load_config
	ensure_docker
	check_resources
	ensure_swarm_firewall
	ensure_network
	ensure_dirs
	IMAGE_TAG=""
	KEEP_IMAGES=0
	resolve_version "${requested:-$PANARA_CLOUD_RELEASE_TAG}"
	image_refs
	derive_urls
	info "Upgrading to Panara Cloud $VERSION"
	pull_images
	deploy_convex
	ensure_admin_key
	ensure_proxy_secret
	deploy_functions
	panel_setup
	deploy_dashboard
	deploy_web
	deploy_agent
	save_config
	wait_for_web
	summary
	first_run_link
}

status() {
	[ -f "$CONFIG" ] || die "No installation found ($CONFIG)"
	echo "PANARA_CLOUD_VERSION=$(running_version)"
	docker service ls --filter name=panara-cloud
	docker container ls --filter name=panara-cloud-traefik --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
}

case "${1:-install}" in
install) install ;;
upgrade | update) upgrade ;;
create-admin)
	require_root_linux
	load_config
	create_admin
	;;
reset-password)
	require_root_linux
	load_config
	shift
	reset_password "${1:-}"
	;;
setup-link)
	require_root_linux
	load_config
	setup_link
	;;
status) status ;;
help | --help | -h) usage ;;
*)
	usage >&2
	die "Unknown command: $1"
	;;
esac
