import { error, redirect } from '@sveltejs/kit';
import { configuration, cookieOptions, nonce, stateCookie } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ cookies, url }) => {
	const config = configuration();
	if (!config.ready) error(503, 'Discord sign-in is awaiting operator configuration.');
	const state = nonce();
	cookies.set(stateCookie, state, { ...cookieOptions(), maxAge: 600 });
	const target = new URL('https://discord.com/oauth2/authorize');
	target.search = new URLSearchParams({
		client_id: config.clientId!,
		response_type: 'code',
		scope: 'identify',
		redirect_uri: new URL('/auth/discord/callback', url.origin).href,
		state
	}).toString();
	redirect(302, target.href, { external: ['https://discord.com'] });
};
