import { error } from '@sveltejs/kit';
import { agent, agentError } from '#lib/server/agent.ts';
import type { Operation } from '#lib/monitoring.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params }) => {
	if (!/^[a-f0-9-]{36}$/.test(params.id)) error(400, 'Invalid operation ID');
	try { return Response.json(await agent<Operation>(`/operations/${params.id}`)); } catch (cause) { agentError(cause); }
};
