import type Dockerode from "dockerode";
import { describe, expect, test } from "vitest";
import { pinnedImage } from "./pinnedImage";

const DIGEST = `sha256:${"cd".repeat(32)}`;

const fakeDocker = (
	before: string[],
	after: string[] = before,
): { docker: Dockerode; pulls: string[] } => {
	const pulls: string[] = [];
	const docker = {
		getImage: () => ({
			inspect: async () => ({
				RepoDigests: pulls.length ? after : before,
			}),
		}),
		pull: async (ref: string) => {
			pulls.push(ref);
			return {};
		},
		modem: {
			followProgress: (_: unknown, done: (e: null, events: []) => void) =>
				done(null, []),
		},
	} as unknown as Dockerode;
	return { docker, pulls };
};

describe("platform images run by registry digest", () => {
	test("a locally built image under the tag is replaced by a pull and run by digest", async () => {
		const { docker, pulls } = fakeDocker([], [`traefik@${DIGEST}`]);
		await expect(pinnedImage(docker, "traefik:v3.7.19")).resolves.toBe(
			`traefik:v3.7.19@${DIGEST}`,
		);
		expect(pulls).toEqual(["traefik:v3.7.19"]);
	});

	test("a pulled image is used without pulling again", async () => {
		const { docker, pulls } = fakeDocker([
			`docker.io/timberio/vector@${DIGEST}`,
		]);
		await expect(
			pinnedImage(docker, "timberio/vector:0.58.0-alpine"),
		).resolves.toBe(`timberio/vector:0.58.0-alpine@${DIGEST}`);
		expect(pulls).toEqual([]);
	});

	test("a digest from another repository doesn't count, and no digest at all is refused", async () => {
		const { docker } = fakeDocker([`evil/traefik@${DIGEST}`]);
		await expect(pinnedImage(docker, "traefik:v3.7.19")).rejects.toThrow(
			/no registry digest/,
		);
	});
});
