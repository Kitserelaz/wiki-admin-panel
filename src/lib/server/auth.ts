import { env } from 'node:process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

export type Operator = { id: string; username: string };
const sessions = new Map<string, { user: Operator; expires: number }>();
const sessionLifetime = 8 * 60 * 60;
export const sessionCookie = env.NODE_ENV === 'production' ? '__Host-cloudwiki_session' : 'cloudwiki_session';
export const stateCookie = env.NODE_ENV === 'production' ? '__Host-cloudwiki_oauth_state' : 'cloudwiki_oauth_state';

export function configuration() {
	const clientId = env.DISCORD_CLIENT_ID || env.CLIENT_ID;
	const clientSecret = env.DISCORD_CLIENT_SECRET || env.CLIENT_SECRET;
	const allowedIds = new Set((env.DISCORD_ALLOWED_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
	return { clientId, clientSecret, allowedIds, ready: Boolean(clientId && clientSecret && allowedIds.size && [...allowedIds].every((id) => /^\d{17,20}$/.test(id))) };
}

export function cookieOptions() {
	return { path: '/', httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const };
}

export function nonce() {
	return randomBytes(32).toString('hex');
}

export function validState(actual: string | null, expected: string | undefined) {
	return Boolean(actual && expected && /^[a-f0-9]{64}$/.test(actual) && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
}

function clearExpired() {
	for (const [token, session] of sessions) {
		if (session.expires <= Date.now()) sessions.delete(token);
	}
}

export function operator(cookies: Cookies): Operator | null {
	clearExpired();
	const token = cookies.get(sessionCookie);
	const session = token ? sessions.get(token) : undefined;
	if (!session) return null;
	const config = configuration();
	if (!config.ready || !config.allowedIds.has(session.user.id)) {
		sessions.delete(token!);
		return null;
	}
	return session.user;
}

export function signOut(cookies: Cookies) {
	const token = cookies.get(sessionCookie);
	if (token) sessions.delete(token);
	cookies.delete(sessionCookie, cookieOptions());
}

export function signIn(cookies: Cookies, user: Operator) {
	clearExpired();
	signOut(cookies);
	const token = nonce();
	sessions.set(token, { user, expires: Date.now() + sessionLifetime * 1000 });
	cookies.set(sessionCookie, token, { ...cookieOptions(), maxAge: sessionLifetime });
}
