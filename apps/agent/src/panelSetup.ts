// Panel host setup, run once by the installer (and again on upgrade) from the
// agent image: `docker run --rm -v /var/run/docker.sock:... -v /etc/panara-cloud:...
// panara-cloud-agent panel-setup`. It prepares /etc/panara-cloud, writes the
// Traefik config, starts panara-cloud-traefik and routes the panel domain,
// with the same code the agent's server setup and Web Server jobs use.
//
//   PANARA_CLOUD_DOMAIN             panel domain (optional; none = IP access on :3000,
//                                   and a domain routed from the panel stays)
//   PANARA_CLOUD_DOMAIN_REMOVED     "true" when the installer's domain was just
//                                   taken away: its routing is removed
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
import { installerPanelRouting } from "./infra/traefik/config";
import {
	applyLetsEncryptEmail,
	readTraefikState,
} from "./infra/traefik/container";
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

	// The email first: a new route is what makes Traefik request a certificate,
	// and with it register its Let's Encrypt account.
	const email = process.env.PANARA_CLOUD_LETSENCRYPT_EMAIL?.trim();
	if (email) await applyLetsEncryptEmail(host, email, log);
	const routing = installerPanelRouting(process.env);
	if (routing === "keep") {
		log(
			"No panel domain from the installer; the panel's routing is left as it is",
		);
	} else {
		await writePanelRouting(host, routing);
		log(
			routing.host
				? `Panel routed through ${routing.host}`
				: "Panel domain routing removed",
		);
	}
	host.close();
};

main().catch((error) => {
	console.error(
		`[panel-setup] ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
