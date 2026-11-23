import assert from "node:assert/strict";
import { test } from "node:test";
import {
	deletingTogether,
	keptVolumeNotices,
	volumePlan,
} from "./volume-plan.ts";

const SHOP = { name: "Shop" };
const BLOG = { name: "Blog" };

test("nothing is said before the panel has answered", () => {
	assert.equal(volumePlan([SHOP], undefined), undefined);
});

test("volumes are split into removed and kept with the reason", () => {
	assert.deepEqual(
		volumePlan(
			[SHOP],
			[
				{
					appName: "shop-a1",
					volumes: [
						{ name: "shop-a1_data", keptBecause: null },
						{
							name: "shared",
							keptBecause: "still used by Blog (Compose service)",
						},
					],
				},
			],
		),
		{
			hasVolumes: true,
			removed: ["shop-a1_data"],
			kept: [
				{ name: "shared", reason: "still used by Blog (Compose service)" },
			],
			unlisted: [],
		},
	);
});

test("a service without volumes offers none; one read from Git may have some", () => {
	assert.equal(
		volumePlan([SHOP], [{ appName: "shop-a1", volumes: [] }])?.hasVolumes,
		false,
	);
	assert.deepEqual(
		volumePlan(
			[SHOP, BLOG],
			[
				{ appName: "shop-a1", volumes: [] },
				{ appName: "blog-b2", volumes: null },
			],
		),
		{ hasVolumes: true, removed: [], kept: [], unlisted: ["Blog"] },
	);
});

test("a volume two selected services share is listed once, and kept if either keeps it", () => {
	const shared = (keptBecause: string | null) => ({
		name: "shared",
		keptBecause,
	});
	assert.deepEqual(
		volumePlan(
			[SHOP, BLOG],
			[
				{ appName: "shop-a1", volumes: [shared(null)] },
				{ appName: "blog-b2", volumes: [shared(null)] },
			],
		)?.removed,
		["shared"],
	);
	const plan = volumePlan(
		[SHOP, BLOG],
		[
			{ appName: "shop-a1", volumes: [shared(null)] },
			{ appName: "blog-b2", volumes: [shared("still used by Wiki")] },
		],
	);
	assert.deepEqual(plan?.removed, []);
	assert.deepEqual(plan?.kept, [
		{ name: "shared", reason: "still used by Wiki" },
	]);
});

test("each removal is told the other services of the same delete", () => {
	const plans = [
		{ appName: "shop-a1", volumes: [] },
		{ appName: null, volumes: [] },
		{ appName: "blog-b2", volumes: null },
	];
	assert.deepEqual(deletingTogether(plans, 0), ["blog-b2"]);
	assert.deepEqual(deletingTogether(plans, 2), ["shop-a1"]);
	assert.deepEqual(deletingTogether(undefined, 0), []);
});

test("a kept volume becomes one notice saying why", () => {
	assert.deepEqual(keptVolumeNotices("Shop", { kept: [] }), []);
	assert.deepEqual(keptVolumeNotices("Shop", null), []);
	assert.deepEqual(
		keptVolumeNotices("Shop", {
			kept: [
				{ name: "shared", reason: "still used by container blog-1 (exited)" },
				{ name: "a".repeat(64), reason: "still used by container x (running)" },
			],
		}),
		[
			{
				title: "Kept volume shared",
				description:
					"Still used by container blog-1 (exited). Shop itself was deleted.",
			},
			{
				title: "Kept an anonymous volume of Shop",
				description:
					"Still used by container x (running). Shop itself was deleted.",
			},
		],
	);
});
