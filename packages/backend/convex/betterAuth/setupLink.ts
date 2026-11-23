// On the server; the piped form works whether or not an install.sh file is
// there (the panel can't know how the installer was run).
const SETUP_LINK_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s setup-link";

export const SETUP_LINK_REQUIRED = `Creating the first account needs the setup link. For a new one, run this on the server: ${SETUP_LINK_COMMAND}`;
export const SETUP_LINK_INVALID = `This setup link is invalid, expired or already used. For a new one, run this on the server: ${SETUP_LINK_COMMAND}`;
