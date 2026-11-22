import { error } from '@sveltejs/kit';
import { agent, agentError } from '#lib/server/agent.ts';
import type { DeploymentSummary, DeploymentJob } from '#lib/deployments.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async () => {
	try { return Response.json(await agent<DeploymentSummary>('/deployments')); } catch (cause) { agentError(cause); }
};
export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.operator) error(401, 'Sign in required');
	if (request.headers.get('origin') !== url.origin) error(403, 'Invalid request origin');
	if (Number(request.headers.get('content-length') || '0') > 65536) error(413, 'Request too large');
	let body;
	try { body = await request.json(); } catch { error(400, 'Invalid request body'); }
	if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirmed !== true) error(400, 'Confirmed operation required');
	try { return Response.json(await agent<DeploymentJob>('/deployments', { ...body, actor: locals.operator.id }), { status: 202 }); } catch (cause) { agentError(cause); }
};
