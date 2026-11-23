// The subset of Traefik's dynamic file configuration Panara Cloud writes.
export type HttpRouter = {
	rule: string;
	service: string;
	entryPoints: string[];
	middlewares?: string[];
	priority?: number;
	tls?: { certResolver?: string };
};

export type HttpService = {
	loadBalancer: {
		servers: { url: string }[];
		passHostHeader?: boolean;
	};
};

export type HttpMiddleware =
	| { redirectScheme: { scheme: string; permanent?: boolean } }
	| {
			redirectRegex: {
				regex: string;
				replacement: string;
				permanent?: boolean;
			};
	  }
	| { basicAuth: { users: string[]; removeHeader?: boolean } }
	| { stripPrefix: { prefixes: string[] } }
	| { addPrefix: { prefix: string } }
	| Record<string, unknown>;

export type FileConfig = {
	http?: {
		routers?: Record<string, HttpRouter>;
		services?: Record<string, HttpService>;
		middlewares?: Record<string, HttpMiddleware>;
	};
	tls?: {
		certificates?: { certFile: string; keyFile: string }[];
	};
	[key: string]: unknown;
};

export type MainTraefikConfig = {
	global?: { sendAnonymousUsage?: boolean };
	providers?: Record<string, unknown>;
	entryPoints?: Record<string, unknown>;
	api?: { insecure?: boolean; dashboard?: boolean };
	accessLog?: { filePath?: string; format?: string; bufferingSize?: number };
	certificatesResolvers?: Record<
		string,
		{ acme?: { email?: string; storage?: string; [key: string]: unknown } }
	>;
	[key: string]: unknown;
};

export type CertificateType = "letsencrypt" | "none" | "custom";
