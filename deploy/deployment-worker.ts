import { Database } from 'bun:sqlite';
import { createSign, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, chownSync, lstatSync, readdirSync, renameSync, symlinkSync, readlinkSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { initializeDeployments, state, saveState, job, jobs } from './deployment-store.ts';
import type { Application, DeploymentJob, DeploymentRequest, DeploymentSummary, Update, Release } from '../src/lib/deployments.ts';

const base = '/var/lib/cloudwiki-deployment';
const releases = '/opt/wiki-admin-panel-releases';
const active = '/opt/wiki-admin-panel-build';
const bun = '/opt/bun/bun-linux-x64/bun';
const repositories = { panel: 'Kitserelaz/wiki-admin-panel', mediawiki: 'Kitserelaz/mediawiki-www' };
const db = new Database('/var/lib/cloudwiki-admin-agent/metrics.sqlite', { create: false, strict: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
initializeDeployments(db);
process.umask(0o077);
const now = () => Math.floor(Date.now() / 1000);
const secrets = new Set<string>();
let stopping = false;
let cachedToken: { value: string; expires: number } | null = null;
for (const line of existsSync('/etc/wiki-admin-panel.env') ? readFileSync('/etc/wiki-admin-panel.env', 'utf8').split('\n') : []) {
	if (/^(DISCORD_)?CLIENT_SECRET=/.test(line)) secrets.add(line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, ''));
}
function redact(text: string) {
	for (const secret of secrets) if (secret.length > 5) text = text.split(secret).join('[redacted]');
	return text.replace(/(gh[psu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
		.replace(/(authorization\s*[:=]\s*|(?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z_]*)=)[^\r\n]+/gi, '$1[redacted]')
		.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
function log(id: string, text: string) {
	const row = db.query('SELECT log FROM deployment_jobs WHERE id=?').get(id) as { log: string } | null;
	if (!row) return;
	const value = (row.log + redact(text)).slice(-256 * 1024);
	db.query('UPDATE deployment_jobs SET log=? WHERE id=?').run(value, id);
}
function detail(id: string, fields: Record<string, unknown>) {
	const current = job(db, id)?.detail || {};
	db.query('UPDATE deployment_jobs SET detail=? WHERE id=?').run(JSON.stringify({ ...current, ...fields }), id);
}
function privateJson(path: string, value: unknown) {
	const temporary = `${path}.${randomUUID()}`;
	writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}
async function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; id?: string; label?: string } = {}) {
	if (options.id && options.label) log(options.id, `\n${options.label}\n`);
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), { cwd: options.cwd, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '', stderr = '', lines = '';
		let timedOut = false;
		const stream = (text: string) => {
			if (!options.id) return;
			lines += text;
			const end = lines.lastIndexOf('\n');
			if (end >= 0) { log(options.id, lines.slice(0, end + 1)); lines = lines.slice(end + 1); }
			if (lines.length > 65536) lines = '[Long output line truncated]\n';
		};
		child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024); stream(chunk.toString()); });
		child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-65536); stream(chunk.toString()); });
		const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout || 120000);
		child.on('error', () => { clearTimeout(timer); reject(new Error('Host command could not start')); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (lines && options.id) log(options.id, lines + '\n');
			if (code !== 0) reject(new Error(timedOut ? 'Host command timed out. Inspect current state before retrying.' : options.id ? 'Host command failed. See operation output.' : 'Host command failed'));
			else resolve(stdout);
		});
		child.stdin.end(options.input);
	});
}
function appConfiguration() {
	const path = '/etc/cloudwiki-deployment/github.json';
	if (!existsSync(path)) return null;
	const permission = statSync(path);
	if (permission.uid !== 0 || (permission.mode & 0o077)) throw new Error('GitHub configuration must be root-only');
	const config = JSON.parse(readFileSync(path, 'utf8'));
	if (!/^\d+$/.test(config.appId) || !/^\d+$/.test(config.installationId) || typeof config.privateKeyFile !== 'string' || !config.privateKeyFile.startsWith('/etc/cloudwiki-deployment/')) throw new Error('Invalid GitHub App configuration');
	const key = statSync(config.privateKeyFile);
	if (key.uid !== 0 || (key.mode & 0o077)) throw new Error('GitHub App key must be root-only');
	return config as { appId: string; installationId: string; privateKeyFile: string };
}
async function github(path: string, token?: string, method = 'GET', body?: object) {
	const response = await fetch(`https://api.github.com${path}`, {
		method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'CloudWiki-Admin', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000), redirect: 'error'
	});
	if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Check App repository access and permissions.`);
	return response.status === 204 ? null : await response.json();
}
async function installationToken() {
	if (cachedToken && cachedToken.expires > now() + 120) return cachedToken.value;
	const config = appConfiguration();
	if (!config) throw new Error('Configure the GitHub App before publishing or dispatching deployments');
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now() - 60, exp: now() + 480, iss: config.appId })}`;
	const signature = createSign('RSA-SHA256').update(payload).sign(readFileSync(config.privateKeyFile)).toString('base64url');
	const jwt = `${payload}.${signature}`;
	secrets.add(jwt);
	const result = await github(`/app/installations/${config.installationId}/access_tokens`, jwt, 'POST', { repositories: ['mediawiki-www'] });
	secrets.add(result.token);
	cachedToken = { value: result.token, expires: Math.floor(Date.parse(result.expires_at) / 1000) };
	return cachedToken.value;
}
async function farm(action: string, fields: object = {}, token?: string) {
	const output = await run(['/usr/bin/python3', '/usr/local/libexec/cloudwiki-farm-control.py'], {
		input: JSON.stringify({ action, ...fields }), env: token ? { ...process.env, CLOUDWIKI_GITHUB_TOKEN: token } : process.env, timeout: 180000
	});
	let response;
	try { response = JSON.parse(output); } catch { throw new Error('Farm control returned an invalid response'); }
	if (!response.ok) throw new Error(response.message || 'Farm operation failed');
	return response.result;
}
async function checkUpdates(application: Application): Promise<Update> {
	const token = application === 'mediawiki' && appConfiguration() ? await installationToken() : undefined;
	const repository = repositories[application];
	const commit = await github(`/repos/${repository}/commits/main`, token);
	const update: Update = { commit: commit.sha, message: commit.commit.message.split('\n')[0], checkedAt: now() };

	saveState(db, `update:${application}`, update);
	return update;
}
function panelSummary() {
	let metadata: { id: string; commit: string; created: number } | null = null;
	try { metadata = JSON.parse(readFileSync(`${active}/release.json`, 'utf8')); } catch {}
	const rows = db.query('SELECT * FROM panel_releases ORDER BY created DESC').all() as { id: string; commit_sha: string | null; path: string; created: number; legacy: number; successful: number }[];
	const result: Release[] = rows.map((row) => ({ id: row.id, commit: row.commit_sha, created: row.created, legacy: !!row.legacy,
		active: metadata?.id === row.id, rollbackEligible: !row.legacy && !!row.successful && existsSync(`${row.path}/release.json`) && metadata?.id !== row.id }));
	for (const name of readdirSync('/opt').filter((name) => name.startsWith('wiki-admin-panel-build-'))) {
		if (!result.some((row) => row.id === name)) result.push({ id: name, commit: null, legacy: true, created: Math.floor(statSync(`/opt/${name}`).mtimeMs / 1000), rollbackEligible: false });
	}
	return { commit: metadata?.commit || null, releases: result };
}
async function refreshSummary() {
	const old = state<DeploymentSummary>(db, 'deployment:summary');
	let mediawiki = old?.mediawiki || {};
	try { mediawiki = await farm('overview'); } catch { mediawiki = { ...mediawiki, error: 'MediaWiki deployment metadata is unavailable' }; }
	let configured = false;
	try { configured = !!appConfiguration(); } catch {}
	saveState(db, 'deployment:summary', { collectedAt: now(), githubConfigured: configured,
		panel: panelSummary(), mediawiki, updates: { panel: state(db, 'update:panel'), mediawiki: state(db, 'update:mediawiki') } });
	saveState(db, 'deployment:heartbeat', now());
}
function activateLink(path: string) {
	const temporary = `${active}.${randomUUID()}`;
	symlinkSync(path, temporary);
	renameSync(temporary, active);
}
async function activate(release: string, id: string) {
	const existingLink = lstatSync(active).isSymbolicLink();
	const previous = existingLink ? readlinkSync(active) : `${releases}/legacy-${Date.now()}`;
	const journal = `${base}/activation.json`;
	privateJson(journal, { previous, next: release, id, legacy: !existingLink });
	detail(id, { phase: 'activating', previousRelease: previous.split('/').at(-1) });
	try {
		await run(['systemctl', 'stop', 'wiki-admin-panel.service']);
		if (!existingLink) {
			renameSync(active, previous);
			db.query('INSERT OR IGNORE INTO panel_releases (id,commit_sha,path,created,legacy,successful) VALUES (?,?,?,?,1,0)').run(previous.split('/').at(-1)!, null, previous, now());
			symlinkSync(previous, active);
		}
		activateLink(release);
		await run(['systemctl', 'start', 'wiki-admin-panel.service']);
		await Bun.sleep(1500);
		await run(['systemctl', 'is-active', '--quiet', 'wiki-admin-panel.service']);
		unlinkSync(journal);
	} catch {
		await run(['systemctl', 'stop', 'wiki-admin-panel.service']);
		if (existsSync(previous)) activateLink(previous);
		await run(['systemctl', 'start', 'wiki-admin-panel.service']);
		unlinkSync(journal);
		throw new Error('Panel activation failed. The previous artifact was restored.');
	}
}
async function buildPanel(current: DeploymentJob, local = false) {
	const requested = current.request.commit;
	const commit = local ? (await run(['git', '-C', '/opt/wiki-admin-panel', 'rev-parse', 'HEAD'])).trim() : (await checkUpdates('panel')).commit;
	if (!/^[a-f0-9]{40}$/.test(commit) || (!local && requested && commit !== requested)) throw new Error('Latest main changed; check updates and review the new commit');
	const workspace = `/var/cache/wiki-admin-build/${current.id}`;
	mkdirSync(workspace, { mode: 0o700 });
	await run(['chown', 'wiki-admin-build:wiki-admin-build', workspace]);
	const clean = ['systemd-run', '--quiet', '--wait', '--collect', '--pipe', '-p', 'User=wiki-admin-build', '-p', 'MemoryMax=768M', '-p', 'CPUQuota=80%', '-p', 'NoNewPrivileges=yes', 'env', '-i', 'HOME=/var/cache/wiki-admin-build', 'PATH=/opt/bun/bun-linux-x64:/usr/bin:/bin', 'BUN_INSTALL_CACHE_DIR=/var/cache/wiki-admin-build/cache'];
	const source = `${workspace}/source`;
	const output = `${workspace}/build`;
	const buildConfig = `${workspace}/vite.config.mts`;
	writeFileSync(buildConfig, readFileSync('/opt/wiki-admin-panel-deployment/vite.config.mts'));
	chmodSync(buildConfig, 0o644);
	try {
		await run([...clean, 'git', '-c', 'safe.directory=/opt/wiki-admin-panel', '-c', 'safe.directory=/opt/wiki-admin-panel/.git', 'clone', '--no-hardlinks', '--depth', '1', '--branch', 'main', local ? '/opt/wiki-admin-panel' : 'https://github.com/Kitserelaz/wiki-admin-panel.git', source], { id: current.id, label: 'Preparing the exact panel source' });
		const cloned = (await run([...clean, 'git', '-C', source, 'rev-parse', 'HEAD'])).trim();
		if (cloned !== commit) throw new Error('Source changed before build; check updates again');
		await run([...clean, bun, 'install', '--frozen-lockfile'], { cwd: source, id: current.id, label: 'Installing build dependencies', timeout: 600000 });
		await run([...clean, `CLOUDWIKI_BUILD_SOURCE=${source}`, `CLOUDWIKI_BUILD_OUTPUT=${output}`, bun, '--bun', `${source}/node_modules/vite/bin/vite.js`, 'build', '--config', buildConfig, '--configLoader', 'native'], { cwd: source, id: current.id, label: 'Building the production panel', timeout: 600000 });
		const release = `${releases}/${current.id}`;
		await run(['cp', '-a', '--', output, release]);
		await run(['chown', '-hR', 'root:root', '--', release]);
		await run(['chmod', '-R', 'a+rX', '--', release]);
		privateJson(`${release}/release.json`, { id: current.id, commit, created: now() });
		chmodSync(`${release}/release.json`, 0o644);
		db.query('INSERT INTO panel_releases (id,commit_sha,path,created,legacy,successful) VALUES (?,?,?,?,0,0)').run(current.id, commit, release, now());
		await activate(release, current.id);
		db.query('UPDATE panel_releases SET successful=1 WHERE id=?').run(current.id);
		log(current.id, `Panel release activated at ${commit}\n`);
		return { message: 'Panel release activated. Sign in again to view its status.', commit };
	} finally { rmSync(workspace, { recursive: true, force: true }); }
}
async function rollbackPanel(current: DeploymentJob) {
	const row = db.query('SELECT * FROM panel_releases WHERE id=? AND legacy=0 AND successful=1').get(current.request.release || '') as { id: string; path: string; commit_sha: string } | null;
	if (!row || row.path !== `${releases}/${row.id}` || !existsSync(`${row.path}/release.json`)) throw new Error('Selected rollback build is unavailable');
	const metadata = JSON.parse(readFileSync(`${row.path}/release.json`, 'utf8'));
	if (metadata.id !== row.id || metadata.commit !== row.commit_sha) throw new Error('Rollback metadata does not match the retained release');
	await activate(row.path, current.id);
	return { message: 'Previous panel release activated. Sign in again.', commit: row.commit_sha };
}
async function githubOutput(runId: number, token: string, id: string) {
	const response = await fetch(`https://api.github.com/repos/${repositories.mediawiki}/actions/runs/${runId}/logs`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'CloudWiki-Admin', Accept: 'application/vnd.github+json' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
	if (response.status !== 302) { log(id, 'Workflow output is available through its GitHub link.\n'); return; }
	const location = response.headers.get('location');
	if (!location || new URL(location).protocol !== 'https:') return;
	const download = await fetch(location, { signal: AbortSignal.timeout(30000) });
	if (!download.ok || Number(download.headers.get('content-length') || '0') > 20 * 1024 * 1024) return;
	const reader = download.body?.getReader();
	if (!reader) return;
	const chunks: Uint8Array[] = []; let size = 0;
	while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); return; } chunks.push(chunk.value); }
	const path = `${base}/${id}.zip`;
	try {
		writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
		const listing = await run(['unzip', '-Z1', path]);
		for (const entry of listing.trim().split('\n').filter((name) => name.endsWith('.txt')).slice(-10)) {
			if (entry.includes('..') || entry.startsWith('/') || entry.includes('\0')) continue;
			try { const text = await run(['unzip', '-p', path, entry]); log(id, text.slice(-32768)); } catch {}
		}
	} finally { if (existsSync(path)) unlinkSync(path); }
}
async function farmWorkflow(current: DeploymentJob) {
	let token = await installationToken();
	const request = current.request;
	const existing = job(db, current.id)?.detail;
	if (!existing?.dispatchAttempted) {
		if (current.action === 'deploy') {
			const update = await checkUpdates('mediawiki');
			if (update.commit !== request.commit || !update.ciReady || !update.runId) throw new Error('Latest main needs a successful, unexpired CI release. Check updates again.');
			const overview = await farm('overview');
			if (overview.sourceEdits || overview.configuration.status !== 'clean') throw new Error('Resolve MediaWiki source and configuration blockers before deployment');
			detail(current.id, { runId: update.runId, commit: update.commit, artifact: update.artifact });
		} else {
			const overview = await farm('overview');
			const release = overview.releases.find((item: any) => item.id === request.release);
			if (!release?.rollbackEligible) throw new Error('Recorded release lacks compatibility approval for the current source revision');
			if (overview.sourceEdits || overview.configuration.status !== 'clean') throw new Error('Resolve MediaWiki source and configuration blockers before rollback');
			detail(current.id, { release: request.release, commit: release.commit, currentCommit: overview.sourceCommit });
		}
		detail(current.id, { dispatchAttempted: true, dispatchAt: now() });
		const fields = job(db, current.id)!.detail!;
		await github(`/repos/${repositories.mediawiki}/actions/workflows/deploy.yml/dispatches`, token, 'POST', { ref: 'main', inputs: {
			operation_id: current.id, action: current.action, run_id: String(fields.runId || ''), expected_commit: String(fields.commit || ''), release_id: request.release || '', current_commit: String(fields.currentCommit || '')
		} });
		log(current.id, 'Requested the existing production deployment workflow.\n');
	}
	const deadline = Date.now() + 65 * 60 * 1000;
	let workflowId = Number(existing?.workflowRunId || 0);
	while (!stopping && Date.now() < deadline) {
		token = await installationToken();
		let workflow;
		if (workflowId) workflow = await github(`/repos/${repositories.mediawiki}/actions/runs/${workflowId}`, token);
		else {
			const listed = await github(`/repos/${repositories.mediawiki}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&per_page=100`, token);
			workflow = listed.workflow_runs.find((candidate: any) => candidate.display_title?.includes(current.id));
			if (workflow) { workflowId = workflow.id; detail(current.id, { workflowRunId: workflowId, workflowUrl: workflow.html_url }); }
			else if (now() - Number(job(db, current.id)?.detail?.dispatchAt || now()) > 300) throw new Error('Workflow dispatch outcome is uncertain. Check GitHub before submitting another deployment.');
		}
		if (workflow) {
			detail(current.id, { phase: workflow.status, workflowUrl: workflow.html_url });
			if (workflow.status === 'completed') {
				try { await githubOutput(workflowId, token, current.id); } catch { log(current.id, 'Open the workflow link for complete output.\n'); }
				if (workflow.conclusion !== 'success') throw new Error(`Production workflow finished with ${workflow.conclusion}. Inspect its output and current farm state.`);
				const actual = await farm('overview');
				const selected = job(db, current.id)!.detail!;
				const deployed = selected.artifact === 'dashboard-manifest' ? actual.dashboardCommit : actual.sourceCommit;
				if (deployed !== selected.commit) {
					if (actual.progress?.status === 'superseded') return { message: 'Requested release was superseded. Current production state refreshed.', workflowUrl: workflow.html_url, skipped: true };
					throw new Error('Workflow ended successfully, but the confirmed revision is not active. Inspect current production state.');
				}
				return { message: selected.artifact === 'dashboard-manifest' ? 'Dashboard-only release completed successfully' : 'Production application release completed successfully', workflowUrl: workflow.html_url };
			}
		}
		try {
			const progress = JSON.parse(readFileSync('/var/lib/cloudwiki/deployment-progress.json', 'utf8'));
			const summary = state<any>(db, 'deployment:summary');
			if (summary && progress.started_at >= Number(job(db, current.id)?.detail?.dispatchAt || 0)) {
				saveState(db, 'deployment:summary', { ...summary, mediawiki: { ...summary.mediawiki, progress } });
			}
		} catch {}
		await Bun.sleep(10000);
	}
	throw new Error('Workflow is still pending or its outcome is uncertain. Inspect GitHub before retrying.');
}
async function executeJob(current: DeploymentJob, bootstrap = false) {
	const request = current.request;
	if (current.action === 'check_updates') return { message: 'Update information refreshed', ...await checkUpdates(current.application) };
	if (current.application === 'panel') {
		// flock remains outside the worker for the complete activation transaction.
		if (current.action === 'deploy') return await buildPanel(current, bootstrap);
		if (current.action === 'rollback') return await rollbackPanel(current);
	}
	if (current.action === 'deploy' && existsSync('/etc/cloudwiki/runtime.json')) {
        let commit = current.detail?.commit as string | undefined;
        if (!commit) { commit = (await checkUpdates('mediawiki')).commit; detail(current.id, { commit, runtime: 'native' }); }
        const token = await installationToken();
        const heartbeat = setInterval(() => {
            saveState(db, 'deployment:heartbeat', now());
            try {
                const progress = JSON.parse(readFileSync('/var/lib/cloudwiki/deployment-progress.json', 'utf8'));
                const summary = state<DeploymentSummary>(db, 'deployment:summary');
                if (summary) saveState(db, 'deployment:summary', { ...summary, mediawiki: { ...summary.mediawiki, progress } });
            } catch {}
        }, 5000);
        let output: string;
        try { output = await run(['python3', '/usr/local/libexec/cloudwiki-native.py'], {
            input: JSON.stringify({ action: 'deploy', commit }), env: { ...process.env, CLOUDWIKI_GITHUB_TOKEN: token },
            id: current.id, label: 'Preparing and activating native production', timeout: 90 * 60 * 1000
        }); } finally { clearInterval(heartbeat); }
        const response = JSON.parse(output.trim().split('\n').at(-1)!);
        if (!response.ok) throw new Error(response.message || 'Native deployment failed');
        return response.result;
    }
    if (current.action === 'deploy' || current.action === 'rollback') return await farmWorkflow(current);
	const token = current.action === 'publish_source' ? await installationToken() : undefined;
	const result = await farm(current.action, { ...request, actor: current.actor }, token);
	if (current.action === 'review_config' || current.action === 'review_source') {
		db.query('INSERT OR REPLACE INTO deployment_reviews VALUES (?,?,?)').run(result.id, JSON.stringify(result), now());
		return { message: 'Review is ready', review: result.id };
	}
	return result;
}
async function finishJob(current: DeploymentJob, bootstrap = false) {
	try {
		const result = await executeJob(current, bootstrap);
		detail(current.id, result);
		const status = result.requiresReconcile ? 'failed' : result.skipped ? 'skipped' : 'succeeded';
		db.query('UPDATE deployment_jobs SET status=?,finished=?,result=? WHERE id=?').run(status, now(), result.message || 'Operation completed', current.id);
	} catch (cause) {
		if (current.action === 'publish_source' && /^[a-f0-9-]{36}$/.test(current.request.review || '')) {
			const marker = `${base}/reviews/${current.request.review}/published.json`;
			if (existsSync(marker)) {
				const saved = JSON.parse(readFileSync(marker, 'utf8'));
				detail(current.id, { requiresReconcile: true, commit: saved.commit, review: current.request.review, files: current.request.files });
			}
		}
		const message = redact(cause instanceof Error ? cause.message : 'Deployment operation failed');
		log(current.id, message + '\n');
		db.query("UPDATE deployment_jobs SET status='failed',finished=?,result=? WHERE id=?").run(now(), message, current.id);
	}
	await refreshSummary();
}
async function recover() {
	const path = `${base}/activation.json`;
	if (existsSync(path)) {
		const journal = JSON.parse(readFileSync(path, 'utf8'));
		if (typeof journal.previous !== 'string' || !journal.previous.startsWith(releases + '/') || (!existsSync(journal.previous) && !existsSync(active))) throw new Error('Interrupted activation needs manual recovery');
		await run(['systemctl', 'stop', 'wiki-admin-panel.service']);
		if (existsSync(journal.previous)) activateLink(journal.previous);
		await run(['systemctl', 'start', 'wiki-admin-panel.service']);
		unlinkSync(path);
	}
	for (const current of db.query("SELECT id FROM deployment_jobs WHERE status='running'").all() as { id: string }[]) {
		const operation = job(db, current.id)!;
		if (operation.application === 'mediawiki' && ['deploy', 'rollback'].includes(operation.action) && operation.detail?.dispatchAttempted) {
			db.query("UPDATE deployment_jobs SET status='queued' WHERE id=?").run(current.id);
		} else {
			if (operation.action === 'publish_source' && /^[a-f0-9-]{36}$/.test(operation.request.review || '')) {
				const marker = `${base}/reviews/${operation.request.review}/published.json`;
				if (existsSync(marker)) { const saved = JSON.parse(readFileSync(marker, 'utf8')); detail(operation.id, { requiresReconcile: true, commit: saved.commit, review: operation.request.review, files: operation.request.files }); }
			}
			db.query("UPDATE deployment_jobs SET status='failed',finished=?,result='Worker stopped during execution. Inspect current state and review again before retrying.' WHERE id=?").run(now(), current.id);
		}
	}
}
function cleanup() {
	db.query("DELETE FROM deployment_jobs WHERE finished < ? AND status IN ('failed','succeeded','skipped')").run(now() - 30 * 86400);
	db.query('DELETE FROM deployment_reviews WHERE created < ?').run(now() - 30 * 86400);
	for (const folder of ['reviews', 'archives', 'baselines']) {
		const path = `${base}/${folder}`;
		if (!existsSync(path)) continue;
		for (const name of readdirSync(path)) if (/^[a-f0-9-]{36}$|^\d+\.json$/.test(name)) {
			const item = `${path}/${name}`;
			let created = statSync(item).mtimeMs / 1000;
			const manifest = `${item}/${folder === 'reviews' ? 'review.json' : 'manifest.json'}`;
			try { if (folder !== 'baselines') created = JSON.parse(readFileSync(manifest, 'utf8')).created || created; } catch {}
			if (created < now() - 30 * 86400) rmSync(item, { recursive: true, force: true });
		}
	}
	const protectedPaths = new Set<string>();
	if (existsSync(active) && lstatSync(active).isSymbolicLink()) protectedPaths.add(readlinkSync(active));
	for (const row of db.query('SELECT path FROM panel_releases WHERE legacy=0 AND successful=1 ORDER BY created DESC LIMIT 5').all() as { path: string }[]) protectedPaths.add(row.path);
	const latest = jobs(db).find((entry) => entry.application === 'panel' && entry.status === 'succeeded' && entry.detail?.previousRelease);
	if (latest) protectedPaths.add(`${releases}/${latest.detail!.previousRelease}`);
	for (const row of db.query('SELECT id,path,successful,created FROM panel_releases WHERE legacy=0').all() as { id: string; path: string; successful: number; created: number }[]) {
		if ((row.successful || row.created < now() - 30 * 86400) && !protectedPaths.has(row.path) && row.path === `${releases}/${row.id}`) { rmSync(row.path, { recursive: true, force: true }); db.query('DELETE FROM panel_releases WHERE id=?').run(row.id); }
	}
}
async function main() {
	if (process.getuid?.() !== 0) throw new Error('Deployment worker requires root');
	mkdirSync(releases, { recursive: true, mode: 0o755 });
	if (process.argv.includes('--begin-install')) {
		db.transaction(() => {
			const restarts = db.query("SELECT COUNT(*) AS n FROM operations WHERE status IN ('queued','running')").get() as { n: number };
			const deployments = db.query("SELECT COUNT(*) AS n FROM deployment_jobs WHERE status IN ('queued','running')").get() as { n: number };
			if (restarts.n || deployments.n) throw new Error('Wait for pending operations before installing deployment services');
			saveState(db, 'deployment:maintenance', true);
		})();
		return;
	}
	if (process.argv.includes('--finish-install')) { saveState(db, 'deployment:maintenance', false); return; }
	const runJob = process.argv.indexOf('--run-job');
	if (runJob >= 0) {
		const id = process.argv[runJob + 1];
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid operation ID');
		const selected = job(db, id);
		if (!selected || selected.status !== 'running' || selected.application !== 'panel') throw new Error('Panel job is unavailable');
		await finishJob(selected);
		return;
	}
	await recover();
	if (process.argv.includes('--deploy-current')) {
		const id = randomUUID();
		const request: DeploymentRequest = { application: 'panel', action: 'deploy' };
		db.query('INSERT INTO deployment_jobs (id,actor,application,action,request,status,created,started) VALUES (?,?,?,?,?,?,?,?)').run(id, 'system:installer', 'panel', 'deploy', JSON.stringify(request), 'running', now(), now());
		await finishJob(job(db, id)!, true);
		const result = job(db, id)!;
		console.info(result.result);
		if (result.status !== 'succeeded') process.exitCode = 1;
		return;
	}
	setInterval(() => saveState(db, 'deployment:heartbeat', now()), 10000).unref();
	await refreshSummary();
	let lastRefresh = Date.now();
	while (!stopping) {
		saveState(db, 'deployment:heartbeat', now());
		const next = db.transaction(() => {
			if (state(db, 'deployment:maintenance')) return null;
			const restarts = db.query("SELECT COUNT(*) AS n FROM operations WHERE status IN ('queued','running')").get() as { n: number };
			if (restarts.n) return null;
			const selected = db.query("SELECT id FROM deployment_jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1").get() as { id: string } | null;
			if (!selected) return null;
			db.query("UPDATE deployment_jobs SET status='running',started=? WHERE id=?").run(now(), selected.id);
			return job(db, selected.id);
		})();
		if (next) {
			if (next.application === 'panel' && ['deploy', 'rollback'].includes(next.action)) {
				try { await run(['flock', '-n', '/run/wiki-admin-panel-deploy.lock', bun, '/usr/local/libexec/cloudwiki-deployment-worker.js', '--run-job', next.id], { timeout: 1500000 }); }
				catch { db.query("UPDATE deployment_jobs SET status='failed',finished=?,result='Panel worker interrupted or another panel deployment holds the lock. Inspect current state before retrying.' WHERE id=? AND status='running'").run(now(), next.id); }
				await refreshSummary();
			} else await finishJob(next);
			cleanup();
		}
		if (Date.now() - lastRefresh > 30000) { await refreshSummary(); cleanup(); lastRefresh = Date.now(); }
		await Bun.sleep(500);
	}
}
process.on('SIGTERM', () => { stopping = true; });
main().catch((cause) => { console.error(redact(cause instanceof Error ? cause.message : 'Deployment worker failed')); process.exitCode = 1; });
