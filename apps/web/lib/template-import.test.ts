import assert from "node:assert/strict";
import { test } from "node:test";
import { previewedImport, type ReviewedTemplate } from "./template-import.ts";

const reviewed: ReviewedTemplate = {
	compose: "services:\n  db:\n    image: postgres\n",
	template: {
		domains: [{ serviceName: "web", port: 80, host: "shop.example.test" }],
		envs: ["POSTGRES_PASSWORD=shown-in-the-review"],
		mounts: [{ filePath: "init.sql", content: "select 1;" }],
	},
};

test("the import sends exactly what the review showed", () => {
	assert.deepEqual(previewedImport(reviewed), {
		previewed: {
			compose: reviewed.compose,
			envs: ["POSTGRES_PASSWORD=shown-in-the-review"],
			domains: reviewed.template.domains,
			mounts: reviewed.template.mounts,
		},
	});
});

test("without a review the backend generates the values", () => {
	assert.deepEqual(previewedImport(null), {});
});
