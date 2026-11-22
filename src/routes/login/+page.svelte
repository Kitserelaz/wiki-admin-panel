<script lang="ts">
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Sign in · CloudWiki Admin</title></svelte:head>
<main>
	<h1>CloudWiki Admin</h1>
	<p>Sign in with your authorized Discord account.</p>
	{#if data.configured}
		<a href="/auth/discord">Sign in with Discord</a>
	{:else}
		<p role="status">Discord sign-in is awaiting operator configuration.</p>
	{/if}
</main>

<style>
	:global(body) { margin: 0; background: #101827; color: #edf2fa; font-family: system-ui, sans-serif; }
	main { max-width: 28rem; margin: 15vh auto; padding: 2rem; }
	h1 { font-size: 2rem; }
	p { line-height: 1.6; color: #c6d0df; }
	a { display: inline-block; margin-top: 1rem; padding: .85rem 1.2rem; background: #5865f2; color: white; border-radius: .5rem; font-weight: 600; text-decoration: none; }
	a:focus-visible { outline: 3px solid white; outline-offset: 4px; }
</style>
