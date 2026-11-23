import { describe, expect, test } from "vitest";
import { checkArgs } from "./lib/apiArgs";
import type { ValidatorJson } from "./lib/apiSpec";

const object = (
	fields: Record<string, ValidatorJson | [ValidatorJson, "optional"]>,
): ValidatorJson => ({
	type: "object",
	value: Object.fromEntries(
		Object.entries(fields).map(([name, field]) =>
			Array.isArray(field)
				? [name, { fieldType: field[0], optional: true }]
				: [name, { fieldType: field, optional: false }],
		),
	),
});

describe("gateway argument check", () => {
	const validator = object({
		id: { type: "id", tableName: "projects" },
		size: { type: "bigint" },
		data: [{ type: "bytes" }, "optional"],
		kind: {
			type: "union",
			value: [
				{ type: "literal", value: "a" },
				{ type: "literal", value: "b" },
			],
		},
		tags: { type: "array", value: { type: "string" } },
		labels: [
			{
				type: "record",
				keys: { type: "string" },
				values: { fieldType: { type: "number" }, optional: false },
			},
			"optional",
		],
	});
	const ok = {
		id: "p1",
		size: 3n,
		kind: "a",
		tags: ["x"],
		labels: { "a b": 1 },
	};

	test("accepts what the validator accepts and collects document ids", () => {
		expect(checkArgs(validator, ok)).toEqual({
			error: null,
			ids: [{ tableName: "projects", id: "p1", path: ".id" }],
		});
		expect(
			checkArgs(validator, { ...ok, data: new ArrayBuffer(1) }).error,
		).toBeNull();
	});

	test("names the path of the first mismatch", () => {
		expect(checkArgs(validator, { ...ok, size: 3 }).error).toBe(
			"Value does not match validator. Path: .size",
		);
		expect(checkArgs(validator, { ...ok, kind: "c" }).error).toBe(
			"Value does not match validator. Path: .kind",
		);
		expect(checkArgs(validator, { ...ok, tags: ["x", 1] }).error).toBe(
			"Value does not match validator. Path: .tags[1]",
		);
		expect(checkArgs(validator, { ...ok, labels: { "a b": "1" } }).error).toBe(
			'Value does not match validator. Path: .labels["a b"]',
		);
		expect(checkArgs(validator, { ...ok, id: 5 })).toEqual({
			error: "Value does not match validator. Path: .id",
			ids: [],
		});
		const { tags: _, ...missing } = ok;
		expect(checkArgs(validator, missing).error).toBe(
			"Object is missing the required field `tags`.",
		);
	});
});
