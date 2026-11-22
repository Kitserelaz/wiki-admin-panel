import { error, redirect } from '@sveltejs/kit';
import { configuration, cookieOptions, signIn, stateCookie, validState } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, fetch }) => {
	const expected = cookies.get(stateCookie);
	cookies.delete(stateCookie, cookieOptions());
	if (!validState(url.searchParams.get('state'), expected)) error(400, 'Sign-in expired or could not be verified. Please try again.');
	if (url.searchParams.has('error')) error(400, 'Discord authorization was cancelled.');
	const code = url.searchParams.get('code');
	if (!code) error(400, 'Discord did not return an authorization code.');
	const issuer = url.searchParams.get('iss');
	if (issuer && issuer !== 'https://discord.com') error(400, 'Invalid authorization issuer.');
	const config = configuration();
	if (!config.ready) error(503, 'Discord sign-in is awaiting operator configuration.');

	let user: { id: string; username: string };
	try {
		const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
			method: 'POST',
			body: new URLSearchParams({
				client_id: config.clientId!, client_secret: config.clientSecret!,
				grant_type: 'authorization_code', code,
				redirect_uri: new URL('/auth/discord/callback', url.origin).href
			}),
			signal: AbortSignal.timeout(10000)
		});
		if (!tokenResponse.ok) throw new Error('Token exchange failed');
		const token = await tokenResponse.json();
		if (typeof token.access_token !== 'string') throw new Error('Invalid token response');
		const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
			headers: { Authorization: `Bearer ${token.access_token}` },
			signal: AbortSignal.timeout(10000)
		});
		if (!userResponse.ok) throw new Error('Identity lookup failed');
		user = await userResponse.json();
		if (typeof user.id !== 'string' || typeof user.username !== 'string') throw new Error('Invalid identity');
	} catch {
		error(502, 'Discord sign-in could not be completed. Please try again.');
	}
	if (!config.allowedIds.has(user.id)) error(403, 'Your Discord account is not authorized to access this panel.');
	signIn(cookies, { id: user.id, username: user.username });
	redirect(303, '/');
};
