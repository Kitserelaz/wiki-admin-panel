export type Metrics = {
	cpuPercent: number | null;
	memoryUsedPercent: number | null;
	diskUsedPercent: number | null;
	diskReadBps: number | null;
	diskWriteBps: number | null;
};
export type HostSample = Metrics & {
	collectedAt: number;
	errors: string[];
	load: number[] | null;
	memoryTotalBytes: number | null;
	memoryUsedBytes: number | null;
	memoryAvailableBytes: number | null;
	swapTotalBytes: number | null;
	swapUsedBytes: number | null;
	diskTotalBytes: number | null;
	diskUsedBytes: number | null;
	diskAvailableBytes: number | null;
	uptimeSeconds: number | null;
	rebootRequired: boolean | null;
};
export type Service = {
	target: string;
	name: string;
	kind: 'host' | 'container';
	state: string;
	detail?: string;
	health: string | null;
	uptimeSeconds: number | null;
	restarts: number | null;
	cpuPercent: number | null;
	memoryBytes: number | null;
	restartable: boolean;
};
export type ServiceSnapshot = { collectedAt: number; items: Service[]; errors: string[] };
export type Snapshot = { host: HostSample | null; services: ServiceSnapshot | null };
export type HistoryPoint = Metrics & { timestamp: number };
export type History = { points: HistoryPoint[] };
export type Operation = {
	id: string;
	actor: string;
	target: string;
	status: 'queued' | 'running' | 'succeeded' | 'failed';
	created: number;
	started: number | null;
	finished: number | null;
	result: string | null;
};
