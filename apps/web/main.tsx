import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GlobalError from "@/app/global-error";
import { isRouterSignal, RouterView, startRouter } from "@/lib/router";
import { GlobalErrorBoundary } from "@/lib/router/global-error";

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element");

startRouter();
createRoot(container, {
	// A redirect() or notFound() is how a page asks for another route; the
	// router's boundaries handle it, so it is not an error worth logging.
	onCaughtError: (error, info) => {
		if (isRouterSignal(error)) return;
		console.error(error, info.componentStack);
	},
}).render(
	<StrictMode>
		<GlobalErrorBoundary fallback={GlobalError}>
			<RouterView />
		</GlobalErrorBoundary>
	</StrictMode>,
);
