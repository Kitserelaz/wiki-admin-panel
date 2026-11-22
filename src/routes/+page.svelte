<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import type { Snapshot, History } from '#lib/monitoring.ts';
	import { bytes, percent, duration, time } from '#lib/format.ts';
	import { pollVisible, readApi } from '#lib/polling.ts';
	import MetricChart from '#lib/components/MetricChart.svelte';
	let { data }: PageProps = $props();
	let host = $derived(data.host);
	let points = $derived(data.points);
	let failure = $derived(data.unavailable ? 'Host agent unavailable. Waiting for collection.' : '');
	let now = $state(Date.now());
	let stale = $derived(!host || now / 1000 - host.collectedAt > 30);
	onMount(() => {
		const clock = setInterval(() => { if (!document.hidden) now = Date.now(); }, 1000);
		const stop = pollVisible(async (signal) => {
			const [current, history] = await Promise.allSettled([readApi<Snapshot>('/api/host', signal), readApi<History>('/api/history', signal)]);
			if (signal.aborted) return;
			if (current.status === 'fulfilled') host = current.value.host;
			if (history.status === 'fulfilled') points = history.value.points;
			failure = current.status === 'rejected' || history.status === 'rejected' ? 'Host agent unavailable. Displaying the last collected data.' : '';
		});
		return () => { clearInterval(clock); stop(); };
	});
</script>
<svelte:head><title>Host health · CloudWiki Admin</title></svelte:head>
<div class="page-heading"><div><h1>Host health</h1><p>{duration(host?.uptimeSeconds)} uptime · Updated {time(host?.collectedAt)}</p></div>{#if stale}<span class="status warn">Stale data</span>{/if}</div>
{#if failure}<div class="notice" role="status">{failure}</div>{/if}
{#if host?.errors.length}<div class="notice" role="status">{#each host.errors as message}<p>{message}</p>{/each}</div>{/if}
<div class="metrics">
	<section class="card"><h2>CPU</h2><div class="value">{percent(host?.cpuPercent)}</div><p>Load 1 / 5 / 15 min</p><strong>{host?.load?.map((value) => value.toFixed(2)).join(' / ') || 'Unavailable'}</strong></section>
	<section class="card"><h2>Memory</h2><div class="value">{percent(host?.memoryUsedPercent)}</div><p>{bytes(host?.memoryUsedBytes)} used of {bytes(host?.memoryTotalBytes)}</p><strong>{bytes(host?.memoryAvailableBytes)} available</strong></section>
	<section class="card"><h2>Root filesystem</h2><div class="value">{percent(host?.diskUsedPercent)}</div><p>{bytes(host?.diskUsedBytes)} used of {bytes(host?.diskTotalBytes)}</p><strong>{bytes(host?.diskAvailableBytes)} available</strong></section>
	<section class="card"><h2>Disk I/O</h2><div class="io"><span>Read<strong>{host?.diskReadBps == null ? 'Unavailable' : `${bytes(host.diskReadBps)}/s`}</strong></span><span>Write<strong>{host?.diskWriteBps == null ? 'Unavailable' : `${bytes(host.diskWriteBps)}/s`}</strong></span></div></section>
</div>
<div class="host-details card"><div><span class="muted">Swap used / total</span><strong>{bytes(host?.swapUsedBytes)} / {bytes(host?.swapTotalBytes)}</strong></div><div><span class="muted">Reboot</span><strong>{host?.rebootRequired == null ? 'Unavailable' : host.rebootRequired ? 'Reboot required' : 'No reboot pending'}</strong></div></div>
<div class="history-heading"><h2>Last 24 hours</h2><span class="muted">Five-minute averages</span></div>
<div class="charts">
	<MetricChart title="CPU" {points} series={[{ key: 'cpuPercent', label: 'CPU', color: '#9fd4c5' }]} />
	<MetricChart title="Memory" {points} series={[{ key: 'memoryUsedPercent', label: 'Memory', color: '#b0b7c0' }]} />
	<MetricChart title="Disk usage" {points} series={[{ key: 'diskUsedPercent', label: 'Disk', color: '#9fd4c5' }]} />
	<MetricChart title="Disk I/O" {points} rate series={[{ key: 'diskReadBps', label: 'Read', color: '#9fd4c5' }, { key: 'diskWriteBps', label: 'Write', color: '#b0b7c0' }]} />
</div>
<style>
	.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 1.5rem; }
	.metrics :global(.card) { background: transparent; border: 0; border-radius: 0; padding: 0 1.5rem; border-left: 1px solid var(--border); }
	.metrics :global(.card:first-child) { padding-left: 0; border-left: 0; }
	.metrics h2 { color: var(--muted); font-size: .875rem; font-weight: 400; }
	.value { font-size: 2rem; font-weight: 550; letter-spacing: -.04em; margin: .7rem 0; }
	.metrics p { color: var(--muted); font-size: .875rem; margin: .35rem 0; }
	.metrics strong { font-size: .875rem; font-weight: 400; }
	.io { display: grid; gap: .6rem; margin-top: .9rem; }
	.io span { display: flex; justify-content: space-between; gap: .7rem; color: var(--muted); font-size: .875rem; }
	.io strong { color: var(--text); }
	.host-details { display: flex; flex-wrap: wrap; gap: 1rem 3rem; padding: 1rem 0; border-width: 1px 0; border-radius: 0; background: transparent; font-size: .875rem; }
	.host-details div { display: flex; gap: .75rem; }
	.host-details strong { font-weight: 400; }
	.history-heading { display: flex; flex-wrap: wrap; gap: .6rem; justify-content: space-between; align-items: center; margin: 2rem 0 1rem; }
	.history-heading span { font-size: .875rem; }
	.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem 2.5rem; }
	@media (max-width: 1000px) {
		.metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem 0; }
		.metrics :global(.card:nth-child(3)) { padding-left: 0; border-left: 0; }
	}
	@media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
</style>
