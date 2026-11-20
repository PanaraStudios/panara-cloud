import type { HandlerMap } from "../index";
import { deployApplication } from "./deploy";
import {
	removeApplication,
	startApplication,
	stopApplication,
} from "./lifecycle";
import { patchRepo } from "./patchRepo";
import { rollbackApplication } from "./rollback";
import { rollbackImagesRemove } from "./rollbackImages";
import { transferApplication } from "./transfer";

// Job handlers for the "applications" domain, keyed by job spec kind.
export const applicationsHandlers = {
	"application.deploy": deployApplication,
	"application.redeploy": deployApplication,
	"application.reload": deployApplication,
	"application.previewDeploy": deployApplication,
	"application.start": startApplication,
	"application.stop": stopApplication,
	"application.remove": removeApplication,
	"application.previewRemove": removeApplication,
	"application.rollback": rollbackApplication,
	"application.patchRepo": patchRepo,
	"application.transfer": transferApplication,
	"application.rollbackImagesRemove": rollbackImagesRemove,
} satisfies Partial<HandlerMap>;
