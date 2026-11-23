/* A server's cluster (Docker Swarm): what the screens share that needs no
   React. */

/** What Docker Swarm needs open between two nodes. */
export const SWARM_PORTS = "2377/tcp · 7946/tcp+udp · 4789/udp";

/** How Panara Cloud filters those ports and how to let a node in. */
export const SWARM_PORTS_GUIDE =
	"https://github.com/PanaraStudios/panara-cloud/blob/main/docs/install.md#swarm-ports";

/** A join command with its token hidden. A token is
    `SWMTKN-1-<certificate digest>-<secret>`: only the start of the digest
    stays, so it still reads as a token and the secret never shows. */
export const maskToken = (command: string) =>
	command.replace(
		/(SWMTKN-1-\w{4})[\w-]+/,
		(_, start: string) => `${start}${"•".repeat(24)}`,
	);
