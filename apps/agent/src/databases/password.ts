import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { containerLookup } from "./backup";
import { exportLine, runHostScript } from "./script";
import type { Engine } from "./service";

export type PasswordChangeInput = {
	engine: Engine;
	appName: string;
	user: "user" | "root";
	credentials: {
		databaseUser?: string;
		password: string;
		rootPassword?: string;
	};
	newPassword: string;
};

type Options = { log: (text: string) => void; signal?: AbortSignal };

// Passwords are limited to DATABASE_PASSWORD_REGEX (no quotes, backslashes,
// spaces or `$`), so they can sit inside SQL string literals.
const SAFE_PASSWORD = /^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]+$/;
const SAFE_USER = /^[a-zA-Z0-9_][a-zA-Z0-9_.$-]{0,62}$/;

// MySQL's image creates root for both '%' and 'localhost'; backups connect
// as root@localhost, so both change.
const mysqlStatements = (user: string, password: string) =>
	[
		`ALTER USER '${user}'@'%' IDENTIFIED BY '${password}';`,
		...(user === "root"
			? [`ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '${password}';`]
			: []),
		"FLUSH PRIVILEGES;",
	].join(" ");

// Statements travel on stdin and secrets as `docker exec -e NAME`, so none of
// them appear in a host process list.
export const passwordChangeScript = (input: PasswordChangeInput): string => {
	const { credentials, newPassword } = input;
	if (!SAFE_PASSWORD.test(newPassword)) {
		throw new Error("The new password contains unsupported characters");
	}
	const user =
		input.user === "root" ? "root" : (credentials.databaseUser ?? "");
	if (input.engine !== "redis" && !SAFE_USER.test(user)) {
		throw new Error(`Invalid database user: ${user}`);
	}
	const env: string[] = [exportLine("NEW_PASS", newPassword)];
	let command: string;
	switch (input.engine) {
		case "postgres":
			env.push(
				exportLine(
					"SQL",
					`ALTER USER "${user}" WITH PASSWORD '${newPassword}';`,
				),
				exportLine("DB_USER", user),
			);
			command = `printf '%s\\n' "$SQL" | docker exec -i -e DB_USER "$CONTAINER_ID" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d postgres'`;
			break;
		case "mysql":
		case "mariadb": {
			const client = input.engine === "mysql" ? "mysql" : "mariadb";
			const sql = mysqlStatements(user, newPassword);
			env.push(
				exportLine("SQL", sql),
				exportLine("MYSQL_PWD", credentials.rootPassword ?? ""),
			);
			command = `printf '%s\\n' "$SQL" | docker exec -i -e MYSQL_PWD "$CONTAINER_ID" ${client} -u root`;
			break;
		}
		case "mongo":
			env.push(
				exportLine("DB_USER", user),
				exportLine("DB_PASS", credentials.password),
			);
			command = `docker exec -e DB_USER -e DB_PASS -e NEW_PASS "$CONTAINER_ID" sh -c 'mongosh --quiet -u "$DB_USER" -p "$DB_PASS" --authenticationDatabase admin --eval "db.getSiblingDB(\\"admin\\").changeUserPassword(process.env.DB_USER, process.env.NEW_PASS)"'`;
			break;
		case "redis":
			env.push(exportLine("REDISCLI_AUTH", credentials.password));
			command = `out=$(printf 'CONFIG SET requirepass %s\\n' "$NEW_PASS" | docker exec -i -e REDISCLI_AUTH "$CONTAINER_ID" redis-cli 2>&1); echo "$out" | grep -v '^OK$' || true; [ "$(echo "$out" | tail -n 1)" = "OK" ]`;
			break;
		case "libsql":
			return "";
	}
	return `${env.join("\n")}
CONTAINER_ID=$(${containerLookup({ kind: "swarm", appName: input.appName })})
if [ -z "$CONTAINER_ID" ]; then
	echo ${quote(`❌ No running container found for ${input.appName}`)}
	exit 1
fi
${command}
echo "Password changed ✅"`;
};

// libsql has no in-place change: its credentials come from the service env,
// so the redeploy queued after the job applies them.
export const changeDatabasePassword = async (
	host: Host,
	input: PasswordChangeInput,
	options: Options,
) => {
	const script = passwordChangeScript(input);
	if (!script) {
		options.log(
			"libsql reads its credentials at start; redeploying applies them\n",
		);
		return;
	}
	await runHostScript(host, script, {
		onOutput: options.log,
		signal: options.signal,
		secrets: [
			input.newPassword,
			input.credentials.password,
			input.credentials.rootPassword,
		],
	});
};
