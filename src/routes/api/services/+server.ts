import { agent, agentError } from '#lib/server/agent.ts';
import type { Snapshot, Operation } from '#lib/monitoring.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async () => {
	try {
		const [snapshot, operations] = await Promise.all([agent<Snapshot>('/snapshot'), agent<{ operations: Operation[] }>('/operations')]);
		return Response.json({ services: snapshot.services, operations: operations.operations });
	} catch (cause) { agentError(cause); }
};
