import { agent, agentError } from '#lib/server/agent.ts';
import type { History } from '#lib/monitoring.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async () => {
	try { return Response.json(await agent<History>('/history')); } catch (cause) { agentError(cause); }
};
