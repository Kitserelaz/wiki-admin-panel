import { error } from '@sveltejs/kit';
import { agent, agentError } from '#lib/server/agent.ts';
import type { Operation } from '#lib/monitoring.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.operator) error(401, 'Sign in required');
	if (request.headers.get('origin') !== url.origin) error(403, 'Invalid request origin');
	if (Number(request.headers.get('content-length') || '0') > 4096) error(413, 'Request too large');
	let body;
	try { body = await request.json(); } catch { error(400, 'Invalid request body'); }
	if (!body || typeof body !== 'object' || typeof body.id !== 'string' || typeof body.target !== 'string' || body.confirmed !== true) error(400, 'A confirmed restart target and operation ID are required');
	try {
		return Response.json(await agent<Operation>('/operations', { id: body.id, target: body.target, actor: locals.operator.id }), { status: 202 });
	} catch (cause) { agentError(cause); }
};
