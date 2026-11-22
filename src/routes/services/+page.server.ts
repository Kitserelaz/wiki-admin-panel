import { agent } from '#lib/server/agent.ts';
import type { Snapshot, Operation } from '#lib/monitoring.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async () => {
	const [snapshot, operations] = await Promise.allSettled([agent<Snapshot>('/snapshot'), agent<{ operations: Operation[] }>('/operations')]);
	return {
		services: snapshot.status === 'fulfilled' ? snapshot.value.services : null,
		operations: operations.status === 'fulfilled' ? operations.value.operations : [],
		unavailable: snapshot.status === 'rejected' || operations.status === 'rejected'
	};
};
