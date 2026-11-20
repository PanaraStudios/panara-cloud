#!/bin/sh
# Panara Cloud installer and upgrader for the panel host.
#
#   curl -fsSL https://raw.githubusercontent.com/panarastudios/panara-cloud/main/deploy/install.sh | sudo sh
#   curl -fsSL .../install.sh | sudo sh -s upgrade
#   curl -fsSL .../install.sh | sudo sh -s create-admin
#   curl -fsSL .../install.sh | sudo sh -s reset-password admin@example.com
#   curl -fsSL .../install.sh | sudo sh -s setup-link
#   curl -fsSL .../install.sh | sudo sh -s status
#
# Settings come from the environment (see docs/install.md) and are kept in
# /etc/panara-cloud/install.env for later runs. Secrets never leave the host:
# the Convex admin key and the agent's enrollment secret live in
# /etc/panara-cloud/secrets (root, 0600); generated deployment secrets are
# written straight into Convex and never printed.
#
# POSIX sh on purpose: `curl | sh` runs it with dash on Debian/Ubuntu.
set -eu

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

# Official self-hosted Convex images, pinned by digest (multi-arch indexes).
# ghcr.io/get-convex/* no longer serves pulls.
DEFAULT_CONVEX_IMAGE=ghcr.io/convex/convex-backend@sha256:6644f704e3a22444d5e166c3071a97be429915db962b38d1df1776876b102320
DEFAULT_CONVEX_DASHBOARD_IMAGE=ghcr.io/convex/convex-dashboard@sha256:3cabc039ab4b4e3a75cc02338b6c70f37f5c0c356e1b79499151b43ec8d83e34

DOCKER_VERSION=28.5.0

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
	exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }
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
	cli_version="${PANARA_CLOUD_VERSION:-}"
	if [ -f "$CONFIG" ]; then
		saved=$(mktemp)
		env | grep '^PANARA_CLOUD_' >"$saved" || true
		# shellcheck disable=SC1090
		. "$CONFIG"
		# An IP-only install saved HTTPS=false; it must not stick once a
		# domain is added later.
		if [ -z "${PANARA_CLOUD_DOMAIN:-}" ]; then unset PANARA_CLOUD_HTTPS; fi
		while IFS= read -r line; do
			export "${line?}"
		done <"$saved"
		rm -f "$saved"
		# Re-running the installer must not roll back an Update made from the panel.
		if [ -z "$cli_version" ]; then
			current=$(running_version)
			if [ -n "$current" ]; then PANARA_CLOUD_VERSION="$current"; fi
		fi
	fi
	PANARA_CLOUD_REGISTRY="${PANARA_CLOUD_REGISTRY:-ghcr.io/panarastudios}"
	PANARA_CLOUD_WEB_IMAGE="${PANARA_CLOUD_WEB_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-web}"
	PANARA_CLOUD_AGENT_IMAGE="${PANARA_CLOUD_AGENT_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-agent}"
	PANARA_CLOUD_MONITORING_IMAGE="${PANARA_CLOUD_MONITORING_IMAGE:-$PANARA_CLOUD_REGISTRY/panara-cloud-monitoring}"
	PANARA_CLOUD_CONVEX_IMAGE="${PANARA_CLOUD_CONVEX_IMAGE:-$DEFAULT_CONVEX_IMAGE}"
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
}

save_config() {
	umask 077
	cat >"$CONFIG" <<EOF
# Panara Cloud install settings, read by install.sh upgrade. No secrets here.
PANARA_CLOUD_VERSION=$VERSION
PANARA_CLOUD_REGISTRY=$PANARA_CLOUD_REGISTRY
PANARA_CLOUD_WEB_IMAGE=$PANARA_CLOUD_WEB_IMAGE
PANARA_CLOUD_AGENT_IMAGE=$PANARA_CLOUD_AGENT_IMAGE
PANARA_CLOUD_MONITORING_IMAGE=$PANARA_CLOUD_MONITORING_IMAGE
PANARA_CLOUD_CONVEX_IMAGE=$PANARA_CLOUD_CONVEX_IMAGE
PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE=$PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE
PANARA_CLOUD_RELEASE_TAG=$PANARA_CLOUD_RELEASE_TAG
PANARA_CLOUD_DOMAIN=$PANARA_CLOUD_DOMAIN
PANARA_CLOUD_HTTPS=$PANARA_CLOUD_HTTPS
PANARA_CLOUD_LETSENCRYPT_EMAIL=$PANARA_CLOUD_LETSENCRYPT_EMAIL
PANARA_CLOUD_HOST=$PANARA_CLOUD_HOST
PANARA_CLOUD_PORT=$PANARA_CLOUD_PORT
PANARA_CLOUD_CONVEX_PORT=$PANARA_CLOUD_CONVEX_PORT
PANARA_CLOUD_CONVEX_SITE_PORT=$PANARA_CLOUD_CONVEX_SITE_PORT
PANARA_CLOUD_LIVE_PORT=$PANARA_CLOUD_LIVE_PORT
PANARA_CLOUD_DASHBOARD=$PANARA_CLOUD_DASHBOARD
PANARA_CLOUD_DASHBOARD_PORT=$PANARA_CLOUD_DASHBOARD_PORT
PANARA_CLOUD_VERSION_URL=$PANARA_CLOUD_VERSION_URL
PANARA_CLOUD_AGENT_DRAIN_SECONDS=$PANARA_CLOUD_AGENT_DRAIN_SECONDS
EOF
	chmod 600 "$CONFIG"
	umask 022
}

require_root_linux() {
	[ "$(id -u)" = 0 ] || die "Run this script as root (sudo sh)"
	[ "$(uname)" = Linux ] || die "Panara Cloud runs on Linux"
}

ensure_docker() {
	if command_exists docker; then
		docker info >/dev/null 2>&1 || die "Docker is installed but not running"
		return
	fi
	info "Installing Docker $DOCKER_VERSION"
	command_exists curl || die "curl is required to install Docker"
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
		ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null || true)
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

check_ports() {
	# A rerun keeps the ports its own services and Traefik already hold.
	if service_exists "$SVC_WEB"; then return; fi
	ports="80 443"
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		ports="$ports $PANARA_CLOUD_PORT $PANARA_CLOUD_CONVEX_PORT $PANARA_CLOUD_CONVEX_SITE_PORT $PANARA_CLOUD_LIVE_PORT"
	fi
	if [ "$PANARA_CLOUD_DASHBOARD" = true ]; then ports="$ports $PANARA_CLOUD_DASHBOARD_PORT"; fi
	for port in $ports; do
		if port_in_use "$port"; then
			if [ "$port" = 80 ] || [ "$port" = 443 ]; then
				docker container inspect panara-cloud-traefik >/dev/null 2>&1 && continue
			fi
			die "Port $port is already in use"
		fi
	done
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

# Resolves the release to install: an explicit x.y.z, or the version label of
# the image behind a channel tag ("latest", "canary").
resolve_version() {
	requested="${1:-latest}"
	case "$requested" in
	v[0-9]*.[0-9]*.[0-9]* | [0-9]*.[0-9]*.[0-9]*)
		VERSION="${requested#v}"
		return
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
	else
		if [ -z "$PANARA_CLOUD_HOST" ]; then
			PANARA_CLOUD_HOST=$(public_ip)
			[ -n "$PANARA_CLOUD_HOST" ] || PANARA_CLOUD_HOST=$(private_ip)
			[ -n "$PANARA_CLOUD_HOST" ] || die "Could not detect this server's address; set PANARA_CLOUD_HOST"
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

# update_service NAME IMAGE [ENV=value... | --flag value...]
update_service() {
	name="$1"
	image="$2"
	shift 2
	count=$#
	flag=0
	for arg in "$@"; do
		if [ "$flag" = 1 ]; then
			set -- "$@" "$arg"
			flag=0
		else
			case "$arg" in
			--*)
				set -- "$@" "$arg"
				flag=1
				;;
			*) set -- "$@" --env-add "$arg" ;;
			esac
		fi
	done
	shift "$count"
	docker service update --quiet --detach=false --with-registry-auth \
		--image "$image" "$@" "$name" >/dev/null
}

# With a domain, Traefik serves the panel, Convex and the live endpoint on the
# HTTPS origin, so nothing else may be published: a direct port would bypass
# TLS. Prints --publish-rm for each target port NAME still publishes (from an
# earlier install without a domain).
unpublish_args() {
	name="$1"
	shift
	[ -n "$PANARA_CLOUD_DOMAIN" ] || return 0
	# Host-mode ports are only removed when given by their full spec;
	# `--publish-rm <target>` leaves them published.
	published=$(docker service inspect "$name" \
		--format '{{range .Spec.EndpointSpec.Ports}}{{.PublishedPort}},{{.TargetPort}},{{.PublishMode}} {{end}}' 2>/dev/null || true)
	for target in "$@"; do
		for port in $published; do
			case "$port" in
			*",$target,"*)
				printf ' --publish-rm published=%s,target=%s,mode=%s' \
					"${port%%,*}" "$target" "${port##*,}"
				;;
			esac
		done
	done
}

deploy_convex() {
	set -- \
		"INSTANCE_NAME=panara-cloud" \
		"CONVEX_CLOUD_ORIGIN=$CONVEX_PUBLIC_URL" \
		"CONVEX_SITE_ORIGIN=$CONVEX_PUBLIC_SITE_URL" \
		"DISABLE_METRICS_ENDPOINT=true"
	if service_exists "$SVC_CONVEX"; then
		info "Updating $SVC_CONVEX"
		# shellcheck disable=SC2046
		set -- "$@" $(unpublish_args "$SVC_CONVEX" 3210 3211)
		update_service "$SVC_CONVEX" "$PANARA_CLOUD_CONVEX_IMAGE" "$@"
		return
	fi
	info "Creating $SVC_CONVEX"
	publish=""
	if [ -z "$PANARA_CLOUD_DOMAIN" ]; then
		publish="--publish published=$PANARA_CLOUD_CONVEX_PORT,target=3210,mode=host --publish published=$PANARA_CLOUD_CONVEX_SITE_PORT,target=3211,mode=host"
	fi
	# SQLite has a single writer: never run two backends on the same volume.
	# shellcheck disable=SC2086
	create_service "$SVC_CONVEX" "$PANARA_CLOUD_CONVEX_IMAGE" \
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

# Pushes the release's Convex functions, applies env and data migrations,
# and enrolls the panel agent on first install. Runs from the new agent
# image before any web/agent service moves to it.
migrate() {
	seed="$1"
	info "Deploying Convex functions and running migrations"
	write_convex_env
	set -- -e "PANARA_CLOUD_CONVEX_ENV_FILE=$CONVEX_ENV_FILE"
	if [ "$seed" = seed ]; then
		set -- "$@" -e "PANARA_CLOUD_WEB_SERVER=$(web_server_json)"
	fi
	if ! docker run --rm --network "$NETWORK" \
		-v "$SECRETS:$SECRETS" \
		-e "CONVEX_SELF_HOSTED_URL=$CONVEX_INTERNAL_URL" \
		-e "CONVEX_SELF_HOSTED_ADMIN_KEY_FILE=$ADMIN_KEY_FILE" \
		-e "PANARA_CLOUD_AGENT_SECRET_FILE=$AGENT_SECRET_FILE" \
		-e "PANARA_CLOUD_VERSION=$VERSION" \
		"$@" "$AGENT_RUN_REF" migrate; then
		rm -f "$CONVEX_ENV_FILE"
		die "Deploying the Convex functions failed; the web and agent services were not changed"
	fi
	rm -f "$CONVEX_ENV_FILE"
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
		info "Updating $SVC_WEB to $WEB_REF"
		# shellcheck disable=SC2046
		set -- "$@" $(unpublish_args "$SVC_WEB" "$PANARA_CLOUD_PORT")
		update_service "$SVC_WEB" "$WEB_REF" "$@"
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
		info "Updating $SVC_AGENT to $AGENT_REF (running jobs get up to $PANARA_CLOUD_AGENT_DRAIN_SECONDS s to finish)"
		# shellcheck disable=SC2046
		set -- "$@" --stop-grace-period "$grace" $(unpublish_args "$SVC_AGENT" 7100)
		update_service "$SVC_AGENT" "$AGENT_REF" "$@"
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

image_refs() {
	IMAGE_TAG="${IMAGE_TAG:-$VERSION}"
	WEB_REF="$PANARA_CLOUD_WEB_IMAGE:$IMAGE_TAG"
	AGENT_REF="$PANARA_CLOUD_AGENT_IMAGE:$IMAGE_TAG"
}

pull_images() {
	info "Pulling Panara Cloud $VERSION"
	pull "$WEB_REF"
	pull "$AGENT_REF"
	# The agent image gets the admin key and the Docker socket below; run it by
	# the ID resolved now, because any build on this daemon (a member's compose
	# with `image:` naming this repository) can move the tag later.
	AGENT_RUN_REF=$(docker image inspect --format '{{.Id}}' "$AGENT_REF") ||
		die "Image $AGENT_REF is not available locally"
	pull "$PANARA_CLOUD_CONVEX_IMAGE"
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
		tty_available || die "Usage: install.sh reset-password <email>"
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
		die "This instance already has an administrator. Lost access? Use: install.sh reset-password <email>"
	fi
	[ "$rc" = 0 ] && [ -n "$link" ] || die "Could not create the setup link"
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
	warn "Use a domain with HTTPS: rerun with PANARA_CLOUD_DOMAIN=panel.example.com"
	warn "(and PANARA_CLOUD_LETSENCRYPT_EMAIL). Never send the Convex admin key over"
	warn "plain HTTP: use an SSH tunnel (docs/install.md)."
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
		echo "    sudo sh install.sh setup-link"
	elif [ "$rc" != 2 ]; then
		warn "Could not create the setup link; run: sudo sh install.sh setup-link"
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
	plain_http_warning
}

install() {
	require_root_linux
	load_config
	ensure_docker
	ensure_swarm
	ensure_swarm_firewall
	ensure_network
	ensure_dirs
	check_ports
	IMAGE_TAG=""
	resolve_version "${PANARA_CLOUD_VERSION:-latest}"
	image_refs
	derive_urls
	pull_images
	deploy_convex
	ensure_admin_key
	ensure_proxy_secret
	migrate seed
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
	ensure_swarm_firewall
	ensure_network
	ensure_dirs
	IMAGE_TAG=""
	resolve_version "${requested:-$PANARA_CLOUD_RELEASE_TAG}"
	image_refs
	derive_urls
	info "Upgrading to Panara Cloud $VERSION"
	pull_images
	deploy_convex
	ensure_admin_key
	ensure_proxy_secret
	migrate keep
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
*) die "Usage: install.sh [install|upgrade|create-admin|reset-password <email>|setup-link|status]" ;;
esac
