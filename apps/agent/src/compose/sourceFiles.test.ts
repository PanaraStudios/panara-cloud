import { describe, expect, test } from "vitest";
import { collectSourceFiles, interpolatePath } from "./sourceFiles";

const BASE = "/etc/panara-cloud/compose/app";

describe("interpolatePath", () => {
	test("resolves what docker compose would, from known variables", () => {
		const env = { DIR: "conf", EMPTY: "" };
		expect(interpolatePath("${DIR}/a.yml", env)).toBe("conf/a.yml");
		expect(interpolatePath("$DIR/a.yml", env)).toBe("conf/a.yml");
		expect(interpolatePath("${NONE:-def}/a.yml", env)).toBe("def/a.yml");
		expect(interpolatePath("${EMPTY:-def}", env)).toBe("def");
		expect(interpolatePath("${EMPTY-def}", env)).toBe("");
		expect(interpolatePath("${DIR:+x}${NONE+y}", env)).toBe("x");
		expect(interpolatePath("a$$b", env)).toBe("a$b");
	});

	test("refuses what it cannot know for certain", () => {
		for (const path of [
			"${NONE}/a",
			"$NONE",
			"${A:-${B}}",
			"${NONE:?x}",
			"${",
		]) {
			expect(() => interpolatePath(path, {}), path).toThrow(
				/uses a variable this deploy cannot check/,
			);
		}
	});
});

describe("collectSourceFiles", () => {
	const collect = (
		files: Record<string, string>,
		top: string,
		projectDir = "code",
	) =>
		collectSourceFiles({
			base: BASE,
			composeFile: "code/docker-compose.yml",
			text: top,
			projectDir,
			env: { SUB: "inc" },
			lookup: async (path) => files[path] ?? null,
			strict: true,
		});

	test("follows nested includes, extends and label files where docker compose resolves them", async () => {
		const found = await collect(
			{
				"code/inc/extra.yml":
					"include:\n  - nested.yml\nservices:\n  w:\n    extends:\n      file: ../base.yml\n      service: b\n",
				"code/inc/nested.yml": "services:\n  n:\n    label_file: n.labels\n",
				"code/inc/n.labels": "a=b\n",
				"code/inc/.env": "X=1\n",
				"code/base.yml": "services:\n  b:\n    image: busybox\n",
				"files/labels": "c=d\n",
			},
			"include:\n  - ${SUB}/extra.yml\nservices:\n  web:\n    label_file: ../files/labels\n",
		);
		expect([...found.keys()].sort()).toEqual([
			"code/base.yml",
			"code/inc/.env",
			"code/inc/extra.yml",
			"code/inc/n.labels",
			"code/inc/nested.yml",
			"files/labels",
		]);
	});

	test("resolves the top file's paths against the project directory, and copies the file's own folder's match too", async () => {
		const found = await collectSourceFiles({
			base: BASE,
			composeFile: "code/sub/docker-compose.yml",
			text: "include:\n  - x.yml\n",
			projectDir: "code",
			env: {},
			lookup: async (path) =>
				path === "code/x.yml"
					? "services:\n  a:\n    label_file: l\n"
					: path === "code/sub/x.yml" || path === "code/l"
						? "a=b\n"
						: null,
			strict: true,
		});
		expect([...found.keys()].sort()).toEqual([
			"code/l",
			"code/sub/x.yml",
			"code/x.yml",
		]);
	});

	test("leaves remote includes and host files outside Panara Cloud's folders to docker compose", async () => {
		const found = await collect(
			{},
			"include:\n  - oci://registry.example/app:1\n  - /srv/shared/compose.yml\n",
		);
		expect(found.size).toBe(0);
	});

	test("refuses paths out of the service's folder, either way they could resolve", async () => {
		await expect(
			collect({}, "include:\n  - ../../other/code/x.yml\n"),
		).rejects.toThrow(/leaves the service's folder/);
		await expect(
			collect(
				{},
				"services:\n  a:\n    label_file: /etc/panara-cloud/compose/app/code/l\n",
			),
		).rejects.toThrow(/in Panara Cloud's folders/);
	});

	test("a lenient collection skips what it cannot follow", async () => {
		const found = await collectSourceFiles({
			base: BASE,
			composeFile: "code/docker-compose.yml",
			text: "include:\n  - ${NOPE}/a.yml\n  - b.yml\n",
			projectDir: "code",
			env: {},
			lookup: async (path) => (path === "code/b.yml" ? "services: {}\n" : null),
			strict: false,
		});
		expect([...found.keys()]).toEqual(["code/b.yml"]);
	});
});
