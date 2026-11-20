import { describe, expect, test } from "vitest";
import { serviceContainerFilters, volumeMounts } from "./inspect";

describe("service volumes", () => {
	test("label filters follow the compose type", () => {
		expect(
			serviceContainerFilters({
				appName: "shop",
				composeType: "stack",
				serviceName: "db",
			}),
		).toEqual([
			"label=com.docker.stack.namespace=shop",
			"label=com.docker.swarm.service.name=shop_db",
		]);
		expect(
			serviceContainerFilters({
				appName: "shop",
				composeType: "docker-compose",
				serviceName: "db",
			}),
		).toEqual([
			"label=com.docker.compose.project=shop",
			"label=com.docker.compose.service=db",
		]);
	});

	test("only named volumes are reported", () => {
		expect(
			volumeMounts([
				{
					Type: "volume",
					Source: "/var/lib/docker/volumes/a/_data",
					Destination: "/a",
				},
				{ Type: "bind", Source: "/etc/x", Destination: "/x" },
				{ Type: "volume", Source: "", Destination: "/tmp" },
			]),
		).toEqual([
			{
				Type: "volume",
				Source: "/var/lib/docker/volumes/a/_data",
				Destination: "/a",
			},
		]);
	});
});
