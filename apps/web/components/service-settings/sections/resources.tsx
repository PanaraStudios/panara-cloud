"use client";

import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type ServiceType,
	useServiceSettings,
} from "@/components/dashboard/application/advanced/use-service-settings";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import { MoreMenu, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { SettingsBlock, SettingsStack } from "../chrome";
import { DRAFT_ROW } from "./kit";
import type { SectionProps } from "./registry";

const MB = 1024 * 1024;
const NANO = 1_000_000_000;

const ULIMITS: Record<string, string> = {
	nofile: "open files",
	nproc: "processes",
	memlock: "locked memory",
	stack: "stack size",
	core: "core file size",
	cpu: "CPU time",
	data: "data segment",
	fsize: "file size",
	locks: "file locks",
	msgqueue: "message queues",
	nice: "nice priority",
	rtprio: "real-time priority",
	sigpending: "pending signals",
};

const MEMORY_QUICK = [
	{ label: "256 MB", mb: 256 },
	{ label: "512 MB", mb: 512 },
	{ label: "1 GB", mb: 1024 },
	{ label: "2 GB", mb: 2048 },
	{ label: "No limit", mb: 0 },
];

type Ulimit = { Name: string; Soft: number; Hard: number };
type Values = {
	memoryLimit: string;
	memoryReservation: string;
	cpuLimit: string;
	cpuReservation: string;
	ulimits: Ulimit[];
};

const fromBytes = (value?: string | null) =>
	value && Number(value) > 0 ? String(Math.round(Number(value) / MB)) : "";
const fromNano = (value?: string | null) =>
	value && Number(value) > 0 ? String(Number(value) / NANO) : "";
const toBytes = (value: string) =>
	Number(value) > 0 ? String(Math.round(Number(value) * MB)) : null;
const toNano = (value: string) =>
	Number(value) > 0 ? String(Math.round(Number(value) * NANO)) : null;

function UnitInput({
	id,
	label,
	unit,
	value,
	onChange,
	placeholder = "none",
}: {
	id: string;
	label: string;
	unit: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const invalid = value !== "" && !(Number(value) > 0);
	return (
		<div className="flex flex-col gap-3">
			<Label htmlFor={id}>{label}</Label>
			<div className="relative">
				<Input
					id={id}
					inputMode="decimal"
					value={value}
					placeholder={placeholder}
					aria-invalid={invalid}
					onChange={(event) => onChange(event.target.value.trim())}
					className="pr-16 font-mono text-[13px]"
				/>
				<span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground text-sm">
					{unit}
				</span>
			</div>
		</div>
	);
}

export function ResourcesSection({ id, kind }: SectionProps) {
	const { service } = useService();
	const { data, update } = useServiceSettings(id, kind as ServiceType);
	const saved = useMemo<Values | null>(
		() =>
			data
				? {
						memoryLimit: fromBytes(data.memoryLimit),
						memoryReservation: fromBytes(data.memoryReservation),
						cpuLimit: fromNano(data.cpuLimit),
						cpuReservation: fromNano(data.cpuReservation),
						ulimits: (data.ulimitsSwarm ?? []) as Ulimit[],
					}
				: null,
		[data],
	);
	const [values, setValues] = useState<Values | null>(saved);
	const [adding, setAdding] = useState<Ulimit | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setValues(saved);
	}, [saved]);

	if (!values || !saved) return null;

	const dirty =
		JSON.stringify(values) !== JSON.stringify(saved) || adding !== null;
	const valid = [
		values.memoryLimit,
		values.memoryReservation,
		values.cpuLimit,
		values.cpuReservation,
	].every((value) => value === "" || Number(value) > 0);
	const set = (patch: Partial<Values>) => setValues({ ...values, ...patch });

	const save = async () => {
		let ulimits = values.ulimits;
		if (adding?.Name) ulimits = [...ulimits, adding];
		setSaving(true);
		try {
			await update({
				memoryLimit: toBytes(values.memoryLimit),
				memoryReservation: toBytes(values.memoryReservation),
				cpuLimit: toNano(values.cpuLimit),
				cpuReservation: toNano(values.cpuReservation),
				ulimitsSwarm: ulimits.length > 0 ? ulimits : null,
			});
			setAdding(null);
			toast.success("Resources saved");
		} catch (cause) {
			toast.error(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-8">
			<SettingsStack>
				<SettingsBlock
					title="Memory"
					description={`The limit caps what ${service.name} can use; the reservation guarantees it a share of ${service.serverName ?? "the server"}.`}
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<UnitInput
							id="memory-limit"
							label="Limit"
							unit="MB"
							value={values.memoryLimit}
							onChange={(memoryLimit) => set({ memoryLimit })}
							placeholder="no limit"
						/>
						<UnitInput
							id="memory-reservation"
							label="Reservation"
							unit="MB"
							value={values.memoryReservation}
							onChange={(memoryReservation) => set({ memoryReservation })}
						/>
					</div>
					<div className="-mt-1 flex flex-wrap items-center gap-1 text-muted-foreground text-sm">
						<span className="mr-1">Limit presets</span>
						{MEMORY_QUICK.map((option) => {
							const active =
								option.mb === 0
									? values.memoryLimit === ""
									: values.memoryLimit === String(option.mb);
							return (
								<Button
									key={option.label}
									type="button"
									variant={active ? "outline" : "ghost"}
									size="xs"
									autoIcon={false}
									aria-pressed={active}
									onClick={() =>
										set({ memoryLimit: option.mb ? String(option.mb) : "" })
									}
								>
									{option.label}
								</Button>
							);
						})}
					</div>
				</SettingsBlock>

				<SettingsBlock title="CPU" description="In vCPUs; 0.5 is half a core.">
					<div className="grid gap-4 sm:grid-cols-2">
						<UnitInput
							id="cpu-limit"
							label="Limit"
							unit="vCPU"
							value={values.cpuLimit}
							onChange={(cpuLimit) => set({ cpuLimit })}
							placeholder="no limit"
						/>
						<UnitInput
							id="cpu-reservation"
							label="Reservation"
							unit="vCPU"
							value={values.cpuReservation}
							onChange={(cpuReservation) => set({ cpuReservation })}
						/>
					</div>
				</SettingsBlock>

				<SettingsBlock
					title="Ulimits"
					description="Per-process limits inside the container."
					actions={
						<Button
							variant="outline"
							size="sm"
							disabled={adding !== null}
							onClick={() => setAdding({ Name: "", Soft: 65536, Hard: 65536 })}
						>
							<PlusIcon data-icon="inline-start" />
							Add ulimit
						</Button>
					}
				>
					{values.ulimits.length > 0 || adding ? (
						<ResourceTable
							headers={
								<>
									<Th>Type</Th>
									<Th className="w-36">Soft</Th>
									<Th className="w-36">Hard</Th>
									<Th className="w-12" />
								</>
							}
						>
							{values.ulimits.map((ulimit, index) => (
								<TableRow key={`${ulimit.Name}-${index}`}>
									<TableCell>
										<span className="font-mono text-[13px]">{ulimit.Name}</span>
										{ULIMITS[ulimit.Name] ? (
											<span className="text-muted-foreground text-sm">
												{" "}
												· {ULIMITS[ulimit.Name]}
											</span>
										) : null}
									</TableCell>
									<TableCell className="py-1.5">
										<Input
											aria-label={`${ulimit.Name} soft limit`}
											inputMode="numeric"
											value={String(ulimit.Soft)}
											onChange={(event) =>
												set({
													ulimits: values.ulimits.map((item, i) =>
														i === index
															? {
																	...item,
																	Soft: Number(event.target.value) || 0,
																}
															: item,
													),
												})
											}
											className="h-8! border-transparent bg-transparent font-mono text-[13px] shadow-none hover:border-input"
										/>
									</TableCell>
									<TableCell className="py-1.5">
										<Input
											aria-label={`${ulimit.Name} hard limit`}
											inputMode="numeric"
											value={String(ulimit.Hard)}
											onChange={(event) =>
												set({
													ulimits: values.ulimits.map((item, i) =>
														i === index
															? {
																	...item,
																	Hard: Number(event.target.value) || 0,
																}
															: item,
													),
												})
											}
											className="h-8! border-transparent bg-transparent font-mono text-[13px] shadow-none hover:border-input"
										/>
									</TableCell>
									<TableCell className="text-right">
										<MoreMenu>
											<DropdownMenuItem
												variant="destructive"
												onClick={() =>
													set({
														ulimits: values.ulimits.filter(
															(_, i) => i !== index,
														),
													})
												}
											>
												<Trash2Icon className="text-muted-foreground" />
												Remove
											</DropdownMenuItem>
										</MoreMenu>
									</TableCell>
								</TableRow>
							))}
							{adding ? (
								<TableRow className={DRAFT_ROW}>
									<TableCell className="py-2">
										<Select
											value={adding.Name}
											onValueChange={(Name) =>
												setAdding({ ...adding, Name: Name as string })
											}
										>
											<SelectTrigger
												aria-label="Ulimit type"
												size="sm"
												className="w-56"
											>
												<SelectValue placeholder="Choose a limit" />
											</SelectTrigger>
											<SelectContent>
												{Object.entries(ULIMITS)
													.filter(
														([name]) =>
															!values.ulimits.some(
																(item) => item.Name === name,
															),
													)
													.map(([name, label]) => (
														<SelectItem key={name} value={name}>
															<span className="font-mono">{name}</span>
															<span className="text-muted-foreground">
																{label}
															</span>
														</SelectItem>
													))}
											</SelectContent>
										</Select>
									</TableCell>
									<TableCell className="py-2">
										<Input
											aria-label="Soft limit"
											inputMode="numeric"
											value={String(adding.Soft)}
											onChange={(event) =>
												setAdding({
													...adding,
													Soft: Number(event.target.value) || 0,
												})
											}
											className="h-8! font-mono text-[13px]"
										/>
									</TableCell>
									<TableCell className="py-2">
										<Input
											aria-label="Hard limit"
											inputMode="numeric"
											value={String(adding.Hard)}
											onChange={(event) =>
												setAdding({
													...adding,
													Hard: Number(event.target.value) || 0,
												})
											}
											className="h-8! font-mono text-[13px]"
										/>
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Cancel"
											onClick={() => setAdding(null)}
										>
											<XIcon />
										</Button>
									</TableCell>
								</TableRow>
							) : null}
						</ResourceTable>
					) : (
						<p className="text-muted-foreground text-sm">
							None set. Docker's defaults apply.
						</p>
					)}
				</SettingsBlock>
			</SettingsStack>

			<div className="flex items-center justify-between gap-4 border-border border-t pt-4">
				<p className="text-muted-foreground text-sm">
					Saved changes apply with a reload, no rebuild.
				</p>
				<div className="flex shrink-0 items-center gap-2">
					{dirty ? (
						<Button
							variant="ghost"
							onClick={() => {
								setValues(saved);
								setAdding(null);
							}}
						>
							Discard
						</Button>
					) : null}
					<Button
						disabled={!dirty || !valid}
						isLoading={saving}
						onClick={() => void save()}
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
