type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export async function serverIdFrom(searchParams: SearchParams) {
	const serverId = first((await searchParams).serverId);
	return encodeURIComponent(serverId || "local");
}

export async function param(searchParams: SearchParams, name: string) {
	return first((await searchParams)[name]);
}

export type { SearchParams };
