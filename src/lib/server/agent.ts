import { request } from 'node:http';
import { error } from '@sveltejs/kit';

export function agent<T>(path: string, body?: object): Promise<T> {
	return new Promise((resolve, reject) => {
		const payload = body ? JSON.stringify(body) : undefined;
		const req = request({
			socketPath: '/run/cloudwiki-admin-agent/agent.sock', path,
			method: payload ? 'POST' : 'GET',
			headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
		}, (response) => {
			let text = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => {
				text += chunk;
				if (text.length > 2 * 1024 * 1024) req.destroy(new Error('Agent response too large'));
			});
			response.on('error', () => reject(new Error('Host agent unavailable')));
			response.on('end', () => {
				try {
					const data = JSON.parse(text);
					if ((response.statusCode || 500) >= 400) {
						reject({ status: response.statusCode, message: data.message || 'Host agent unavailable' });
					} else resolve(data);
				} catch { reject(new Error('Invalid agent response')); }
			});
		});
		req.setTimeout(5000, () => req.destroy(new Error('Host agent timed out')));
		req.on('error', () => reject(new Error('Host agent unavailable')));
		req.end(payload);
	});
}

export function agentError(cause: unknown): never {
	const failure = cause as { status?: number; message?: string };
	error(failure.status && failure.status >= 400 && failure.status < 500 ? failure.status : 503,
		failure.status ? failure.message || 'Host agent unavailable' : 'Host agent unavailable. Last collected data may be stale.');
}
