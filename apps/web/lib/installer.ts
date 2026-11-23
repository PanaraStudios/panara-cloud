const INSTALLER_URL =
	"https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh";

// A command of the installer, to run on the server. The panel can't know
// whether the installer was run from a downloaded file or piped from curl,
// and there may be no install.sh on the server at all, so it gives the piped
// form, which works either way.
export const installerCommand = (command: string) =>
	`curl -fsSL ${INSTALLER_URL} | sudo sh -s ${command}`;
