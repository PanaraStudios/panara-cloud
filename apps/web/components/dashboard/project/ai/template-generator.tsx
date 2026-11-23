"use client";

interface EnvVariable {
	name: string;
	value: string;
}

interface Domain {
	host: string;
	port: number;
	serviceName: string;
}

interface Details {
	name: string;
	id: string;
	description: string;
	dockerCompose: string;
	envVariables: EnvVariable[];
	shortDescription: string;
	domains: Domain[];
	configFiles?: Mount[] | null;
}

interface Mount {
	filePath: string;
	content: string;
}

export interface TemplateInfo {
	userInput: string;
	details?: Details | null;
	suggestions?: Details[];
	server?: {
		serverId: string;
		name: string;
	};
	aiId: string;
}
