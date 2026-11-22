import { redirect } from '@sveltejs/kit';
import { configuration } from '#lib/server/auth.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.operator) redirect(303, '/');
	return { configured: configuration().ready };
};
