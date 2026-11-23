import { SettingsArea } from "@/components/settings/settings-area";
import { SettingsGuard } from "@/components/settings/settings-guard";

export default function SettingsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<SettingsGuard>
			<SettingsArea>{children}</SettingsArea>
		</SettingsGuard>
	);
}
