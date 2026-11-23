import type { ValidatorJson } from "./apiSpec";

// Checks a call's arguments against the function's validator before the
// gateway calls it. Convex checks them too, but a backend run with
// --redact-logs-to-client (as installs are) answers a failed check with a
// bare "Server Error", which would leave an API client a 500 for its own
// typo. Document ids are only checked to be strings here; whether one
// belongs to the right table needs the database (see `ids`).

export type IdArg = { tableName: string; id: string; path: string };
export type ArgsCheck = { error: string | null; ids: IdArg[] };

const MISMATCH = "Value does not match validator.";

const at = (path: string) => (path ? ` Path: ${path}` : "");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	!(value instanceof ArrayBuffer);

const fieldPath = (path: string, key: string) =>
	/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;

const check = (
	validator: ValidatorJson,
	value: unknown,
	path: string,
	ids: IdArg[] | null,
): string | null => {
	switch (validator.type) {
		case "any":
			return null;
		case "null":
			return value === null ? null : `${MISMATCH}${at(path)}`;
		case "number":
		case "bigint":
		case "boolean":
		case "string":
			return typeof value === validator.type ? null : `${MISMATCH}${at(path)}`;
		case "bytes":
			return value instanceof ArrayBuffer ? null : `${MISMATCH}${at(path)}`;
		case "literal":
			return value === validator.value ? null : `${MISMATCH}${at(path)}`;
		case "id":
			if (typeof value !== "string") return `${MISMATCH}${at(path)}`;
			ids?.push({ tableName: validator.tableName, id: value, path });
			return null;
		case "array": {
			if (!Array.isArray(value)) return `${MISMATCH}${at(path)}`;
			for (const [index, item] of value.entries()) {
				const error = check(validator.value, item, `${path}[${index}]`, ids);
				if (error) return error;
			}
			return null;
		}
		case "record": {
			if (!isPlainObject(value)) return `${MISMATCH}${at(path)}`;
			for (const [key, item] of Object.entries(value)) {
				const keyError = check(validator.keys, key, path, null);
				if (keyError) return `${MISMATCH}${at(fieldPath(path, key))}`;
				const error = check(
					validator.values.fieldType,
					item,
					fieldPath(path, key),
					ids,
				);
				if (error) return error;
			}
			return null;
		}
		case "object": {
			if (!isPlainObject(value)) return `${MISMATCH}${at(path)}`;
			for (const [key, field] of Object.entries(validator.value)) {
				if (value[key] === undefined) {
					if (field.optional) continue;
					return `Object is missing the required field \`${key}\`.${at(path)}`;
				}
				const error = check(
					field.fieldType,
					value[key],
					fieldPath(path, key),
					ids,
				);
				if (error) return error;
			}
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(validator.value, key)) {
					return `Object contains extra field \`${key}\` that is not in the validator.${at(path)}`;
				}
			}
			return null;
		}
		case "union": {
			// Ids inside a union are left to Convex: which member matched can
			// depend on the table.
			return validator.value.some((member) => !check(member, value, path, null))
				? null
				: `${MISMATCH}${at(path)}`;
		}
	}
};

export const checkArgs = (
	validator: ValidatorJson,
	args: Record<string, unknown>,
): ArgsCheck => {
	const ids: IdArg[] = [];
	const error = check(validator, args, "", ids);
	return { error, ids: error ? [] : ids };
};
