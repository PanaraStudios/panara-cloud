import { expect, test } from "vitest";
import { rcloneFlagError } from "./rcloneFlags";

test("only S3 and transfer tuning flags are accepted", () => {
	for (const flag of [
		"--s3-upload-concurrency=8",
		"--no-check-certificate",
		"--timeout=30s",
	]) {
		expect(rcloneFlagError(flag)).toBeNull();
	}
	for (const flag of [
		"--config=/tmp/x",
		"--log-file=/etc/cron.d/x",
		"--rc",
		"--rc-addr=0.0.0.0:5572",
		"--password-command=id",
		"--s3-env-auth",
		"--files-from=/etc/shadow",
	]) {
		expect(rcloneFlagError(flag)).toMatch(/is not allowed/);
	}
	expect(rcloneFlagError("--x;rm")).toMatch(/Invalid rclone flag/);
});
