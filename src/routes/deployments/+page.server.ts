import { agent } from '#lib/server/agent.ts';
import type { DeploymentSummary } from '#lib/deployments.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async () => {
	try { return { summary: await agent<DeploymentSummary>('/deployments') }; } catch { return { summary: null }; }
};
