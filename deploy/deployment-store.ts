import type { Database } from 'bun:sqlite';
import type { DeploymentJob } from '../src/lib/deployments.ts';

export const deploymentActions = new Set(['check_updates', 'deploy', 'rollback', 'review_config', 'accept_config', 'initialize_baseline', 'restore_baseline', 'review_source', 'publish_source', 'discard_source']);
export function initializeDeployments(db: Database) {
	db.exec(`CREATE TABLE IF NOT EXISTS deployment_jobs (
	 id TEXT PRIMARY KEY, actor TEXT NOT NULL, application TEXT NOT NULL, action TEXT NOT NULL,
	 request TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER,
	 finished INTEGER, result TEXT, detail TEXT, log TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE IF NOT EXISTS deployment_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS panel_releases (id TEXT PRIMARY KEY, commit_sha TEXT, path TEXT NOT NULL, created INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, successful INTEGER NOT NULL DEFAULT 0);
	CREATE TABLE IF NOT EXISTS deployment_reviews (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);`);
}
export class DeploymentError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
export function state<T>(db: Database, key: string): T | null {
	const row = db.query('SELECT value FROM deployment_state WHERE key=?').get(key) as { value: string } | null;
	return row ? JSON.parse(row.value) : null;
}
export function saveState(db: Database, key: string, value: unknown) {
	db.query('INSERT OR REPLACE INTO deployment_state VALUES (?,?,?)').run(key, JSON.stringify(value), Math.floor(Date.now() / 1000));
}
export function job(db: Database, id: string): DeploymentJob | null {
	const row = db.query('SELECT id,actor,application,action,request,status,created,started,finished,result,detail FROM deployment_jobs WHERE id=?').get(id) as any;
	return row ? { ...row, request: JSON.parse(row.request), detail: row.detail ? JSON.parse(row.detail) : null } : null;
}
export function jobs(db: Database) {
	return (db.query('SELECT id FROM deployment_jobs ORDER BY created DESC,rowid DESC LIMIT 50').all() as { id: string }[]).map(({ id }) => job(db, id)!);
}
export function enqueueDeployment(db: Database, body: Record<string, unknown>) {
	const { id, actor, application, action } = body;
	if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new DeploymentError(400, 'Invalid operation ID');
	if (typeof actor !== 'string' || !/^\d{17,20}$/.test(actor)) throw new DeploymentError(400, 'Invalid operator identity');
	if (application !== 'panel' && application !== 'mediawiki') throw new DeploymentError(400, 'Unsupported application');
	if (typeof action !== 'string' || !deploymentActions.has(action)) throw new DeploymentError(400, 'Unsupported deployment action');
	if (application === 'panel' && !['check_updates', 'deploy', 'rollback'].includes(action)) throw new DeploymentError(400, 'Unsupported panel action');
	const request: Record<string, unknown> = { application, action };
	for (const key of ['commit', 'release', 'review', 'message', 'backup']) {
		if (body[key] !== undefined) {
			if (typeof body[key] !== 'string' || body[key].length > 2000) throw new DeploymentError(400, 'Invalid request field');
			request[key] = body[key];
		}
	}
	if (body.files !== undefined) {
		if (!Array.isArray(body.files) || body.files.length > 500 || body.files.some((value) => typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value))) throw new DeploymentError(400, 'Invalid file selection');
		request.files = body.files;
	}
	return db.transaction(() => {
		const existing = job(db, id);
		if (existing) {
			if (existing.actor !== actor || JSON.stringify(existing.request) !== JSON.stringify(request)) throw new DeploymentError(409, 'Operation ID already belongs to another request');
			return existing;
		}
		if (state(db, 'deployment:maintenance')) throw new DeploymentError(503, 'Deployment services are being installed');
		const count = db.query("SELECT COUNT(*) AS n FROM deployment_jobs WHERE status IN ('queued','running')").get() as { n: number };
		if (count.n >= 10) throw new DeploymentError(429, 'Deployment queue is full');
		db.query('INSERT INTO deployment_jobs (id,actor,application,action,request,status,created) VALUES (?,?,?,?,?,?,?)').run(id, actor, application, action, JSON.stringify(request), 'queued', Math.floor(Date.now() / 1000));
		return job(db, id)!;
	})();
}
