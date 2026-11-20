import { isIP } from "node:net";
import type { Host } from "../host/types";

const MAX_ADDRESSES = 64;

// Server IP candidates: global interface addresses plus the
// public address the host is seen from (it may sit behind NAT).
export const ADDRESSES_SCRIPT = [
	"ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1",
	"curl -fsS -m 5 https://ifconfig.me 2>/dev/null || curl -fsS -m 5 https://icanhazip.com 2>/dev/null",
	"echo",
	"exit 0",
].join("\n");

export const parseAddresses = (output: string): string[] =>
	[
		...new Set(
			output
				.split(/\s+/)
				.map((candidate) => candidate.trim())
				.filter((candidate) => isIP(candidate) !== 0),
		),
	].slice(0, MAX_ADDRESSES);

export const probeHostAddresses = async (host: Host): Promise<string[]> =>
	parseAddresses((await host.exec(ADDRESSES_SCRIPT)).output);
