import type { Host } from "../host/types";
import {
	BASE_PATH,
	NETWORK_NAME,
	paths,
	TRAEFIK_CONTAINER,
} from "../lib/constants";
import { quote } from "../lib/shell";
import { runScript } from "./shell";
import { swarmFirewallSetup } from "./swarmFirewall";

export const DOCKER_VERSION = "28.5.0";
export const NIXPACKS_VERSION = "1.41.0";
export const RAILPACK_VERSION = "0.15.4";
export const BUILDPACKS_VERSION = "0.39.1";

export type SetupOptions = {
	serverType: "deploy" | "build";
	// Address Swarm advertises; used when it is bound on the host, otherwise
	// the host's public IP is detected.
	advertiseAddr?: string | null;
	// Leave Swarm's ports open to the internet (PANARA_CLOUD_SWARM_PUBLIC=1).
	swarmPublic?: boolean;
};

const reportDockerVersion = `
if command -v docker >/dev/null 2>&1; then
	INSTALLED_DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
	if [ -z "$INSTALLED_DOCKER_VERSION" ]; then
		INSTALLED_DOCKER_VERSION=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || true)
	fi
	DOCKER_VERSION_REPORT="\${INSTALLED_DOCKER_VERSION:-unknown} (already installed)"
else
	DOCKER_VERSION_REPORT="$DOCKER_VERSION (will be installed)"
fi
`;

const installUtilities = `
case "$OS_TYPE" in
arch)
	$SUDO_CMD pacman -Sy --noconfirm --needed unzip curl wget git git-lfs jq openssl >/dev/null || true
	;;
alpine)
	$SUDO_CMD sed -i '/^#.*\\/community/s/^#//' /etc/apk/repositories
	$SUDO_CMD apk update >/dev/null
	$SUDO_CMD apk add curl wget git git-lfs jq openssl sudo unzip tar >/dev/null
	;;
ubuntu | debian | raspbian)
	export DEBIAN_FRONTEND=noninteractive
	$SUDO_CMD apt-get update -y >/dev/null
	$SUDO_CMD apt-get install -y unzip curl wget git git-lfs jq openssl >/dev/null
	;;
centos | fedora | rhel | ol | rocky | almalinux | opencloudos | amzn)
	if [ "$OS_TYPE" = "amzn" ]; then
		$SUDO_CMD dnf install -y wget git git-lfs jq openssl >/dev/null
	else
		if ! command -v dnf >/dev/null; then
			$SUDO_CMD yum install -y dnf >/dev/null
		fi
		if ! command -v curl >/dev/null; then
			$SUDO_CMD dnf install -y curl >/dev/null
		fi
		$SUDO_CMD dnf install -y wget git git-lfs jq openssl unzip >/dev/null
	fi
	;;
sles | opensuse-leap | opensuse-tumbleweed)
	$SUDO_CMD zypper refresh >/dev/null
	$SUDO_CMD zypper install -y curl wget git git-lfs jq openssl >/dev/null
	;;
esac
`;

const validatePorts = `
if ss -tulnp | grep ':80 ' >/dev/null; then
	echo "Something is already running on port 80" >&2
fi
if ss -tulnp | grep ':443 ' >/dev/null; then
	echo "Something is already running on port 443" >&2
fi
`;

const installRClone = `
if command_exists rclone; then
	echo "RClone already installed ✅"
else
	curl https://rclone.org/install.sh | $SUDO_CMD bash
	RCLONE_VERSION=$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//')
	echo "RClone version $RCLONE_VERSION installed ✅"
fi
`;

const installDocker = `
if [ -x "$(command -v snap)" ]; then
	if snap list docker >/dev/null 2>&1; then
		echo " - Docker is installed via snap, which Panara Cloud does not support."
		echo "   Remove it (snap remove docker) and run the setup again."
		exit 1
	fi
fi

if ! [ -x "$(command -v docker)" ]; then
	echo " - Docker is not installed. Installing Docker. It may take a while."
	case "$OS_TYPE" in
	"almalinux" | "rocky" | "centos" | "rhel" | "ol")
		$SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
		$SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
		$SUDO_CMD systemctl start docker >/dev/null 2>&1
		$SUDO_CMD systemctl enable docker >/dev/null 2>&1
		;;
	"opencloudos")
		$SUDO_CMD dnf install -y docker >/dev/null 2>&1
		if [ -f "/etc/sysconfig/docker" ]; then
			$SUDO_CMD sed -i 's/--live-restore[^[:space:]]*//' /etc/sysconfig/docker >/dev/null 2>&1
			$SUDO_CMD sed -i 's/--live-restore//' /etc/sysconfig/docker >/dev/null 2>&1
			$SUDO_CMD sed -i 's/  */ /g' /etc/sysconfig/docker >/dev/null 2>&1
		fi
		$SUDO_CMD systemctl enable docker >/dev/null 2>&1
		$SUDO_CMD systemctl start docker >/dev/null 2>&1
		;;
	"alpine")
		$SUDO_CMD apk add docker docker-cli-compose >/dev/null 2>&1
		$SUDO_CMD rc-update add docker default >/dev/null 2>&1
		$SUDO_CMD service docker start >/dev/null 2>&1
		;;
	"arch")
		$SUDO_CMD pacman -Sy docker docker-compose --noconfirm >/dev/null 2>&1
		$SUDO_CMD systemctl enable --now docker.service >/dev/null 2>&1
		;;
	"amzn")
		$SUDO_CMD dnf install docker -y >/dev/null 2>&1
		DOCKER_CONFIG=/usr/local/lib/docker
		$SUDO_CMD mkdir -p $DOCKER_CONFIG/cli-plugins >/dev/null 2>&1
		$SUDO_CMD curl -sL https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) -o $DOCKER_CONFIG/cli-plugins/docker-compose >/dev/null 2>&1
		$SUDO_CMD chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose >/dev/null 2>&1
		$SUDO_CMD systemctl start docker >/dev/null 2>&1
		$SUDO_CMD systemctl enable docker >/dev/null 2>&1
		;;
	"fedora")
		if [ -x "$(command -v dnf5)" ]; then
			$SUDO_CMD dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo --overwrite >/dev/null 2>&1
		else
			$SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1
		fi
		$SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
		$SUDO_CMD systemctl start docker >/dev/null 2>&1
		$SUDO_CMD systemctl enable docker >/dev/null 2>&1
		;;
	*)
		if [ "$OS_TYPE" = "ubuntu" ] && [ "$OS_VERSION" = "24.10" ]; then
			echo "Docker automated installation is not supported on Ubuntu 24.10 (non-LTS release). Please install Docker manually."
			exit 1
		fi
		curl -s https://get.docker.com | $SUDO_CMD sh -s -- --version $DOCKER_VERSION 2>&1
		if [ "$OS_TYPE" = "rocky" ] || [ "$OS_TYPE" = "centos" ]; then
			$SUDO_CMD systemctl start docker >/dev/null 2>&1
			$SUDO_CMD systemctl enable docker >/dev/null 2>&1
		fi
		;;
	esac
	if ! [ -x "$(command -v docker)" ]; then
		echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
		exit 1
	fi
	echo " - Docker installed successfully."
else
	echo " - Docker is installed."
fi
`;

// Prefers the configured address when the host owns it; Swarm refuses to
// advertise an address that isn't bound locally (e.g. a NAT'd public IP).
const setupSwarm = `
if $SUDO_CMD docker info 2>/dev/null | grep -q 'Swarm: active'; then
	echo "Already part of a Docker Swarm ✅"
else
	get_ip() {
		local ip=""
		if [ -n "$ADVERTISE_ADDR" ] && ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$ADVERTISE_ADDR"; then
			echo "$ADVERTISE_ADDR"
			return
		fi
		for service in https://ifconfig.io https://icanhazip.com https://ipecho.net/plain; do
			ip=$(curl -4s --connect-timeout 5 "$service" 2>/dev/null)
			[ -n "$ip" ] && break
		done
		if [ -z "$ip" ]; then
			for service in https://ifconfig.io https://icanhazip.com https://ipecho.net/plain; do
				ip=$(curl -6s --connect-timeout 5 "$service" 2>/dev/null)
				[ -n "$ip" ] && break
			done
		fi
		if [ -z "$ip" ]; then
			echo "Error: Could not determine server IP address automatically (neither IPv4 nor IPv6)." >&2
			exit 1
		fi
		echo "$ip"
	}
	advertise_addr=$(get_ip)
	echo "Advertise address: $advertise_addr"
	$SUDO_CMD docker swarm init --advertise-addr "$advertise_addr"
	echo "Swarm initialized ✅"
fi
`;

const isSwarmWorker = `[ "$($SUDO_CMD docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)" = "active false" ]`;

const setupNetwork = `
if $SUDO_CMD docker network ls --format '{{.Name}}' | grep -qx '${NETWORK_NAME}'; then
	echo "Network ${NETWORK_NAME} already exists ✅"
elif ${isSwarmWorker}; then
	echo "Swarm worker: ${NETWORK_NAME} is managed by the Swarm manager ✅"
else
	if $SUDO_CMD docker network create --driver overlay --attachable ${NETWORK_NAME}; then
		echo "Network created ✅"
	else
		echo "Failed to create ${NETWORK_NAME} ❌" >&2
		exit 1
	fi
fi
`;

const setupDirectories = () => {
	const dirs = Object.values(paths)
		.map((dir) => quote(dir))
		.join(" ");
	return `
$SUDO_CMD mkdir -p ${dirs}
echo "Directories under ${BASE_PATH} ready ✅"
$SUDO_CMD chmod 700 ${quote(paths.ssh)}
if [ -n "$SUDO_CMD" ]; then
	$SUDO_CMD chown -R $CURRENT_USER:$CURRENT_USER ${BASE_PATH}
fi
`;
};

const installNixpacks = `
if command_exists nixpacks; then
	echo "Nixpacks already installed ✅"
else
	export NIXPACKS_VERSION=${NIXPACKS_VERSION}
	$SUDO_CMD env NIXPACKS_VERSION=$NIXPACKS_VERSION bash -c "$(curl -fsSL https://nixpacks.com/install.sh)"
	echo "Nixpacks version $NIXPACKS_VERSION installed ✅"
fi
`;

const installRailpack = `
if command_exists railpack; then
	echo "Railpack already installed ✅"
else
	export RAILPACK_VERSION=${RAILPACK_VERSION}
	$SUDO_CMD env RAILPACK_VERSION=$RAILPACK_VERSION bash -c "$(curl -fsSL https://railpack.com/install.sh)"
	echo "Railpack version $RAILPACK_VERSION installed ✅"
fi
`;

const installBuildpacks = `
SUFFIX=""
if [ "$SYS_ARCH" = "aarch64" ] || [ "$SYS_ARCH" = "arm64" ]; then
	SUFFIX="-arm64"
fi
if command_exists pack; then
	echo "Buildpacks already installed ✅"
else
	BUILDPACKS_VERSION=${BUILDPACKS_VERSION}
	curl -sSL "https://github.com/buildpacks/pack/releases/download/v$BUILDPACKS_VERSION/pack-v$BUILDPACKS_VERSION-linux$SUFFIX.tgz" | $SUDO_CMD tar -C /usr/local/bin/ --no-same-owner -xzv pack
	echo "Buildpacks version $BUILDPACKS_VERSION installed ✅"
fi
`;

const setupPermissions = `
if [ -n "$SUDO_CMD" ]; then
	if ! groups $CURRENT_USER | grep -qw docker; then
		$SUDO_CMD usermod -aG docker $CURRENT_USER
		echo "User $CURRENT_USER added to docker group ✅"
	else
		echo "User $CURRENT_USER already in docker group ✅"
	fi
	$SUDO_CMD chown -R $CURRENT_USER:$CURRENT_USER ${BASE_PATH}
	echo "Permissions configured for $CURRENT_USER ✅"
else
	echo "Running as root, no extra permissions needed ✅"
fi
`;

// Server setup script without the Traefik steps, which the agent performs
// itself afterwards (see setupTraefik) so they share code with
// Traefik updates.
export const setupScript = (options: SetupOptions): string => {
	const isBuildServer = options.serverType === "build";
	const steps: [string, string][] = isBuildServer
		? [
				["Installing Docker", installDocker],
				["Setting up Directories", setupDirectories()],
				["Installing Nixpacks", installNixpacks],
				["Installing Buildpacks", installBuildpacks],
				["Installing Railpack", installRailpack],
				["Configuring permissions", setupPermissions],
			]
		: [
				["Validating ports", validatePorts],
				["Installing RClone", installRClone],
				["Installing Docker", installDocker],
				["Setting up Docker Swarm", setupSwarm],
				[
					"Restricting Docker Swarm ports",
					swarmFirewallSetup(options.swarmPublic ?? false),
				],
				["Setting up Network", setupNetwork],
				["Setting up Directories", setupDirectories()],
				["Installing Nixpacks", installNixpacks],
				["Installing Buildpacks", installBuildpacks],
				["Installing Railpack", installRailpack],
				["Configuring permissions", setupPermissions],
			];
	return `
set -e
DOCKER_VERSION=${DOCKER_VERSION}
ADVERTISE_ADDR=${quote(options.advertiseAddr ?? "")}
OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
SYS_ARCH=$(uname -m)
CURRENT_USER=$(id -un)

echo "Installing requirements for: OS: $OS_TYPE"

if [ "$(id -u)" -eq 0 ]; then
	SUDO_CMD=""
	echo "Running as root"
elif sudo -n true 2>/dev/null; then
	SUDO_CMD="sudo"
	echo "Running as $CURRENT_USER with sudo privileges"
else
	echo "Error: Non-root user requires passwordless sudo access. ❌"
	echo "Configure with: echo '$CURRENT_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$CURRENT_USER"
	exit 1
fi

case "$OS_TYPE" in
manjaro | manjaro-arm) OS_TYPE="arch" ;;
fedora-asahi-remix) OS_TYPE="fedora" ;;
pop | linuxmint | zorin) OS_TYPE="ubuntu" ;;
esac

if [ "$OS_TYPE" = "arch" ] || [ "$OS_TYPE" = "archarm" ]; then
	OS_VERSION="rolling"
else
	OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
fi

# Ubuntu 26.04's docker-ce repo has no 28.5.0; 29.4.2 is the newest version
# published there for every architecture.
if [ "$OS_TYPE" = "ubuntu" ] && [ "$OS_VERSION" = "26.04" ]; then
	DOCKER_VERSION=29.4.2
fi

if [ "$OS_TYPE" = 'amzn' ]; then
	$SUDO_CMD dnf install -y findutils >/dev/null
fi

case "$OS_TYPE" in
arch | archarm | ubuntu | debian | raspbian | centos | fedora | rhel | ol | rocky | sles | opensuse-leap | opensuse-tumbleweed | almalinux | opencloudos | amzn | alpine) ;;
*)
	echo "This script only supports Debian, Redhat, Arch Linux, Alpine Linux, or SLES based operating systems for now."
	exit 1
	;;
esac

${reportDockerVersion}
echo -e "---------------------------------------------"
echo "| CPU Architecture  | $SYS_ARCH"
echo "| Operating System  | $OS_TYPE $OS_VERSION"
echo "| Docker            | $DOCKER_VERSION_REPORT"
${isBuildServer ? 'echo "| Server Type       | Build Server"' : ""}
echo -e "---------------------------------------------\\n"

command_exists() {
	command -v "$@" > /dev/null 2>&1
}

echo -e "1. Installing required packages (curl, wget, git, jq, openssl)."
${installUtilities}
${steps.map(([title, body], index) => `echo -e "${index + 2}. ${title}."\n${body}`).join("\n")}
`;
};

export const runSetupScript = (
	host: Host,
	options: SetupOptions,
	onOutput: (text: string) => void,
	signal?: AbortSignal,
) => host.run(setupScript(options), { onOutput, signal });

export type SwarmRole = "manager" | "worker" | "inactive";

export const swarmRole = async (host: Host): Promise<SwarmRole> => {
	const format = quote("{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}");
	const result = await host.exec(
		`docker info --format ${format} 2>/dev/null || sudo -n docker info --format ${format}`,
	);
	const [state, control] = result.output.trim().split(/\s+/);
	if (state !== "active") return "inactive";
	return control === "true" ? "manager" : "worker";
};

const versionCheck = (name: string, command: string) => `
if command_exists ${name}; then
	version=$(${command} 2>/dev/null)
	if [ -n "$version" ]; then echo "${name}=$version"; else echo "${name}="; fi
else
	echo "${name}="
fi
`;

// Server validation, as key=value lines.
export const validateScript = `
command_exists() { command -v "$@" > /dev/null 2>&1; }
${versionCheck("docker", "docker --version | awk '{print $3}' | sed 's/,//'")}
${versionCheck("rclone", "rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//'")}
${versionCheck("nixpacks", "nixpacks --version | awk '{print $2}'")}
${versionCheck("railpack", "railpack --version | awk '{print $3}'")}
${versionCheck("pack", "pack --version | awk '{print $1}'")}
image=$(docker container inspect ${TRAEFIK_CONTAINER} --format '{{.Config.Image}}' 2>/dev/null || $SUDO docker container inspect ${TRAEFIK_CONTAINER} --format '{{.Config.Image}}' 2>/dev/null || true)
echo "traefik=$(echo "$image" | sed 's/@.*//' | awk -F: 'NF>1{print $NF}' | sed 's/^v//')"
echo "swarm=$($SUDO docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)"
$SUDO docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx '${NETWORK_NAME}' && echo "network=true" || echo "network=false"
[ -d ${BASE_PATH} ] && echo "mainDirectory=true" || echo "mainDirectory=false"
if [ "$(id -u)" -eq 0 ]; then echo "privilegeMode=root"; elif sudo -n true 2>/dev/null; then echo "privilegeMode=sudo"; else echo "privilegeMode=none"; fi
groups | grep -qw docker && echo "dockerGroup=true" || echo "dockerGroup=false"
`;

export type ValidationResult = {
	docker: { version: string; enabled: boolean };
	rclone: { version: string; enabled: boolean };
	nixpacks: { version: string; enabled: boolean };
	railpack: { version: string; enabled: boolean };
	buildpacks: { version: string; enabled: boolean };
	traefik: { version: string; enabled: boolean };
	isSwarmInstalled: boolean;
	isPanaraCloudNetworkInstalled: boolean;
	isMainDirectoryInstalled: boolean;
	privilegeMode: "root" | "sudo" | "none";
	dockerGroupMember: boolean;
};

export const validateServer = async (host: Host): Promise<ValidationResult> => {
	const output = await runScript(host, validateScript);
	const values = Object.fromEntries(
		output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^\w+=/.test(line))
			.map((line) => [
				line.slice(0, line.indexOf("=")),
				line.slice(line.indexOf("=") + 1),
			]),
	);
	const tool = (key: string) => ({
		version: values[key] || "0.0.0",
		enabled: Boolean(values[key]),
	});
	const privilege = values.privilegeMode;
	return {
		docker: tool("docker"),
		rclone: tool("rclone"),
		nixpacks: tool("nixpacks"),
		railpack: tool("railpack"),
		buildpacks: tool("pack"),
		traefik: tool("traefik"),
		isSwarmInstalled: values.swarm === "active",
		isPanaraCloudNetworkInstalled: values.network === "true",
		isMainDirectoryInstalled: values.mainDirectory === "true",
		privilegeMode:
			privilege === "root" || privilege === "sudo" ? privilege : "none",
		dockerGroupMember: values.dockerGroup === "true",
	};
};

// Security audit (ufw, sshd, fail2ban); idea from
// https://github.com/healthyhost/audit-vps-script.
export const auditScript = `
echo "<<ufw"
if command -v ufw >/dev/null 2>&1; then
	echo "installed=true"
	$SUDO ufw status 2>/dev/null | grep -q "Status: active" && echo "active=true" || echo "active=false"
	echo "defaultIncoming=$($SUDO ufw status verbose 2>/dev/null | grep "Default:" | awk '{print $2}' | head -n1 | tr -d '\\r')"
else
	echo "installed=false"
fi
echo "<<ssh"
if systemctl is-active --quiet sshd || systemctl is-active --quiet ssh; then
	echo "enabled=true"
	SSHD=$(command -v sshd || echo /usr/sbin/sshd)
	$SUDO "$SSHD" -T 2>/dev/null | grep -Ei '^(pubkeyauthentication|permitrootlogin|passwordauthentication|usepam) ' | awk '{print tolower($1) "=" $2}'
else
	echo "enabled=false"
fi
echo "<<fail2ban"
if command -v fail2ban-client >/dev/null 2>&1; then
	echo "installed=true"
	systemctl is-enabled --quiet fail2ban.service 2>/dev/null && echo "enabled=true" || echo "enabled=false"
	systemctl is-active --quiet fail2ban.service 2>/dev/null && echo "active=true" || echo "active=false"
	if $SUDO fail2ban-client status sshd >/dev/null 2>&1; then echo "sshEnabled=true"; else echo "sshEnabled=false"; fi
else
	echo "installed=false"
fi
`;
