import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type QueryCtx, query } from "../_generated/server";
import {
	type Access,
	canAccessEnvironment,
	canAccessProject,
	canAccessService,
	hasPermission,
	requirePermission,
	resolvePermissions,
} from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";

const COUNT_CAP = 500;
const RECENT_JOBS = 50;
const RECENT_ACTIVITY = 10;

// Whether a member may see a job's deployment: only those of the services
// they were given (filtered by accessedServices).
const canSeeTarget = async (
	ctx: QueryCtx,
	access: Access,
	target: { kind: string; id: string } | null | undefined,
): Promise<boolean> => {
	if (!access.scope) return true;
	if (!target) return false;
	switch (target.kind) {
		case "application":
		case "compose":
		case "database":
			return canAccessService(access, target.id);
		case "preview": {
			const id = ctx.db.normalizeId("applicationPreviews", target.id);
			const preview = id ? await ctx.db.get("applicationPreviews", id) : null;
			return !!preview && canAccessService(access, preview.applicationId);
		}
		case "schedule": {
			const id = ctx.db.normalizeId("schedules", target.id);
			const schedule = id ? await ctx.db.get("schedules", id) : null;
			return (
				!!schedule &&
				(schedule.target.kind === "application" ||
					schedule.target.kind === "compose") &&
				canAccessService(access, schedule.targetId)
			);
		}
		case "databaseBackup": {
			const id = ctx.db.normalizeId("databaseBackups", target.id);
			const backup = id ? await ctx.db.get("databaseBackups", id) : null;
			return !!backup && canAccessService(access, backup.owner.id);
		}
		case "volumeBackup": {
			const id = ctx.db.normalizeId("volumeBackups", target.id);
			const backup = id ? await ctx.db.get("volumeBackups", id) : null;
			return !!backup && canAccessService(access, backup.owner.id);
		}
		default:
			return false;
	}
};

// Counts are capped (`capped: true` means "at least"); Convex has no count
// operator and the home page doesn't need exact totals beyond the cap.
// Service counts (applications, compose, databases) and backup/domain
// overviews are contributed by those domains' own overview queries.
export const stats = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await resolvePermissions(ctx, organizationId);
		const [allProjects, allServers, allSchedules, allJobs] = await Promise.all([
			ctx.db
				.query("projects")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(COUNT_CAP + 1),
			ctx.db
				.query("servers")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(COUNT_CAP + 1),
			ctx.db
				.query("schedules")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(COUNT_CAP + 1),
			ctx.db
				.query("jobs")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.order("desc")
				.take(RECENT_JOBS),
		]);
		const projects = allProjects.filter((project) =>
			canAccessProject(access, project._id),
		);
		const servers = hasPermission(access, "server", "read") ? allServers : [];
		const schedules = access.scope
			? allSchedules.filter(
					(schedule) =>
						(schedule.target.kind === "application" ||
							schedule.target.kind === "compose") &&
						canAccessService(access, schedule.targetId),
				)
			: allSchedules;
		const jobs = access.scope
			? (
					await Promise.all(
						allJobs.map(async (job) => {
							const deployment = await ctx.db
								.query("deployments")
								.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
								.first();
							return (await canSeeTarget(ctx, access, deployment?.target))
								? job
								: null;
						}),
					)
				).filter((job) => job !== null)
			: allJobs;
		const count = (rows: unknown[]) => ({
			count: Math.min(rows.length, COUNT_CAP),
			capped: rows.length > COUNT_CAP,
		});
		const jobStatus = {
			queued: 0,
			running: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
		};
		for (const job of jobs) jobStatus[job.status]++;
		const recent = await Promise.all(
			jobs.slice(0, RECENT_ACTIVITY).map(async (job) => {
				const deployment = await ctx.db
					.query("deployments")
					.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
					.first();
				return {
					jobId: job._id,
					kind: job.spec.kind,
					status: job.status,
					createdAt: job._creationTime,
					finishedAt: job.finishedAt,
					title: deployment?.title ?? null,
					target: deployment?.target ?? null,
				};
			}),
		);
		return {
			projects: count(projects),
			servers: {
				...count(servers),
				validated: servers.filter((s) => s.lastValidation?.ok).length,
			},
			schedules: {
				...count(schedules),
				enabled: schedules.filter((s) => s.enabled).length,
			},
			recentJobs: { window: jobs.length, byStatus: jobStatus },
			recentActivity: recent,
		};
	},
});

const HOME_DEPLOYMENT_JOBS = 200;
const MAX_ENVIRONMENTS_PER_PROJECT = 100;
const PANEL_SERVER_NAME = "Panara Cloud";

const homeDeploymentStatus = (status: Doc<"jobs">["status"]) =>
	status === "succeeded" ? "done" : status === "failed" ? "error" : status;

type ServiceDoc = Doc<"applications"> | Doc<"compose">;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEPLOY_COUNT_CAP = 2500;
const DEPLOY_KINDS = ["application", "compose"] as const;

// Home "Deploys / 7d": application and compose deployments in the last 7 days
// and the 7 days before, counted over index ranges. `now` comes from the
// client (rounded) because queries can't read the clock reactively. Each
// count stops at the cap (`capped: true` means "at least").
export const deployStats = query({
	args: { organizationId: v.string(), now: v.number() },
	handler: async (ctx, { organizationId, now }) => {
		await requirePermission(ctx, organizationId, "deployment", "read");
		const count = async (from: number, to: number) => {
			let total = 0;
			for (const kind of DEPLOY_KINDS) {
				const rows = await ctx.db
					.query("deployments")
					.withIndex("by_organizationId_and_targetKind", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("target.kind", kind)
							.gte("_creationTime", from)
							.lt("_creationTime", to),
					)
					.take(DEPLOY_COUNT_CAP + 1 - total);
				total += rows.length;
				if (total > DEPLOY_COUNT_CAP) break;
			}
			return {
				count: Math.min(total, DEPLOY_COUNT_CAP),
				capped: total > DEPLOY_COUNT_CAP,
			};
		};
		const [last, previous] = await Promise.all([
			count(now - WEEK_MS, now),
			count(now - 2 * WEEK_MS, now - WEEK_MS),
		]);
		return { last, previous };
	},
});

// The home page: service totals and status for the organization, plus
// its recent application/compose deployments (the latest jobs). Exact 7-day
// counts come from `deployStats`.
export const home = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await resolvePermissions(ctx, organizationId);
		const [allProjects, allApplications, allCompose, allDatabases, jobs] =
			await Promise.all([
				ctx.db
					.query("projects")
					.withIndex("by_organizationId", (q) =>
						q.eq("organizationId", organizationId),
					)
					.take(COUNT_CAP + 1),
				ctx.db
					.query("applications")
					.withIndex("by_organizationId", (q) =>
						q.eq("organizationId", organizationId),
					)
					.take(COUNT_CAP + 1),
				ctx.db
					.query("compose")
					.withIndex("by_organizationId", (q) =>
						q.eq("organizationId", organizationId),
					)
					.take(COUNT_CAP + 1),
				ctx.db
					.query("databases")
					.withIndex("by_organizationId", (q) =>
						q.eq("organizationId", organizationId),
					)
					.take(COUNT_CAP + 1),
				ctx.db
					.query("jobs")
					.withIndex("by_organizationId", (q) =>
						q.eq("organizationId", organizationId),
					)
					.order("desc")
					.take(HOME_DEPLOYMENT_JOBS),
			]);
		const projects = allProjects.filter((project) =>
			canAccessProject(access, project._id),
		);
		const visible = <T extends { _id: string }>(rows: T[]) =>
			rows.filter((row) => canAccessService(access, row._id));
		const applications = visible(allApplications);
		const compose = visible(allCompose);
		const databases = visible(allDatabases);
		const environments = await Promise.all(
			projects.slice(0, COUNT_CAP).map(async (project) =>
				(
					await ctx.db
						.query("environments")
						.withIndex("by_projectId", (q) => q.eq("projectId", project._id))
						.take(MAX_ENVIRONMENTS_PER_PROJECT)
				).filter((environment) =>
					canAccessEnvironment(access, environment._id),
				),
			),
		);

		const status = { running: 0, error: 0, idle: 0 };
		for (const service of [...applications, ...compose, ...databases].slice(
			0,
			3 * COUNT_CAP,
		)) {
			if (service.status === "done") status.running++;
			else if (service.status === "error") status.error++;
			else status.idle++;
		}
		const capped = (rows: unknown[]) => Math.min(rows.length, COUNT_CAP);
		const totals = {
			projects: capped(projects),
			environments: environments.reduce((sum, envs) => sum + envs.length, 0),
			applications: capped(applications),
			compose: capped(compose),
			databases: capped(databases),
		};

		const deployments = (await recentServiceDeployments(ctx, jobs)).filter(
			(row) => canAccessService(access, row.serviceId),
		);
		return {
			...totals,
			services: totals.applications + totals.compose + totals.databases,
			capped: [projects, applications, compose, databases].some(
				(rows) => rows.length > COUNT_CAP,
			),
			status,
			deployments,
		};
	},
});

const recentServiceDeployments = async (ctx: QueryCtx, jobs: Doc<"jobs">[]) => {
	const services = new Map<string, ServiceDoc | null>();
	const environments = new Map<string, Doc<"environments"> | null>();
	const projects = new Map<string, Doc<"projects"> | null>();
	const servers = new Map<string, Doc<"servers"> | null>();
	const cached = async <T>(
		cache: Map<string, T | null>,
		key: string,
		load: () => Promise<T | null>,
	) => {
		if (!cache.has(key)) cache.set(key, await load());
		return cache.get(key) ?? null;
	};

	const rows = await Promise.all(
		jobs.map(async (job) => {
			const deployment = await ctx.db
				.query("deployments")
				.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
				.first();
			const kind = deployment?.target.kind;
			if (!deployment || (kind !== "application" && kind !== "compose")) {
				return null;
			}
			const serviceId = deployment.target.id;
			const service = await cached(
				services,
				`${kind}:${serviceId}`,
				async () => {
					const id = ctx.db.normalizeId(
						kind === "application" ? "applications" : "compose",
						serviceId,
					);
					return id ? await ctx.db.get(id) : null;
				},
			);
			if (!service || service.organizationId !== job.organizationId) {
				return null;
			}
			const environment = await cached(
				environments,
				service.environmentId,
				() => ctx.db.get("environments", service.environmentId),
			);
			const project = await cached(projects, service.projectId, () =>
				ctx.db.get("projects", service.projectId),
			);
			if (!environment || !project) return null;
			const serverId = service.serverId;
			const server = serverId
				? await cached(servers, serverId, () =>
						ctx.db.get("servers", serverId as Id<"servers">),
					)
				: null;
			return {
				deploymentId: deployment._id,
				jobId: job._id,
				createdAt: job._creationTime,
				status: homeDeploymentStatus(job.status),
				kind,
				serviceId,
				name: service.name,
				environmentId: environment._id,
				environment: environment.name,
				projectId: project._id,
				projectName: project.name,
				serverName: server?.name ?? PANEL_SERVER_NAME,
			};
		}),
	);
	return rows.filter((row) => row !== null);
};

const MAX_OVERVIEW_ROWS = 500;
const BACKUP_RUNS_PER_BACKUP = 20;
const DEPLOYMENTS_PAGE = 200;
const QUEUE_JOBS = 1000;

type ServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

type JobStatus = Doc<"jobs">["status"];

// Deployment statuses shown in the UI.
export const deploymentStatus = (status: JobStatus | undefined) =>
	status === "queued" || status === "running"
		? "running"
		: status === "succeeded"
			? "done"
			: status === "cancelled"
				? "cancelled"
				: "error";

const iso = (ms: number) => new Date(ms).toISOString();

// Memoized lookups shared by the overview queries: services reference the
// same few projects, environments and servers over and over.
const lookups = (ctx: QueryCtx) => {
	const cache = new Map<string, Promise<unknown>>();
	const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
		let hit = cache.get(key) as Promise<T> | undefined;
		if (!hit) {
			hit = load();
			cache.set(key, hit);
		}
		return hit;
	};
	return {
		project: (id: Id<"projects">) =>
			memo(`p:${id}`, () => ctx.db.get("projects", id)),
		environment: (id: Id<"environments">) =>
			memo(`e:${id}`, () => ctx.db.get("environments", id)),
		server: (id: Id<"servers"> | undefined) =>
			id ? memo(`s:${id}`, () => ctx.db.get("servers", id)) : null,
		application: (id: string) =>
			memo(`a:${id}`, async () => {
				const appId = ctx.db.normalizeId("applications", id);
				return appId ? await ctx.db.get("applications", appId) : null;
			}),
		compose: (id: string) =>
			memo(`c:${id}`, async () => {
				const composeId = ctx.db.normalizeId("compose", id);
				return composeId ? await ctx.db.get("compose", composeId) : null;
			}),
		database: (id: string) =>
			memo(`d:${id}`, async () => {
				const databaseId = ctx.db.normalizeId("databases", id);
				return databaseId ? await ctx.db.get("databases", databaseId) : null;
			}),
		destination: (id: Id<"destinations">) =>
			memo(`dst:${id}`, () => ctx.db.get("destinations", id)),
	};
};

type Lookups = ReturnType<typeof lookups>;

type ServiceRow = {
	_id: string;
	_creationTime: number;
	organizationId: string;
	projectId: Id<"projects">;
	environmentId: Id<"environments">;
	serverId?: Id<"servers">;
	name: string;
	appName: string;
};

const placement = async (look: Lookups, row: ServiceRow) => {
	const [project, environment, server] = await Promise.all([
		look.project(row.projectId),
		look.environment(row.environmentId),
		look.server(row.serverId),
	]);
	return {
		projectId: row.projectId as string,
		projectName: project?.name ?? "",
		environmentId: row.environmentId as string,
		environmentName: environment?.name ?? "",
		serverId: (row.serverId as string | undefined) ?? null,
		serverName: server?.name ?? null,
	};
};

const lastDeployAt = async (
	ctx: QueryCtx,
	kind: string,
	id: string,
): Promise<string | null> => {
	const latest = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", kind).eq("target.id", id),
		)
		.order("desc")
		.first();
	return latest ? iso(latest._creationTime) : null;
};

// Every service of the organization.
export const services = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"service",
			"read",
		);
		const look = lookups(ctx);
		const [applications, composes, databases] = await Promise.all([
			ctx.db
				.query("applications")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
			ctx.db
				.query("compose")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
			ctx.db
				.query("databases")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
		]);
		const rows: {
			row: ServiceRow;
			type: ServiceType;
			status: string;
			icon: string | null;
			target: string;
		}[] = [
			...applications.map((row) => ({
				row,
				type: "application" as const,
				status: row.status,
				icon: null,
				target: "application",
			})),
			...composes.map((row) => ({
				row,
				type: "compose" as const,
				status: row.status,
				icon: row.icon ?? null,
				target: "compose",
			})),
			...databases.map((row) => ({
				row,
				type: row.engine,
				status: row.status,
				icon: null,
				target: "database",
			})),
		];
		const visibleRows = rows.filter(({ row }) =>
			canAccessService(access, row._id),
		);
		return await Promise.all(
			visibleRows.map(async ({ row, type, status, icon, target }) => ({
				id: row._id,
				type,
				name: row.name,
				appName: row.appName,
				status,
				createdAt: iso(row._creationTime),
				icon,
				...(await placement(look, row)),
				lastDeployAt: await lastDeployAt(ctx, target, row._id),
			})),
		);
	},
});

// Domains of the organization's applications, compose projects and preview
// deployments.
export const domains = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"domain",
			"read",
		);
		const look = lookups(ctx);
		const rows = await ctx.db
			.query("domains")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_OVERVIEW_ROWS);
		const resolved = await Promise.all(
			rows.map(async (domain) => {
				let ownerType: "application" | "compose" = "application";
				let owner: ServiceRow | null = null;
				if (domain.owner.kind === "compose") {
					ownerType = "compose";
					owner = await look.compose(domain.owner.id);
				} else if (domain.owner.kind === "application") {
					owner = await look.application(domain.owner.id);
				} else {
					const previewId = ctx.db.normalizeId(
						"applicationPreviews",
						domain.owner.id,
					);
					const preview = previewId
						? await ctx.db.get("applicationPreviews", previewId)
						: null;
					owner = preview
						? await look.application(preview.applicationId)
						: null;
				}
				if (!owner || !canAccessService(access, owner._id)) return null;
				const where = await placement(look, owner);
				return {
					domainId: domain._id as string,
					host: domain.host,
					path: domain.path,
					port: domain.port,
					customEntrypoint: domain.customEntrypoint ?? null,
					https: domain.https,
					certificateType: domain.certificateType,
					createdAt: iso(domain._creationTime),
					enabled: domain.enabled,
					domainType: domain.owner.kind,
					serviceOwnerId: owner._id,
					serviceOwnerType: ownerType,
					serviceName: owner.name,
					projectId: where.projectId,
					projectName: where.projectName,
					environmentId: where.environmentId,
					environmentName: where.environmentName,
				};
			}),
		);
		return resolved.filter((row) => row !== null);
	},
});

type BackupRun = {
	deploymentId: string;
	kind: "backup" | "volumeBackup";
	status: string;
	createdAt: string;
	destinationId: string;
	destinationName: string;
	databaseType: string | null;
	serviceType: string | null;
	backupType: "database" | "compose" | null;
	serviceName: string;
	serviceOwnerId: string | null;
	serviceOwnerType: ServiceType | "web-server";
	serverId: string | null;
	projectId: string | null;
	environmentId: string | null;
};

const backupRuns = async (
	ctx: QueryCtx,
	target: { kind: string; id: string },
) => {
	const deployments = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.order("desc")
		.take(BACKUP_RUNS_PER_BACKUP);
	return await Promise.all(
		deployments.map(async (deployment) => ({
			deploymentId: deployment._id as string,
			createdAt: deployment._creationTime,
			status: deploymentStatus(
				(await ctx.db.get("jobs", deployment.jobId))?.status,
			),
		})),
	);
};

const ownerOf = async (
	look: Lookups,
	owner: { kind: "application" | "compose" | "database"; id: string },
) => {
	if (owner.kind === "database") {
		const row = await look.database(owner.id);
		return row ? { row, type: row.engine as ServiceType } : null;
	}
	const row =
		owner.kind === "compose"
			? await look.compose(owner.id)
			: await look.application(owner.id);
	return row ? { row: row as ServiceRow, type: owner.kind } : null;
};

// Recent runs of the organization's database, volume and panel backups
// (overview of backups).
export const backups = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"backup",
			"read",
		);
		const look = lookups(ctx);
		const [databaseBackups, volumeBackups, panelBackups] = await Promise.all([
			ctx.db
				.query("databaseBackups")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
			ctx.db
				.query("volumeBackups")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
			ctx.db
				.query("panelBackups")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_OVERVIEW_ROWS),
		]);
		const result: BackupRun[] = [];
		const add = async (
			kind: BackupRun["kind"],
			target: { kind: string; id: string },
			destinationId: Id<"destinations">,
			fields: Omit<
				BackupRun,
				| "deploymentId"
				| "kind"
				| "status"
				| "createdAt"
				| "destinationId"
				| "destinationName"
			>,
		) => {
			const destination = await look.destination(destinationId);
			for (const run of await backupRuns(ctx, target)) {
				result.push({
					...fields,
					deploymentId: run.deploymentId,
					kind,
					status: run.status,
					createdAt: iso(run.createdAt),
					destinationId,
					destinationName: destination?.name ?? "",
				});
			}
		};
		for (const backup of databaseBackups) {
			if (!canAccessService(access, backup.owner.id)) continue;
			const owner = await ownerOf(look, backup.owner);
			const where = owner ? await placement(look, owner.row) : null;
			await add(
				"backup",
				{ kind: "databaseBackup", id: backup._id },
				backup.destinationId,
				{
					databaseType: backup.databaseType,
					serviceType: owner?.type ?? null,
					backupType: backup.owner.kind === "compose" ? "compose" : "database",
					serviceName: owner?.row.name ?? backup.database,
					serviceOwnerId: owner?.row._id ?? null,
					serviceOwnerType: owner?.type ?? "application",
					serverId: where?.serverId ?? null,
					projectId: where?.projectId ?? null,
					environmentId: where?.environmentId ?? null,
				},
			);
		}
		for (const backup of volumeBackups) {
			if (!canAccessService(access, backup.owner.id)) continue;
			const owner = await ownerOf(look, backup.owner);
			const where = owner ? await placement(look, owner.row) : null;
			await add(
				"volumeBackup",
				{ kind: "volumeBackup", id: backup._id },
				backup.destinationId,
				{
					databaseType: null,
					serviceType: owner?.type ?? null,
					backupType: null,
					serviceName: owner?.row.name ?? backup.name,
					serviceOwnerId: owner?.row._id ?? null,
					serviceOwnerType: owner?.type ?? "application",
					serverId: where?.serverId ?? null,
					projectId: where?.projectId ?? null,
					environmentId: where?.environmentId ?? null,
				},
			);
		}
		for (const backup of access.scope ? [] : panelBackups) {
			await add(
				"backup",
				{ kind: "panelBackup", id: backup._id },
				backup.destinationId,
				{
					databaseType: "web-server",
					serviceType: "web-server",
					backupType: "database",
					serviceName: "Panara Cloud",
					serviceOwnerId: null,
					serviceOwnerType: "web-server",
					serverId: null,
					projectId: null,
					environmentId: null,
				},
			);
		}
		return result
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, MAX_OVERVIEW_ROWS);
	},
});

const serviceOfTarget = async (
	look: Lookups,
	target: { kind: string; id: string },
) => {
	const row =
		target.kind === "application"
			? await look.application(target.id)
			: target.kind === "compose"
				? await look.compose(target.id)
				: null;
	if (!row) return null;
	const where = await placement(look, row);
	return {
		type: target.kind as "application" | "compose",
		id: row._id as string,
		name: row.name,
		appName: row.appName,
		icon: "icon" in row ? (row.icon ?? null) : null,
		...where,
	};
};

const serverBadge = (server: Doc<"servers"> | null | undefined) =>
	server ? { name: server.name, serverType: server.serverType } : null;

// Application and compose deployments of the organization, newest first
// (all deployments in one list), one page at a time; with the server
// each ran on and the application's build server.
export const deployments = query({
	args: { organizationId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { organizationId, paginationOpts }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"deployment",
			"read",
		);
		const look = lookups(ctx);
		const result = await ctx.db
			.query("deployments")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.paginate({
				...paginationOpts,
				numItems: Math.min(paginationOpts.numItems, DEPLOYMENTS_PAGE),
			});
		const rows = await Promise.all(
			result.page.map(async (deployment) => {
				if (
					deployment.target.kind !== "application" &&
					deployment.target.kind !== "compose"
				) {
					return null;
				}
				const service = await serviceOfTarget(look, deployment.target);
				if (!service || !canAccessService(access, service.id)) return null;
				const job = await ctx.db.get("jobs", deployment.jobId);
				const runsOn =
					job && job.partition !== LOCAL_PARTITION
						? ctx.db.normalizeId("servers", job.partition)
						: null;
				const application =
					deployment.target.kind === "application"
						? await look.application(deployment.target.id)
						: null;
				const [server, buildServer] = await Promise.all([
					runsOn ? look.server(runsOn) : null,
					look.server(application?.buildServerId),
				]);
				return {
					deploymentId: deployment._id as string,
					jobId: deployment.jobId as string,
					title: deployment.title,
					description: deployment.description ?? null,
					status: deploymentStatus(job?.status),
					createdAt: iso(deployment._creationTime),
					startedAt: job?.startedAt ? iso(job.startedAt) : null,
					finishedAt: job?.finishedAt ? iso(job.finishedAt) : null,
					errorMessage: job?.error ?? null,
					service,
					server: serverBadge(server),
					buildServer: serverBadge(buildServer),
				};
			}),
		);
		return { ...result, page: rows.filter((row) => row !== null) };
	},
});

// Queued and running jobs of the organization (the deployment queue).
// Read by status so a long-waiting job is never pushed out by newer ones.
export const queue = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"deployment",
			"read",
		);
		const look = lookups(ctx);
		const byStatus = (status: "queued" | "running") =>
			ctx.db
				.query("jobs")
				.withIndex("by_status", (q) => q.eq("status", status))
				.order("desc")
				.take(QUEUE_JOBS);
		const active = [
			...(await byStatus("running")),
			...(await byStatus("queued")),
		]
			.filter((job) => job.organizationId === organizationId)
			.sort((a, b) => b._creationTime - a._creationTime);
		const rows = await Promise.all(
			active.map(async (job) => {
				const deployment = await ctx.db
					.query("deployments")
					.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
					.first();
				if (!(await canSeeTarget(ctx, access, deployment?.target))) {
					return null;
				}
				return {
					jobId: job._id as string,
					kind: job.spec.kind,
					state: job.status === "queued" ? "waiting" : "active",
					title: deployment?.title ?? null,
					createdAt: job._creationTime,
					startedAt: job.startedAt ?? null,
					finishedAt: job.finishedAt ?? null,
					error: job.error ?? null,
					service: deployment
						? await serviceOfTarget(look, deployment.target)
						: null,
				};
			}),
		);
		return rows.filter((row) => row !== null);
	},
});
