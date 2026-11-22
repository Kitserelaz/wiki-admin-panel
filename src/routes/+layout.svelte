<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if data.operator}
	<header>
		<span>Signed in as {data.operator.username}</span>
		<form method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
	</header>
{/if}
{@render children()}
