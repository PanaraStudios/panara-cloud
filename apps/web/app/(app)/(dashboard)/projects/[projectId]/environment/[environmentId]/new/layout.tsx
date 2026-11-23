import { NewServiceGate } from "@/components/project-pages/new-service/gate";

export default function Layout({ children }: { children: React.ReactNode }) {
	return <NewServiceGate>{children}</NewServiceGate>;
}
