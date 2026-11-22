import { agent, agentError } from '#lib/server/agent.ts';
import type { Snapshot } from '#lib/monitoring.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async () => {
	try { return Response.json(await agent<Snapshot>('/snapshot')); } catch (cause) { agentError(cause); }
};
