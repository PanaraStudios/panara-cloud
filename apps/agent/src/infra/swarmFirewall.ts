// Keeps Docker Swarm's ports closed to the internet. A Swarm created on a
// server with only a public address advertises that address, and dockerd
// listens on 2377/tcp, 7946/tcp+udp and 4789/udp on every interface.
//
// deploy/install.sh carries a byte-identical copy of SWARM_FIREWALL_SCRIPT
// (it runs standalone through `curl | sh`); swarmFirewall.test.ts checks it.
export const SWARM_FIREWALL_PATH =
	"/usr/local/sbin/panara-cloud-swarm-firewall";
export const SWARM_FIREWALL_CONF = "/etc/panara-cloud/swarm-firewall.env";
export const SWARM_FIREWALL_UNIT = "panara-cloud-swarm-firewall.service";

export const SWARM_FIREWALL_SCRIPT = `#!/bin/sh
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
if [ "\${1:-apply}" = apply ] && has docker && docker info >/dev/null 2>&1; then
	{
		docker info --format '{{range .Swarm.RemoteManagers}}{{.Addr}} {{end}}' 2>/dev/null | tr ' ' '\\n'
		docker node ls -q 2>/dev/null | xargs -r docker node inspect --format '{{.Status.Addr}}' 2>/dev/null
	} | sed -e 's/:[0-9]*$//' -e 's/^\\[//' -e 's/\\]$//' |
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
		while "$1" -w -D INPUT -p "\${p%%:*}" --dport "\${p#*:}" -j "$CHAIN" 2>/dev/null; do :; done
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
		"$1" -w -C INPUT -p "\${p%%:*}" --dport "\${p#*:}" -j "$CHAIN" 2>/dev/null ||
			"$1" -w -I INPUT 1 -p "\${p%%:*}" --dport "\${p#*:}" -j "$CHAIN"
	done
}

# ufw keeps its rules itself; prepend puts each rule first in its address
# family, so the allows end up ahead of the deny.
ufw_rules() {
	for p in $PORTS; do
		ufw "$@" deny proto "\${p%%:*}" to any port "\${p#*:}" >/dev/null 2>&1 || true
		for src in $V4 $V6; do
			ufw "$@" allow proto "\${p%%:*}" from "$src" to any port "\${p#*:}" >/dev/null 2>&1 || true
		done
	done
}

remove_all() {
	clear_chain iptables
	clear_chain ip6tables
	if has ufw; then ufw_rules delete; fi
}

if [ "\${1:-apply}" = remove ] || [ "$PANARA_CLOUD_SWARM_PUBLIC" = 1 ]; then
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
`;

// Installs the script, records an explicit opt-out, and re-applies the rules
// at boot with a systemd unit (ufw persists its own rules). Runs as root via
// $SUDO_CMD in the setup script; install.sh runs as root with SUDO_CMD empty.
export const swarmFirewallSetup = (swarmPublic: boolean) => `
$SUDO_CMD mkdir -p /etc/panara-cloud
${
	swarmPublic
		? `if ! $SUDO_CMD grep -qx 'PANARA_CLOUD_SWARM_PUBLIC=1' ${SWARM_FIREWALL_CONF} 2>/dev/null; then
	echo 'PANARA_CLOUD_SWARM_PUBLIC=1' | $SUDO_CMD tee -a ${SWARM_FIREWALL_CONF} >/dev/null
fi
`
		: ""
}$SUDO_CMD tee ${SWARM_FIREWALL_PATH} >/dev/null <<'PANARA_CLOUD_SWARM_FIREWALL'
${SWARM_FIREWALL_SCRIPT}PANARA_CLOUD_SWARM_FIREWALL
$SUDO_CMD chmod 755 ${SWARM_FIREWALL_PATH}
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	$SUDO_CMD tee /etc/systemd/system/${SWARM_FIREWALL_UNIT} >/dev/null <<'PANARA_CLOUD_SWARM_FIREWALL'
[Unit]
Description=Panara Cloud: keep Docker Swarm ports private
After=network-pre.target ufw.service firewalld.service netfilter-persistent.service
Before=docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${SWARM_FIREWALL_PATH} boot

[Install]
WantedBy=multi-user.target
PANARA_CLOUD_SWARM_FIREWALL
	$SUDO_CMD systemctl daemon-reload
	$SUDO_CMD systemctl enable ${SWARM_FIREWALL_UNIT} >/dev/null 2>&1 || true
fi
$SUDO_CMD ${SWARM_FIREWALL_PATH} apply
`;
