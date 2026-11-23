// What an import dialog's review showed: the compose file and the values
// generated for it (passwords, hosts), as the template preview returns them.
export type ReviewedTemplate = {
	compose: string;
	template: {
		domains: Array<{
			serviceName: string;
			port: number;
			path?: string;
			host?: string;
		}>;
		envs: string[];
		mounts: Array<{ filePath: string; content: string }>;
	};
};

// The `previewed` argument of importTemplate, so the import stores the values
// the review showed instead of generating new ones. Without a review the
// backend generates them.
export const previewedImport = (reviewed: ReviewedTemplate | null) =>
	reviewed
		? {
				previewed: {
					compose: reviewed.compose,
					envs: reviewed.template.envs,
					domains: reviewed.template.domains,
					mounts: reviewed.template.mounts,
				},
			}
		: {};
