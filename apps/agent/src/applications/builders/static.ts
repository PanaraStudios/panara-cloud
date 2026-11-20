import { dockerfileBuild } from "./dockerfile";
import { appDirectory, type BuildInput, createFileCommand } from "./utils";

const NGINX_SPA_CONFIG = `
worker_processes 1;

events {
  worker_connections 1024;
}

http {
  include mime.types;
  default_type  application/octet-stream;

  access_log /dev/stdout;
  error_log /dev/stderr;

  server {
    listen 80;
    location / {
      root   /usr/share/nginx/html;
      index  index.html index.htm;
      try_files $uri $uri/ /index.html;
    }
  }
}
`;

// Static build: serve the directory (or its publish
// directory) with nginx.
export const staticBuild = (input: BuildInput): string => {
	const directory = appDirectory(input);
	let script = "";
	if (input.isStaticSpa) {
		script += createFileCommand(directory, "nginx.conf", NGINX_SPA_CONFIG);
	}
	script += createFileCommand(
		directory,
		".dockerignore",
		[".git", ".env", "Dockerfile", ".dockerignore"].join("\n"),
	);
	script += createFileCommand(
		directory,
		"Dockerfile",
		[
			"FROM nginx:alpine",
			"WORKDIR /usr/share/nginx/html/",
			input.isStaticSpa ? "COPY nginx.conf /etc/nginx/nginx.conf" : "",
			`COPY ${input.publishDirectory || "."} .`,
			'CMD ["nginx", "-g", "daemon off;"]',
		].join("\n"),
	);
	script += dockerfileBuild({
		...input,
		buildType: "dockerfile",
		dockerfile: "Dockerfile",
		dockerContextPath: undefined,
		dockerBuildStage: undefined,
	});
	return script;
};
