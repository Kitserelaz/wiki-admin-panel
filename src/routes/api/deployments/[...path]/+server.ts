import { error } from '@sveltejs/kit';
import { agent, agentError } from '#lib/server/agent.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params }) => {
	if (!/^(?:jobs\/[a-f0-9-]{36}(?:\/log)?|reviews\/[a-f0-9-]{36})$/.test(params.path)) error(404, 'Unknown deployment endpoint');
	try { return Response.json(await agent(`/deployments/${params.path}`)); } catch (cause) { agentError(cause); }
};
