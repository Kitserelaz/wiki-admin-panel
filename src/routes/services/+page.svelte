<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import type { Service, Operation, ServiceSnapshot } from '#lib/monitoring.ts';
	import { bytes, percent, duration, time } from '#lib/format.ts';
	import { pollVisible, readApi } from '#lib/polling.ts';
	let { data }: PageProps = $props();
	let services = $derived(data.services);
	let operations = $derived(data.operations);
	let failure = $derived(data.unavailable ? 'Host agent unavailable. Waiting for collection.' : '');
	let now = $state(Date.now());
	let selected = $state<Service | null>(null);
	let operationId = $state('');
	let submitting = $state(false);
	let submissionError = $state('');
	let dialog = $state<HTMLDialogElement>();
	$effect(() => {
		if (selected && dialog && !dialog.open) dialog.showModal();
		if (!selected && dialog?.open) dialog.close();
	});
	let stale = $derived(!services || now / 1000 - services.collectedAt > 30);
	let activeOperations = $derived(operations.filter((operation) => operation.status === 'queued' || operation.status === 'running'));
	let canRestart = $derived(!stale && !failure && !submitting && activeOperations.length === 0);

	function impact(service: Service) {
		if (service.target === 'unit:docker.service') return 'Restarting Docker can interrupt the entire wiki farm and its running containers.';
		if (service.target === 'unit:haproxy.service') return 'Restarting HAProxy briefly interrupts public connectivity to the panel and wikis.';
		if (service.target === 'unit:wiki-admin-panel.service') return 'Restarting the panel ends all panel sessions. You will need to sign in again to see the result.';
		if (service.name === 'database') return 'Restarting the database interrupts database access across the wiki farm.';
		if (service.name === 'web') return 'Restarting the web container briefly interrupts wiki traffic.';
		return `Restarting ${service.name} interrupts its current work. Other services may depend on it.`;
	}
	function choose(service: Service) {
		selected = service;
		operationId = crypto.randomUUID();
		submissionError = '';
	}
	async function submit() {
		if (!selected || submitting) return;
		submitting = true;
		try {
			const response = await fetch('/api/operations', { signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: operationId, target: selected.target, confirmed: true }) });
			if (response.redirected) { window.location.assign('/login'); return; }
			const body = await response.json();
			if (!response.ok) throw new Error(body.message || 'Restart request was rejected.');
			const operation = body as Operation;
			operations = [operation, ...operations.filter((item) => item.id !== operation.id)].slice(0, 50);
			selected = null;
		} catch (cause) {
			submissionError = cause instanceof Error ? cause.message : 'Restart submission failed. Retry uses the same operation ID.';
		} finally { submitting = false; }
	}
	onMount(() => {
		const clock = setInterval(() => { if (!document.hidden) now = Date.now(); }, 1000);
		const stop = pollVisible(async (signal) => {
			try {
				const latest = await readApi<{ services: ServiceSnapshot | null; operations: Operation[] }>('/api/services', signal);
				if (signal.aborted) return;
				services = latest.services;
				operations = latest.operations;
				failure = '';
			} catch { if (!signal.aborted) failure = 'Host agent unavailable. Displaying the last collected data.'; }
		});
		return () => { clearInterval(clock); stop(); };
	});
</script>
<svelte:head><title>Services · CloudWiki Admin</title></svelte:head>
<div class="page-heading"><div><h1>Services</h1><p>Production host services and Compose containers</p></div><span class="status" class:warn={stale} class:good={!stale}>{stale ? 'Stale data' : 'Live'}</span></div>
{#if failure}<div class="notice" role="status">{failure}</div>{/if}
{#if services?.errors.length}<div class="notice" role="status">{#each services.errors as message}<p>{message}</p>{/each}</div>{/if}
{#if activeOperations.length}<div class="notice" role="status">A restart is {activeOperations[0].status}. Further restarts are available after it finishes.</div>{/if}
<p class="collection muted">Last collected {time(services?.collectedAt)} · updates every 10 seconds</p>
{#each ['host', 'container'] as kind}
	<section class="service-section"><h2>{kind === 'host' ? 'Host services' : 'Production containers'}</h2>
		<div class="table-wrap card"><table><thead><tr><th>Service</th><th>State</th><th>Health</th><th>Uptime</th><th>Auto restarts</th><th>CPU</th><th>Memory</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
		{#each services?.items.filter((service) => service.kind === kind) || [] as service (service.target)}
			<tr><td><strong>{service.name}</strong>{#if service.detail}<span class="muted detail">{service.detail}</span>{/if}</td><td><span class="status" class:good={['active','running'].includes(service.state)} class:bad={['failed','exited','dead','missing'].includes(service.state)} class:warn={['unknown','ambiguous','restarting','paused'].includes(service.state)}>{service.state}</span></td><td><span class:healthy={service.health === 'healthy'} class:unhealthy={service.health === 'unhealthy'}>{service.health || (service.state === 'unknown' ? 'Unavailable' : kind === 'host' ? 'Not configured' : service.state === 'missing' ? 'Unavailable' : 'No health check')}</span></td><td>{duration(service.uptimeSeconds)}</td><td>{service.restarts ?? 'Unavailable'}</td><td>{percent(service.cpuPercent)}</td><td>{bytes(service.memoryBytes)}</td><td><button disabled={!service.restartable || !canRestart} onclick={() => choose(service)} aria-label={`Restart ${service.name}`}>Restart</button></td></tr>
		{:else}<tr><td colspan="8" class="muted">Awaiting service inventory</td></tr>{/each}
		</tbody></table></div>
	</section>
{/each}
<p class="muted collection">CPU usage is measured per core and can exceed 100%. Missing or ambiguous containers require deployment repair.</p>
<section class="service-section"><h2>Restart history</h2><p class="muted collection">Operations retained for 30 days · showing the most recent 50</p>
<div class="table-wrap card"><table><thead><tr><th>Requested</th><th>Target</th><th>Operator Discord ID</th><th>Status</th><th>Result</th></tr></thead><tbody>
{#each operations as operation (operation.id)}<tr><td>{time(operation.created)}<span class="muted detail">{operation.id}</span></td><td>{operation.target}</td><td>{operation.actor}</td><td><span class="status" class:good={operation.status === 'succeeded'} class:bad={operation.status === 'failed'} class:warn={['queued','running'].includes(operation.status)}>{operation.status}</span></td><td>{operation.result || 'Waiting for restart command to finish'}{#if operation.started}<span class="muted detail">Started {time(operation.started)}</span>{/if}{#if operation.finished}<span class="muted detail">Finished {time(operation.finished)}</span>{/if}</td></tr>
{:else}<tr><td colspan="5" class="muted">No restart operations recorded</td></tr>{/each}
</tbody></table></div></section>
<dialog bind:this={dialog} class="modal card" aria-labelledby="restart-title" oncancel={(event) => { if (submitting) event.preventDefault(); else selected = null; }}>
	{#if selected}
		<h2 id="restart-title">Restart {selected.name}?</h2><p>{impact(selected)}</p><p class="muted">The request will run on the host. Its result will appear in restart history.</p>
		{#if submissionError}<div class="notice" role="alert">{submissionError} Retry submits the same operation ID.</div>{/if}
		<div class="modal-actions"><button class="quiet" disabled={submitting} onclick={() => { selected = null; }}>Cancel</button><button disabled={submitting || stale || !!failure || activeOperations.length > 0} onclick={submit}>{submitting ? 'Submitting…' : 'Confirm restart'}</button></div>
	{/if}
</dialog>
<style>
	.collection { font-size: .875rem; }.service-section { margin-top: 2rem; }.service-section > h2 { margin-bottom: 1rem; }.table-wrap { padding: 0; overflow-x: auto; }table { width: 100%; border-collapse: collapse; text-align: left; font-size: .9rem; }th { font-size: .85rem; font-weight: 500; color: var(--muted); background: #172234; }th, td { padding: 1rem; border-bottom: 1px solid var(--border); vertical-align: middle; }tr:last-child td { border: 0; }td strong { font-weight: 550; }.detail { display: block; margin-top: .3rem; font-size: .8rem; overflow-wrap: anywhere; max-width: 24rem; }.healthy { color: #a2e6c6; }.unhealthy { color: #ffb3ad; }td button { font-size: .85rem; }
	.modal::backdrop { background: #020711ce; }.modal { color: var(--text); margin: auto; width: min(100%, 32rem); box-shadow: 0 20px 70px #0008; }.modal p { line-height: 1.65; }.modal-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
