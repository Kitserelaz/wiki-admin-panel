<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="color-scheme" content="dark" />
</svelte:head>

{#if data.operator}
	<header class="site-header">
		<div class="header-content">
			<a class="brand" href="/">CloudWiki</a>
			<span class="environment">Production</span>
			<nav aria-label="Administration">
				<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Host health</a>
				<a href="/services" aria-current={page.url.pathname === '/services' ? 'page' : undefined}>Services</a>
				<a href="/deployments" aria-current={page.url.pathname === '/deployments' ? 'page' : undefined}>Deployments</a>
			</nav>
			<div class="identity">
				<span>{data.operator.username}</span>
				<form method="POST" action="/auth/logout"><button class="quiet" type="submit">Sign out</button></form>
			</div>
		</div>
	</header>
	<main class="content">{@render children()}</main>
{:else}
	{@render children()}
{/if}

<style>
	:global(*) { box-sizing: border-box; }
	:global(:root) {
		--background: #111315;
		--surface: #171a1d;
		--border: #303438;
		--text: #e6e8eb;
		--muted: #a3a9b1;
		--accent: #9fd4c5;
		--warning: #dec18f;
	}
	:global(body) {
		margin: 0;
		background: var(--background);
		color: var(--text);
		font: 16px/1.5 system-ui, -apple-system, sans-serif;
	}
	:global(a) { color: var(--text); text-underline-offset: .2em; }
	:global(button) {
		font: inherit;
		font-size: .875rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: transparent;
		color: var(--text);
		padding: .4rem .7rem;
		cursor: pointer;
	}
	:global(button:hover:not(:disabled)) { background: #24282c; }
	:global(button:disabled) { opacity: .45; cursor: not-allowed; }
	:global(button:focus-visible), :global(a:focus-visible),
	:global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible),
	:global(summary:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
	:global(h1) { font-size: 1.65rem; line-height: 1.3; font-weight: 600; letter-spacing: -.025em; margin: 0; }
	:global(h2) { font-size: 1rem; font-weight: 550; margin: 0; }
	:global(.muted) { color: var(--muted); }
	:global(.page-heading) { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.75rem; }
	:global(.page-heading p) { margin: .35rem 0 0; color: var(--muted); font-size: .875rem; }
	:global(.card) { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 1.1rem; }
	:global(.notice) { border-left: 2px solid #907b57; color: #e3ccaa; padding: .65rem .9rem; margin: 0 0 1rem; font-size: .875rem; }
	:global(.notice p) { margin: .25rem 0; }
	:global(.status) { display: inline; font-size: .875rem; color: var(--muted); white-space: nowrap; }
	:global(.status.good) { color: #a4cdb9; }
	:global(.status.bad) { color: #e5aaa5; }
	:global(.status.warn) { color: var(--warning); }
	:global(.quiet) { border-color: transparent; color: var(--muted); }
	.site-header { border-bottom: 1px solid var(--border); }
	.header-content {
		max-width: 1440px;
		min-height: 68px;
		padding: 0 2rem;
		margin: auto;
		display: flex;
		align-items: center;
		gap: 1.1rem;
	}
	.brand { color: var(--text); font-weight: 600; text-decoration: none; letter-spacing: -.025em; }
	.environment { color: var(--muted); font-size: .875rem; }
	nav { display: flex; align-self: stretch; gap: 1.4rem; margin-left: 1.5rem; }
	nav a { display: flex; align-items: center; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; font-size: .875rem; }
	nav a[aria-current='page'] { color: var(--text); border-color: var(--text); }
	.identity { display: flex; align-items: center; gap: .8rem; margin-left: auto; color: var(--muted); font-size: .875rem; }
	.identity span { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.content { max-width: 1440px; padding: 2.5rem 2rem 4rem; margin: auto; }
	@media (max-width: 760px) {
		.header-content { flex-wrap: wrap; gap: .75rem; padding: .9rem 1rem 0; }
		.environment { margin-right: auto; }
		.identity { gap: .4rem; }
		.identity span { max-width: 8rem; }
		nav { order: 3; flex-basis: 100%; margin: 0; gap: 1.5rem; }
		nav a { padding: .65rem 0; }
		.content { padding: 1.75rem 1rem 3rem; }
	}
	@media (max-width: 420px) { .environment { display: none; } }
</style>
