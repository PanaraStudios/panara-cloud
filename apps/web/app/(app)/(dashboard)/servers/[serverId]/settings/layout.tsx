import { ServerSettings } from "@/components/servers/server-settings";

// Server settings are one page; the pages under this layout only name the
// section it scrolls to.
export default function ServerSettingsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<>
			<ServerSettings />
			{children}
		</>
	);
}
