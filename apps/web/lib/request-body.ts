// Must match MAX_ARGS_BYTES in packages/backend/convex/platform/lib/apiGateway.ts.
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

// Reads at most `max` bytes of a request body; null when it is larger. A
// declared Content-Length over the limit is refused before anything is read.
export const readCappedBody = async (
	request: Request,
	max = MAX_API_BODY_BYTES,
): Promise<ArrayBuffer | null> => {
	if (Number(request.headers.get("content-length") ?? 0) > max) return null;
	if (!request.body) return new ArrayBuffer(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body.buffer;
};

export const hasApiKey = (headers: Headers): boolean =>
	Boolean(
		headers.get("x-api-key")?.trim() ||
			/^Bearer\s+\S/i.test(headers.get("authorization") ?? ""),
	);
