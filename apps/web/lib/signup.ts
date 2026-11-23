// What a sign-up sends besides name, email and password. The setup token goes
// out whenever the link carried one: whether the instance still needs it is
// the backend's decision, and this page may not have learned that yet.
export const signUpProof = (proof: {
	setupToken?: string;
	invitationId?: string;
}): { setupToken?: string; invitationId?: string } => ({
	...(proof.invitationId ? { invitationId: proof.invitationId } : {}),
	...(proof.setupToken ? { setupToken: proof.setupToken } : {}),
});

// How long the page waits for its first connection to the backend before it
// says the backend can't be reached: a healthy one answers in well under a
// second.
export const BACKEND_WAIT_MS = 6000;

export type BackendReach = "loading" | "ready" | "unreachable";

// The sign-up page reads whether the instance has its first account over the
// browser's own connection to Convex. Until that has answered it doesn't
// know which sign-up this is, and a browser that never connects (a closed
// port, most often) never will.
export const backendReach = (state: {
	loaded: boolean;
	hasEverConnected: boolean;
	waited: boolean;
}): BackendReach => {
	if (state.loaded) return "ready";
	return state.waited && !state.hasEverConnected ? "unreachable" : "loading";
};

export const signUpBlocker = (reach: BackendReach): string | null =>
	reach === "ready"
		? null
		: reach === "loading"
			? "Loading…"
			: "This page can't reach the panel's backend";

// Says where the browser tried to connect, and what usually closes it.
export const unreachableMessage = (
	convexUrl: string,
	pageOrigin: string,
): string => {
	let url: URL;
	try {
		url = new URL(convexUrl);
	} catch {
		return "This page can't reach the panel's backend, so it can't create your account yet. Check that the panel's services are running, then reload.";
	}
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const address = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
	if (url.origin === pageOrigin) {
		return `This page can't reach the panel's backend at ${address}, so it can't create your account yet. Check on the server that the Convex service is running (docker service ps panara-cloud-convex), then reload.`;
	}
	return `This page can't reach the panel's backend at ${address}, so it can't create your account yet. Your browser connects to it directly: check that port ${port} is open in the server's firewall and your provider's, along with the other ports the installer listed, then reload.`;
};
