import { probeHostAddresses } from "../../infra/addresses";
import type { JobContext, JobResult } from "../types";
import { errorMessage, reportOpResult, specOf, withJobHost } from "./common";

export const probeAddresses = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.probeAddresses");
	try {
		const addresses = await withJobHost(ctx, (host) =>
			probeHostAddresses(host),
		);
		ctx.log.line(`Addresses: ${addresses.join(", ") || "(none)"}`);
		await reportOpResult(ctx, { addresses });
	} catch (error) {
		await reportOpResult(ctx, undefined, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
