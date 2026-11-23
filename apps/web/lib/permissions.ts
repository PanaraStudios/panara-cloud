"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { useOrganization } from "@/lib/organization";

// The permission statements behind the screens'
// `permissions?.project.create`-style checks. Mirrors
// packages/backend/convex/lib/permissions.ts, which enforces them.
const statements = {
	organization: ["update", "delete"],
	member: ["read", "create", "update", "delete"],
	invitation: ["create", "cancel"],
	project: ["create", "delete"],
	service: ["create", "read", "delete"],
	environment: ["create", "read", "delete"],
	docker: ["read"],
	sshKeys: ["read", "create", "delete"],
	gitProviders: ["read", "create", "delete"],
	traefikFiles: ["read", "write"],
	api: ["read"],
	telemetryProvider: ["read", "create", "delete"],
	sandbox: ["read", "create", "delete"],
	volume: ["read", "create", "delete"],
	deployment: ["read", "create", "cancel"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	server: ["read", "create", "delete", "terminal"],
	registry: ["read", "create", "delete"],
	certificate: ["read", "create", "update", "delete"],
	backup: ["read", "create", "update", "delete", "restore"],
	volumeBackup: ["read", "create", "update", "delete", "restore"],
	schedule: ["read", "create", "update", "delete"],
	domain: ["read", "create", "delete"],
	destination: ["read", "create", "delete"],
	notification: ["read", "create", "update", "delete"],
	tag: ["read", "create", "update", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	vaultProvider: ["read", "create", "update", "delete"],
	dnsProvider: ["read", "create", "update", "delete"],
	ai: ["read", "create", "update", "delete"],
} as const;

type Statements = typeof statements;
export type Permissions = {
	[R in keyof Statements]: Record<Statements[R][number], boolean>;
};

// What the default member role may do.
const memberGrants: Partial<Record<keyof Statements, readonly string[]>> = {
	service: ["read"],
	environment: ["read"],
	volume: ["read", "create", "delete"],
	deployment: ["read", "create", "cancel"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	backup: ["read", "create", "update", "delete", "restore"],
	volumeBackup: ["read", "create", "update", "delete", "restore"],
	schedule: ["read", "create", "update", "delete"],
	domain: ["read", "create", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	tag: ["read"],
	vaultProvider: ["read"],
};

export function permissionsFor(role: string): Permissions {
	const privileged = role === "owner" || role === "admin";
	const result = {} as Record<string, Record<string, boolean>>;
	for (const [resource, actions] of Object.entries(statements)) {
		const granted = memberGrants[resource as keyof Statements] ?? [];
		result[resource] = Object.fromEntries(
			actions.map((action) => [action, privileged || granted.includes(action)]),
		);
	}
	result.organization.delete = role === "owner";
	return result as Permissions;
}

// The backend's answer (role plus the member's grants); the role's
// defaults stand in while it loads.
export function usePermissions(): Permissions {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const resolved = useQuery(
		api.account.permissions,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	return (
		(resolved?.permissions as Permissions | undefined) ??
		permissionsFor(active.role)
	);
}
