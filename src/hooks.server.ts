import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { operator } from '#lib/server/auth.ts';

const publicPaths = new Set(['/login', '/auth/discord', '/auth/discord/callback']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.operator = operator(event.cookies);
	if (!event.locals.operator && !publicPaths.has(event.url.pathname)) {
		redirect(303, '/login');
	}
	const response = await resolve(event);
	response.headers.set('Cache-Control', 'no-store');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Frame-Options', 'DENY');
	return response;
};
