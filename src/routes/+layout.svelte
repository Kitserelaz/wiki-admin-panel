<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';
	let { children, data }: LayoutProps = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /><meta name="color-scheme" content="dark" /></svelte:head>
{#if data.operator}
	<aside class="sidebar">
		<a class="brand" href="/">CloudWiki<span>Administration</span></a>
		<nav aria-label="Administration">
			<a class:active={page.url.pathname === '/'} href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Host health</a>
			<a class:active={page.url.pathname === '/services'} href="/services" aria-current={page.url.pathname === '/services' ? 'page' : undefined}>Services</a>
		</nav>
		<div class="identity"><span class="muted">Signed in with Discord</span><strong>{data.operator.username}</strong><form method="POST" action="/auth/logout"><button class="quiet" type="submit">Sign out</button></form></div>
	</aside>
	<div class="workspace"><header class="topbar"><span>admin.cloudwiki.us</span><span class="muted">Production</span></header><main class="content">{@render children()}</main></div>
{:else}{@render children()}{/if}

<style>
	:global(*) { box-sizing: border-box; }
	:global(:root) { --background: #0b111b; --surface: #131d2d; --border: #29384e; --text: #edf3fc; --muted: #a6b5cc; --accent: #71dfdc; --warning: #ffce83; }
	:global(body) { margin: 0; background: var(--background); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
	:global(a) { color: var(--accent); }
	:global(button) { font: inherit; border: 1px solid var(--border); border-radius: .5rem; background: #22324a; color: var(--text); padding: .55rem .9rem; cursor: pointer; }
	:global(button:hover:not(:disabled)) { background: #30445f; }
	:global(button:disabled) { opacity: .5; cursor: not-allowed; }
	:global(button:focus-visible), :global(a:focus-visible) { outline: 2px solid var(--accent); outline-offset: 4px; }
	:global(h1) { font-size: clamp(1.8rem, 3vw, 2.25rem); line-height: 1.2; letter-spacing: -.035em; margin: 0 0 .5rem; }
	:global(h2) { font-size: 1.2rem; margin: 0; }
	:global(.muted) { color: var(--muted); }
	:global(.page-heading) { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; }
	:global(.page-heading p) { margin: .5rem 0 0; color: var(--muted); }
	:global(.card) { background: var(--surface); border: 1px solid var(--border); border-radius: .8rem; padding: 1.4rem; }
	:global(.notice) { border: 1px solid #78603e; background: #2d251a; color: #ffdcaa; padding: .85rem 1rem; border-radius: .5rem; margin: 0 0 1rem; }
	:global(.notice p) { margin: .3rem 0; }
	:global(.status) { display: inline-block; border: 1px solid var(--border); border-radius: .4rem; padding: .2rem .5rem; font-size: .875rem; }
	:global(.status.good) { color: #a2e6c6; background: #18362e; border-color: #31574a; }
	:global(.status.bad) { color: #ffb3ad; background: #392426; border-color: #6d3c3d; }
	:global(.status.warn) { color: var(--warning); background: #332d22; border-color: #6d5d3d; }
	:global(.quiet) { background: transparent; }
	.sidebar { position: fixed; inset: 0 auto 0 0; width: 228px; background: #0f1725; border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 2rem 1.25rem; }
	.brand { text-decoration: none; font-size: 1.5rem; font-weight: 700; color: var(--text); padding: 0 .65rem; letter-spacing: -.035em; }.brand span { display: block; color: var(--muted); font-size: .85rem; font-weight: 400; letter-spacing: 0; }
	nav { display: grid; gap: .4rem; margin-top: 2.5rem; } nav a { color: var(--muted); text-decoration: none; padding: .7rem .8rem; border-radius: .45rem; } nav a.active { color: var(--accent); background: #192e3c; }
	.identity { margin-top: auto; padding: .5rem .65rem 0; display: grid; gap: .5rem; overflow-wrap: anywhere; }.identity .muted { font-size: .875rem; }.identity button { margin-top: .3rem; }
	.workspace { margin-left: 228px; }.topbar { min-height: 76px; border-bottom: 1px solid var(--border); padding: 1.2rem 2.5rem; display: flex; gap: 1rem; justify-content: space-between; align-items: center; font-size: .9rem; }
	.content { max-width: 1600px; padding: 2.5rem; margin: auto; }
	@media (max-width: 760px) { .sidebar { position: static; width: auto; padding: 1rem; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 1rem; border-right: 0; border-bottom: 1px solid var(--border); }.brand { font-size: 1.2rem; }.brand span { display: none; } nav { display: flex; margin: 0; } nav a { padding: .5rem; }.identity { margin: 0 0 0 auto; padding: 0; display: flex; align-items: center; gap: .5rem; }.identity .muted { display: none; }.identity strong { font-size: .875rem; }.identity button { margin: 0; padding: .35rem .6rem; }.workspace { margin: 0; }.topbar { min-height: auto; padding: .75rem 1.25rem; }.content { padding: 1.5rem 1rem; } }
</style>
