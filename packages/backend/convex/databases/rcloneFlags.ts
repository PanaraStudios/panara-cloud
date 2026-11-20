// Shared by the backend (destination validation) and the agent (rclone
// command lines), so keep this file free of Convex imports.
//
// Destination flags run inside the agent's rclone on the host, so only flags
// that tune S3 behaviour or transfers are accepted. Anything that reads or
// writes host files (--config, --log-file, --*-file, --ca-cert), runs
// commands (--password-command), starts servers (--rc*) or pulls ambient
// credentials (--s3-env-auth, --s3-profile) is refused.
export const RCLONE_FLAG_FORMAT = /^--[a-z0-9-]+(=[a-zA-Z0-9._:/@-]+)?$/;

export const ALLOWED_RCLONE_FLAGS: ReadonlySet<string> = new Set([
	"--bwlimit",
	"--buffer-size",
	"--checkers",
	"--contimeout",
	"--fast-list",
	"--ignore-checksum",
	"--low-level-retries",
	"--multi-thread-cutoff",
	"--multi-thread-streams",
	"--no-check-certificate",
	"--retries",
	"--retries-sleep",
	"--s3-acl",
	"--s3-chunk-size",
	"--s3-copy-cutoff",
	"--s3-directory-markers",
	"--s3-disable-checksum",
	"--s3-disable-http2",
	"--s3-list-chunk",
	"--s3-list-version",
	"--s3-location-constraint",
	"--s3-max-upload-parts",
	"--s3-no-check-bucket",
	"--s3-no-head",
	"--s3-no-head-object",
	"--s3-requester-pays",
	"--s3-sign-accept-encoding",
	"--s3-server-side-encryption",
	"--s3-sse-kms-key-id",
	"--s3-storage-class",
	"--s3-upload-concurrency",
	"--s3-upload-cutoff",
	"--s3-use-accelerate-endpoint",
	"--s3-use-already-exists",
	"--s3-use-multipart-etag",
	"--s3-use-multipart-uploads",
	"--s3-use-presigned-request",
	"--s3-v2-auth",
	"--timeout",
	"--tpslimit",
	"--tpslimit-burst",
	"--transfers",
	"--use-server-modtime",
]);

// Null when the flag is allowed, else why it isn't.
export const rcloneFlagError = (flag: string): string | null => {
	if (!RCLONE_FLAG_FORMAT.test(flag)) {
		return `Invalid rclone flag "${flag}": use --name or --name=value (letters, digits and ._:/@- only)`;
	}
	const name = flag.split("=")[0] ?? flag;
	if (!ALLOWED_RCLONE_FLAGS.has(name)) {
		return `The rclone flag ${name} is not allowed. Allowed flags: ${[...ALLOWED_RCLONE_FLAGS].join(", ")}`;
	}
	return null;
};
