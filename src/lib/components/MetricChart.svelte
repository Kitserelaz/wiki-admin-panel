<script lang="ts">
	import type { HistoryPoint, Metrics } from '#lib/monitoring.ts';
	import { bytes } from '#lib/format.ts';
	let { title, points, series, rate = false }: {
		title: string; points: HistoryPoint[]; series: { key: keyof Metrics; label: string; color: string }[]; rate?: boolean;
	} = $props();
	const width = 720, height = 150;
	let maximum = $derived(rate ? Math.max(1024, ...points.flatMap((point) => series.map(({ key }) => point[key] ?? 0))) : 100);
	let available = $derived(points.some((point) => series.some(({ key }) => point[key] !== null)));
	function segments(key: keyof Metrics) {
		const paths: string[] = [];
		let path = '';
		points.forEach((point, index) => {
			const value = point[key];
			if (value == null) { if (path) paths.push(path + ' l0,0'); path = ''; return; }
			const x = 8 + index / Math.max(1, points.length - 1) * (width - 16);
			const y = height - 8 - Math.min(1, value / maximum) * (height - 16);
			path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
		});
		if (path) paths.push(path + ' l0,0');
		return paths;
	}
</script>
<section class="chart card" aria-label={`${title}, last 24 hours`}>
	<div class="chart-title"><h2>{title}</h2><span class="muted">{rate ? `${bytes(maximum)}/s` : '100%'}</span></div>
	{#if available}
		<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} five-minute averages over 24 hours. Gaps indicate unavailable data.`}>
			{#each [0.25, 0.5, 0.75] as fraction}<line x1="0" x2={width} y1={height * fraction} y2={height * fraction} stroke="var(--border)" />{/each}
			{#each series as line}
				{#each segments(line.key) as path}<path d={path} fill="none" stroke={line.color} stroke-width="2.5" stroke-linecap="round" />{/each}
			{/each}
		</svg>
	{:else}<div class="empty-chart">Collecting history</div>{/if}
	<div class="chart-footer"><span>24 hours ago</span>{#if series.length > 1}<div>{#each series as line}<span class="legend" style:color={line.color}>{line.label}</span>{/each}</div>{/if}<span>Now</span></div>
</section>
<style>
	.chart { background: transparent; border: 0; border-radius: 0; padding: 0; }
	.chart-title, .chart-footer { display: flex; justify-content: space-between; align-items: center; gap: .75rem; }
	h2 { font-size: .875rem; font-weight: 500; margin: 0; }
	.chart-title > span { font-size: .875rem; }
	svg { width: 100%; display: block; margin: .9rem 0 .6rem; overflow: visible; }
	.chart-footer { font-size: .875rem; color: var(--muted); flex-wrap: wrap; }
	.legend { margin: 0 .4rem; }
	.empty-chart { height: 150px; display: grid; place-items: center; color: var(--muted); font-size: .875rem; }
</style>
