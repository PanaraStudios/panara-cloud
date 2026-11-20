// Panel host setup, run once by the installer (and again on upgrade) from the
// agent image: `docker run --rm -v /var/run/docker.sock:... -v /etc/panara-cloud:...
// panara-cloud-agent panel-setup`. It prepares /etc/panara-cloud, writes the
// Traefik config, starts panara-cloud-traefik and routes the panel domain,
// with the same code the agent's server setup and Web Server jobs use.
//
//   PANARA_CLOUD_DOMAIN             panel domain (optional; none = IP access on :3000)
//   PANARA_CLOUD_HTTPS              "true" to serve the domain over HTTPS (Let's Encrypt)
//   PANARA_CLOUD_LETSENCRYPT_EMAIL  ACME account email
//   PANARA_CLOUD_*_UPSTREAM         same-origin routes (see infra/traefik/config.ts)
import { chmod, mkdir } from "node:fs/promises";
import { LocalHost } from "./host/local";
import {
	ensureTraefik,
	ensureTraefikConfig,
	recreateTraefik,
	writePanelRouting,
} from "./infra/traefik";
import { updateLetsEncryptEmail } from "./infra/traefik/config";
import { readTraefikState, restartTraefik } from "./infra/traefik/container";
import { paths } from "./lib/constants";

const log = (line: string) => console.log(`[panel-setup] ${line}`);

const main = async () => {
	const host = new LocalHost();
	for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true });
	await chmod(paths.ssh, 0o700);
	log(`Directories under ${paths.base} ready`);

	const state = await readTraefikState(host);
	const config = await ensureTraefikConfig(host, {
		swarmWorker: false,
		dashboard: state.dashboard,
	});
	if (config.wroteMain) log("Traefik config created");
	if (config.changedMain) log("Traefik config updated");
	const options = {
		env: null,
		additionalPorts: state.additionalPorts,
		dashboard: state.dashboard,
	};
	const existed = state.exists;
	if (existed && (config.wroteMain || config.changedMain)) {
		await recreateTraefik(host, options, log);
	} else {
		await ensureTraefik(host, options, log);
	}

	const domain = process.env.PANARA_CLOUD_DOMAIN?.trim() || null;
	const https = process.env.PANARA_CLOUD_HTTPS === "true";
	await writePanelRouting(host, {
		host: domain,
		https,
		certificateType: https ? "letsencrypt" : "none",
	});
	log(domain ? `Panel routed through ${domain}` : "No panel domain");
	const email = process.env.PANARA_CLOUD_LETSENCRYPT_EMAIL?.trim();
	if (email && (await updateLetsEncryptEmail(host, email))) {
		log("Let's Encrypt email updated; restarting Traefik");
		await restartTraefik(host);
	}
	host.close();
};

main().catch((error) => {
	console.error(
		`[panel-setup] ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
