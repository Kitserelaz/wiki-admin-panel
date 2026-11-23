export type Application = 'panel' | 'mediawiki';
export type DeploymentAction = 'check_updates' | 'deploy' | 'rollback' | 'review_config' | 'accept_config' | 'initialize_baseline' | 'restore_baseline' | 'review_source' | 'publish_source' | 'discard_source';
export type DeploymentRequest = { application: Application; action: DeploymentAction; commit?: string; release?: string; review?: string; files?: string[]; message?: string; backup?: string };
export type ReviewedFile = { id: string; path: string; status: string; before?: string | null; after?: string | null; actionable?: boolean; note?: string; diff?: string };
export type Review = { id: string; kind: 'config' | 'source'; created: number; head?: string; baselineStatus?: string; baselineBackups?: string[]; files: ReviewedFile[] };
export type DeploymentJob = { id: string; actor: string; application: Application; action: DeploymentAction; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'; created: number; started: number | null; finished: number | null; result: string | null; request: DeploymentRequest; detail: { review?: string; files?: string[]; commit?: string; requiresReconcile?: boolean; workflowUrl?: string; message?: string; [key: string]: unknown } | null };
export type Release = { id: string; commit: string | null; created: number; active?: boolean; legacy?: boolean; rollbackEligible?: boolean; reason?: string | null };
export type Update = { commit: string; message: string; checkedAt: number; ciReady?: boolean; runId?: number; artifact?: string; error?: string };
export type DeploymentSummary = {
	collectedAt: number;
	githubConfigured: boolean;
	panel: { commit: string | null; releases: Release[]; error?: string };
	mediawiki: { runtime?: 'docker' | 'native'; sourceCommit?: string; sourceEdits?: number; lastSuccess?: string | null; dashboardCommit?: string | null; images?: Record<string, string>; configuration?: { status: string; files: ReviewedFile[]; message?: string }; releases?: Release[]; error?: string; progress?: { status: string; stage: string; commit: string; reason?: string } };
	updates: Partial<Record<Application, Update>>;
	jobs: DeploymentJob[];
	workerActive: boolean;
	maintenance?: boolean;
};
