/** Root-owned host agent. Only its Unix socket is reachable by the panel. */
import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, statfsSync, chmodSync, chownSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostSample, Service, ServiceSnapshot, Snapshot, Metrics, Operation } from '../src/lib/monitoring.ts';

const execute = promisify(execFile);
const units = ['docker.service', 'haproxy.service', 'wiki-admin-panel.service'];
const socketPath = '/run/cloudwiki-admin-agent/agent.sock';
const config: { project: string; services: string[] } = JSON.parse(readFileSync('/etc/cloudwiki-admin-agent.json', 'utf8'));
if (config.project !== 'cloudwiki-production' || !config.services.length || !config.services.every((name) => /^[a-z][a-z0-9-]*$/.test(name))) {
	throw new Error('Invalid production inventory');
}
const targets = new Set([...units.map((unit) => `unit:${unit}`), ...config.services.map((name) => `container:${name}`)]);
process.umask(0o077);
const db = new Database('/var/lib/cloudwiki-admin-agent/metrics.sqlite', { create: true, strict: true });
db.exec(`PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
 created INTEGER NOT NULL, started INTEGER, finished INTEGER, result TEXT
);`);
const seconds = () => Math.floor(Date.now() / 1000);
db.query("UPDATE operations SET status='failed', finished=?, result='Agent stopped during execution. Inspect the target before retrying.' WHERE status='running'").run(seconds());
const snapshot: Snapshot = { host: null, services: null };
const previous = new Map<string, { time: number; values: number[] }>();
let stopping = false;

async function command(args: string[], timeout = 5000) {
	const { stdout } = await execute(args[0], args.slice(1), { timeout, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL', encoding: 'utf8' });
	return stdout;
}

function delta(key: string, values: number[]) {
	const now = performance.now() / 1000;
	const before = previous.get(key);
	previous.set(key, { time: now, values });
	if (!before || now <= before.time || values.some((value, i) => value < before.values[i])) return null;
	return values.map((value, i) => (value - before.values[i]) / (now - before.time));
}

function collectHost(): HostSample {
	const data: HostSample = {
		collectedAt: seconds(), errors: [], cpuPercent: null, load: null,
		memoryUsedBytes: null, memoryAvailableBytes: null, memoryTotalBytes: null, memoryUsedPercent: null,
		swapUsedBytes: null, swapTotalBytes: null, diskTotalBytes: null, diskAvailableBytes: null,
		diskUsedBytes: null, diskUsedPercent: null, diskReadBps: null, diskWriteBps: null,
		uptimeSeconds: null, rebootRequired: null
	};
	try {
		const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
		const rates = delta('cpu', [cpu.reduce((a, b) => a + b, 0), cpu[3] + cpu[4]]);
		if (rates && rates[0] > 0) data.cpuPercent = Math.max(0, Math.min(100, 100 * (rates[0] - rates[1]) / rates[0]));
		data.load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
		data.uptimeSeconds = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
	} catch { data.errors.push('CPU and uptime measurements unavailable'); }
	try {
		const memory = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').trim().split('\n').map((line) => {
			const [name, value] = line.split(':');
			return [name, Number(value.trim().split(/\s+/)[0]) * 1024];
		}));
		data.memoryTotalBytes = memory.MemTotal;
		data.memoryAvailableBytes = memory.MemAvailable;
		data.memoryUsedBytes = memory.MemTotal - memory.MemAvailable;
		data.memoryUsedPercent = 100 * data.memoryUsedBytes / memory.MemTotal;
		data.swapTotalBytes = memory.SwapTotal;
		data.swapUsedBytes = memory.SwapTotal - memory.SwapFree;
	} catch { data.errors.push('Memory measurements unavailable'); }
	try {
		const disk = statfsSync('/');
		data.diskTotalBytes = disk.blocks * disk.bsize;
		data.diskAvailableBytes = disk.bavail * disk.bsize;
		data.diskUsedBytes = (disk.blocks - disk.bfree) * disk.bsize;
		data.diskUsedPercent = 100 * data.diskUsedBytes / data.diskTotalBytes;
	} catch { data.errors.push('Root filesystem measurements unavailable'); }
	try {
		// Resolve the root mount's major:minor directly, including partition counters.
		const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((line) => line.split(' ')).find((fields) => fields[4] === '/');
		if (!mount) throw new Error('Root mount unavailable');
		const counters = readFileSync(`/sys/dev/block/${mount[2]}/stat`, 'utf8').trim().split(/\s+/).map(Number);
		const rates = delta('disk', [counters[2] * 512, counters[6] * 512]);
		if (rates) [data.diskReadBps, data.diskWriteBps] = rates;
	} catch { data.errors.push('Root disk I/O measurements unavailable'); }
	data.rebootRequired = existsSync('/var/run/reboot-required');
	return data;
}

type Container = { id: string; service: string; state: string; started: number | null; health: string | null; restarts: number };
async function containers(): Promise<Container[]> {
	const ids = (await command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=cloudwiki-production'])).trim().split(/\s+/).filter(Boolean);
	if (!ids.length) return [];
	const template = '{{json .Id}}\t{{json .Config.Labels}}\t{{json .State.Status}}\t{{json .State.StartedAt}}\t{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}\t{{json .RestartCount}}';
	const output = await command(['docker', 'inspect', '--format', template, ...ids]);
	return output.trim().split('\n').flatMap((line) => {
		const [id, labels, state, started, health, restarts] = line.split('\t').map((part) => JSON.parse(part));
		const service = labels['com.docker.compose.service'];
		if (labels['com.docker.compose.oneoff']?.toLowerCase() === 'true' || labels['com.docker.compose.project'] !== config.project || !config.services.includes(service)) return [];
		const time = Date.parse(started.replace(/(\.\d{3})\d+/, '$1')) / 1000;
		return [{ id, service, state, health, restarts, started: Number.isFinite(time) && time > 0 ? time : null }];
	});
}

function memoryBytes(value: string): number | null {
	const match = value.match(/^([\d.]+)\s*([A-Za-z]+)$/);
	const scales: Record<string, number> = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
	return match && scales[match[2]] ? Number(match[1]) * scales[match[2]] : null;
}

async function collectServices(): Promise<ServiceSnapshot> {
	const errors: string[] = [];
	const items = await Promise.all(units.map(async (unit): Promise<Service> => {
		const item: Service = { target: `unit:${unit}`, name: unit, kind: 'host', state: 'unknown', health: null, uptimeSeconds: null, restarts: null, cpuPercent: null, memoryBytes: null, restartable: true };
		try {
			const output = await command(['systemctl', 'show', unit, '--property=ActiveState,SubState,NRestarts,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestampMonotonic']);
			const fields = Object.fromEntries(output.trim().split('\n').map((line) => line.split('=')));
			item.state = fields.ActiveState || 'unknown';
			item.detail = fields.SubState;
			item.restarts = /^\d+$/.test(fields.NRestarts) ? Number(fields.NRestarts) : null;
			item.memoryBytes = /^\d+$/.test(fields.MemoryCurrent) && fields.MemoryCurrent !== '18446744073709551615' ? Number(fields.MemoryCurrent) : null;
			if (/^\d+$/.test(fields.CPUUsageNSec) && fields.CPUUsageNSec !== '18446744073709551615') {
				const rate = delta(unit, [Number(fields.CPUUsageNSec)]);
				item.cpuPercent = rate ? rate[0] / 1e7 : null;
			}
			const started = Number(fields.ActiveEnterTimestampMonotonic) / 1e6;
			if (item.state === 'active' && started > 0) {
				const hostUptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
				item.uptimeSeconds = Math.max(0, hostUptime - started);
			}
		} catch { errors.push(`${unit} status unavailable`); }
		return item;
	}));
	let discovered: Container[] | null = null;
	const stats = new Map<string, { CPUPerc: string; MemUsage: string }>();
	try { discovered = await containers(); } catch { errors.push('Docker inventory unavailable'); }
	const running = discovered?.filter((container) => container.state === 'running').map((container) => container.id) || [];
	if (running.length) {
		try {
			const output = await command(['docker', 'stats', '--no-stream', '--format', '{{json .}}', ...running], 6000);
			for (const line of output.trim().split('\n')) {
				const stat = JSON.parse(line);
				stats.set(stat.ID, stat);
			}
		} catch { errors.push('Container resource measurements unavailable'); }
	}
	for (const name of config.services) {
		const matches = discovered?.filter((container) => container.service === name) || [];
		const row: Service = { target: `container:${name}`, name, kind: 'container', state: discovered === null ? 'unknown' : 'missing', health: null, uptimeSeconds: null, restarts: null, cpuPercent: null, memoryBytes: null, restartable: false };
		if (matches.length === 1) {
			const container = matches[0];
			Object.assign(row, { state: container.state, health: container.health, restarts: container.restarts, restartable: true });
			if (container.state === 'running' && container.started) row.uptimeSeconds = Math.max(0, seconds() - container.started);
			const stat = [...stats.entries()].find(([id]) => container.id.startsWith(id))?.[1];
			if (stat) {
				const cpu = Number.parseFloat(stat.CPUPerc);
				row.cpuPercent = Number.isFinite(cpu) ? cpu : null;
				row.memoryBytes = memoryBytes(stat.MemUsage.split('/')[0].trim());
			}
		} else if (matches.length > 1) {
			row.state = 'ambiguous';
			errors.push(`${name} has multiple containers; inspect the deployment before restarting`);
		}
		items.push(row);
	}
	return { collectedAt: seconds(), items, errors };
}

async function collectLoop(kind: 'host' | 'services') {
	while (!stopping) {
		const start = performance.now();
		try {
			if (kind === 'host') {
				const sample = collectHost();
				db.query('INSERT OR REPLACE INTO samples VALUES (?, ?)').run(sample.collectedAt, JSON.stringify(sample));
				db.query('DELETE FROM samples WHERE ts < ?').run(seconds() - 86400);
				db.query("DELETE FROM operations WHERE created < ? AND status IN ('succeeded','failed')").run(seconds() - 30 * 86400);
				snapshot.host = sample;
			} else snapshot.services = await collectServices();
		} catch { console.error(`${kind} collection failed`); }
		await Bun.sleep(Math.max(100, 10000 - (performance.now() - start)));
	}
}

const metricKeys: (keyof Metrics)[] = ['cpuPercent', 'memoryUsedPercent', 'diskUsedPercent', 'diskReadBps', 'diskWriteBps'];
function history() {
	const end = Math.floor(seconds() / 300) * 300;
	const start = end - 287 * 300;
	const aggregates = metricKeys.map((key) => `AVG(json_extract(data, '$.${key}')) AS ${key}`).join(',');
	const rows = db.query(`SELECT (ts / 300) * 300 AS bucket, ${aggregates} FROM samples WHERE ts >= ? GROUP BY bucket ORDER BY bucket`).all(start) as (Metrics & { bucket: number })[];
	const indexed = new Map(rows.map((row) => [row.bucket, row]));
	return { points: Array.from({ length: 288 }, (_, index) => {
		const timestamp = start + index * 300;
		const row = indexed.get(timestamp);
		return { timestamp, ...Object.fromEntries(metricKeys.map((key) => [key, row?.[key] ?? null])) };
	}) };
}

class RequestError extends Error {
	constructor(public status: number, message: string) { super(message); }
}
function operation(id: string) {
	return db.query('SELECT * FROM operations WHERE id=?').get(id) as Operation | null;
}
const enqueue = db.transaction((body: Record<string, unknown>) => {
	const { id, actor, target } = body;
	if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new RequestError(400, 'Invalid operation ID');
	if (typeof actor !== 'string' || !/^\d{17,20}$/.test(actor)) throw new RequestError(400, 'Invalid operator identity');
	if (typeof target !== 'string' || !targets.has(target)) throw new RequestError(400, 'Unsupported restart target');
	const existing = operation(id);
	if (existing) {
		if (existing.actor !== actor || existing.target !== target) throw new RequestError(409, 'Operation ID belongs to another request');
		return existing;
	}
	const count = db.query("SELECT COUNT(*) AS count FROM operations WHERE status IN ('queued','running')").get() as { count: number };
	if (count.count >= 20) throw new RequestError(429, 'Restart queue is full');
	db.query('INSERT INTO operations (id,actor,target,status,created) VALUES (?,?,?,?,?)').run(id, actor, target, 'queued', seconds());
	return operation(id);
});

async function restartLoop() {
	while (!stopping) {
		const next = db.query("SELECT * FROM operations WHERE status='queued' ORDER BY created,rowid LIMIT 1").get() as Operation | null;
		if (!next) { await Bun.sleep(500); continue; }
		db.query("UPDATE operations SET status='running',started=? WHERE id=?").run(seconds(), next.id);
		let status = 'succeeded';
		let result = 'Restart command completed. Application health is reported separately.';
		try {
			if (!targets.has(next.target)) throw new Error('Unsupported restart target');
			if (next.target.startsWith('unit:')) {
				await command(['systemctl', 'restart', next.target.slice(5)], 120000);
			} else {
				const matches = (await containers()).filter((container) => container.service === next.target.slice(10));
				if (matches.length !== 1) throw new Error('Missing or ambiguous container');
				await command(['docker', 'restart', '--timeout', '30', matches[0].id], 90000);
			}
		} catch (error) {
			status = 'failed';
			result = (error as { killed?: boolean }).killed
				? 'Restart command timed out. Inspect service state before retrying.'
				: 'Restart could not be completed. Inspect the target service and host logs.';
			console.error(`Restart failed for ${next.target}, operation ${next.id}`);
		}
		db.query('UPDATE operations SET status=?,finished=?,result=? WHERE id=?').run(status, seconds(), result, next.id);
	}
}

if (existsSync(socketPath)) unlinkSync(socketPath);
const server = Bun.serve({
	unix: socketPath,
	maxRequestBodySize: 4096,
	async fetch(request) {
		try {
			const path = new URL(request.url).pathname;
			if (request.method === 'GET') {
				if (path === '/snapshot') return Response.json(snapshot);
				if (path === '/history') return Response.json(history());
				if (path === '/operations') return Response.json({ operations: db.query('SELECT * FROM operations ORDER BY created DESC,rowid DESC LIMIT 50').all() });
				if (/^\/operations\/[a-f0-9-]{36}$/.test(path)) {
					const found = operation(path.split('/').at(-1)!);
					if (!found) throw new RequestError(404, 'Operation not found');
					return Response.json(found);
				}
			}
			if (request.method === 'POST' && path === '/operations') {
				let body;
				try { body = await request.json(); } catch { throw new RequestError(400, 'Invalid request body'); }
				if (!body || Array.isArray(body) || typeof body !== 'object') throw new RequestError(400, 'Invalid request body');
				return Response.json(enqueue(body), { status: 202 });
			}
			throw new RequestError(404, 'Unknown agent endpoint');
		} catch (error) {
			if (error instanceof RequestError) return Response.json({ message: error.message }, { status: error.status });
			console.error('Agent request failed');
			return Response.json({ message: 'Host agent unavailable' }, { status: 503 });
		}
	}
});
const group = readFileSync('/etc/group', 'utf8').split('\n').find((line) => line.startsWith('wiki-admin-panel:'));
if (!group) throw new Error('Panel group missing');
chownSync(socketPath, 0, Number(group.split(':')[2]));
chmodSync(socketPath, 0o660);
void collectLoop('host');
void collectLoop('services');
void restartLoop();
process.on('SIGTERM', () => {
	stopping = true;
	server.stop(true);
	db.close();
	process.exit(0);
});
console.info('CloudWiki Bun agent listening on Unix socket');
