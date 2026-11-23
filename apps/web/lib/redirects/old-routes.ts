export function serverIdFrom(searchParams: URLSearchParams) {
	return encodeURIComponent(searchParams.get("serverId") || "local");
}

export function param(searchParams: URLSearchParams, name: string) {
	return searchParams.get(name) ?? undefined;
}
