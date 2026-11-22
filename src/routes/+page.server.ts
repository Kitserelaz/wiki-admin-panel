import { agent } from '#lib/server/agent.ts';
import type { Snapshot, History } from '#lib/monitoring.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async () => {
	const [snapshot, history] = await Promise.allSettled([agent<Snapshot>('/snapshot'), agent<History>('/history')]);
	return {
		host: snapshot.status === 'fulfilled' ? snapshot.value.host : null,
		points: history.status === 'fulfilled' ? history.value.points : [],
		unavailable: snapshot.status === 'rejected' || history.status === 'rejected'
	};
};
