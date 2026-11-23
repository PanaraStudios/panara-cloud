import type { HandlerMap } from "../index";
import { probeAddresses } from "./addresses";
import { dockerAction, dockerCleanup } from "./docker";
import { gpuSetup } from "./gpu";
import { inspect } from "./host";
import { readMountFile } from "./mounts";
import { defaultSetupScript, panelAction, publicIp } from "./panel";
import {
	certificateRemove,
	certificateSync,
	routingRemove,
	routingSync,
	traefikFiles,
} from "./routing";
import { serverSecurity } from "./security";
import { serverSetup, traefikApply, webServerApply } from "./setup";

export const infraHandlers = {
	"infra.serverSetup": serverSetup,
	"infra.inspect": inspect,
	"infra.dockerAction": dockerAction,
	"infra.dockerCleanup": dockerCleanup,
	"infra.routingSync": routingSync,
	"infra.routingRemove": routingRemove,
	"infra.readMountFile": readMountFile,
	"infra.probeAddresses": probeAddresses,
	"infra.certificateSync": certificateSync,
	"infra.certificateRemove": certificateRemove,
	"infra.traefikApply": traefikApply,
	"infra.traefikFiles": traefikFiles,
	"infra.webServerApply": webServerApply,
	"infra.serverSecurity": serverSecurity,
	"infra.gpuSetup": gpuSetup,
	"infra.panelAction": panelAction,
	"infra.publicIp": publicIp,
	"infra.setupScript": defaultSetupScript,
} satisfies Partial<HandlerMap>;
