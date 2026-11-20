import type { HandlerMap } from "../index";
import { backupRun, restore, volumeBackupRun, volumeRestore } from "./backups";
import { listBackupFiles, testDestination } from "./ops";
import { panelBackupRun, panelRestore } from "./panel";
import { changePassword } from "./password";
import { deploy, rebuild, reload, remove, start, stop } from "./service";
import { transfer } from "./transfer";

export const databasesHandlers = {
	"databases.deploy": deploy,
	"databases.start": start,
	"databases.stop": stop,
	"databases.reload": reload,
	"databases.rebuild": rebuild,
	"databases.remove": remove,
	"databases.backupRun": backupRun,
	"databases.restore": restore,
	"databases.volumeBackupRun": volumeBackupRun,
	"databases.volumeRestore": volumeRestore,
	"databases.testDestination": testDestination,
	"databases.listBackupFiles": listBackupFiles,
	"databases.transfer": transfer,
	"databases.changePassword": changePassword,
	"databases.panelBackupRun": panelBackupRun,
	"databases.panelRestore": panelRestore,
} satisfies Partial<HandlerMap>;
