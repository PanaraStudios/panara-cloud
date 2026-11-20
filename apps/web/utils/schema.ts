import { z } from "zod";

export const APP_NAME_REGEX = /^[a-z](?!.*--)([a-z0-9-]*[a-z0-9])?$/;
export const APP_NAME_MESSAGE =
	"App name supports lowercase letters, numbers, '-' and must start with a letter, end with a letter or number, and cannot contain consecutive '-'";

// Client-side shape of the drop-to-deploy form; the file itself is uploaded to
// Convex storage.
export const uploadFileSchema = z.object({
	applicationId: z.string().optional(),
	zip: z.instanceof(File),
	dropBuildPath: z.string().optional(),
});

export type UploadFile = z.infer<typeof uploadFileSchema>;
