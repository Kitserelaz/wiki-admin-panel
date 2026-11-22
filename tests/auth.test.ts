import { describe, test, expect, beforeEach } from 'bun:test';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string> = {
	CLIENT_ID: '123456789012345678', CLIENT_SECRET: 'test-secret',
	DISCORD_ALLOWED_USER_IDS: '123456789012345678, 987654321098765432', NODE_ENV: 'production'
};
Object.assign(process.env, env);
const auth = await import('../src/lib/server/auth');
const callback = await import('../src/routes/auth/discord/callback/+server');
const login = await import('../src/routes/auth/discord/+server');
const { handle } = await import('../src/hooks.server');

function cookies() {
	const values = new Map<string, string>();
	return { values, get: (key: string) => values.get(key), set: (key: string, value: string) => values.set(key, value), delete: (key: string) => values.delete(key) } as unknown as Cookies & { values: Map<string, string> };
}

beforeEach(() => { process.env.DISCORD_ALLOWED_USER_IDS = '123456789012345678, 987654321098765432'; });

describe('operator authentication', () => {
	test('parses IDs as strings and supports existing credential names', () => {
		expect(auth.configuration().ready).toBe(true);
		expect(auth.configuration().allowedIds.has('987654321098765432')).toBe(true);
		expect(auth.configuration().clientId).toBe(env.CLIENT_ID);
	});
	test('fails closed for an empty or malformed allowlist', () => {
		for (const value of ['', '123456789012345678,invalid']) {
			process.env.DISCORD_ALLOWED_USER_IDS = value;
			expect(auth.configuration().ready).toBe(false);
		}
	});
	test('rejects missing, mismatched, or malformed OAuth state', () => {
		const state = auth.nonce();
		expect(auth.validState(state, state)).toBe(true);
		for (const value of [null, '', 'a', auth.nonce()]) expect(auth.validState(value, state)).toBe(false);
	});
	test('uses host-only secure production cookies', () => {
		expect(auth.sessionCookie.startsWith('__Host-')).toBe(true);
		expect(auth.stateCookie.startsWith('__Host-')).toBe(true);
		expect(auth.cookieOptions()).toEqual({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
	});
	test('revokes sessions on logout and removal from the allowlist', () => {
		const jar = cookies();
		auth.signIn(jar, { id: env.CLIENT_ID, username: 'operator' });
		expect(auth.operator(jar)?.id).toBe(env.CLIENT_ID);
		auth.signOut(jar);
		expect(auth.operator(jar)).toBeNull();
		auth.signIn(jar, { id: env.CLIENT_ID, username: 'operator' });
		process.env.DISCORD_ALLOWED_USER_IDS = '';
		expect(auth.operator(jar)).toBeNull();
	});
	test('redirects anonymous protected requests before resolving them', async () => {
		let resolved = false;
		try {
			await handle({ event: { cookies: cookies(), locals: {}, url: new URL('https://admin.cloudwiki.us/') }, resolve: async () => { resolved = true; return new Response(); } } as any);
			throw new Error('Expected redirect');
		} catch (result: any) { expect(result.status).toBe(303); expect(result.location).toBe('/login'); }
		expect(resolved).toBe(false);
	});
	test('starts OAuth with identify scope and the correct callback', () => {
		const jar = cookies();
		try { login.GET({ cookies: jar, url: new URL('https://admin.cloudwiki.us/auth/discord') } as any); }
		catch (result: any) {
			const target = new URL(result.location);
			expect(target.searchParams.get('scope')).toBe('identify');
			expect(target.searchParams.get('redirect_uri')).toBe('https://admin.cloudwiki.us/auth/discord/callback');
			expect(target.searchParams.get('state')).toBe(jar.get(auth.stateCookie)!);
			return;
		}
		throw new Error('Expected OAuth redirect');
	});
	test('rejects callback state before contacting Discord', async () => {
		let called = false;
		try { await callback.GET({ cookies: cookies(), url: new URL('https://admin.cloudwiki.us/auth/discord/callback?code=test'), fetch: async () => { called = true; } } as any); }
		catch (result: any) { expect(result.status).toBe(400); }
		expect(called).toBe(false);
	});
	for (const allowed of [true, false]) {
		test(`callback ${allowed ? 'admits allowlisted' : 'rejects unauthorized'} Discord identity`, async () => {
			const jar = cookies(); const state = auth.nonce();
			jar.set(auth.stateCookie, state, { path: '/' });
			const id = allowed ? env.CLIENT_ID : '111111111111111111';
			const fetch = async (url: string) => Response.json(url.endsWith('/token') ? { access_token: 'test-token' } : { id, username: 'operator' });
			try { await callback.GET({ cookies: jar, url: new URL(`https://admin.cloudwiki.us/auth/discord/callback?code=test&state=${state}`), fetch } as any); throw new Error('Expected callback result'); }
			catch (result: any) { expect(result.status).toBe(allowed ? 303 : 403); }
			expect(auth.operator(jar)?.id ?? null).toBe(allowed ? id : null);
			expect(jar.get(auth.stateCookie)).toBeUndefined();
		});
	}
});
