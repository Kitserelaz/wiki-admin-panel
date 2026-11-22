<script lang="ts">
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Sign in · CloudWiki Admin</title></svelte:head>
<main>
	<h1>CloudWiki</h1>
	{#if data.configured}
		<a href="/auth/discord">Sign in with Discord</a>
	{:else}
		<p role="status">Discord sign-in is awaiting operator configuration.</p>
	{/if}
</main>

<style>
	main { width: min(100%, 24rem); margin: 18vh auto; padding: 2rem; }
	h1 { margin-bottom: 1.75rem; }
	p { color: var(--muted); }
	a { display: inline-block; padding: .65rem 1rem; border: 1px solid var(--border); border-radius: 4px; text-decoration: none; }
	a:hover { background: #24282c; }
</style>
