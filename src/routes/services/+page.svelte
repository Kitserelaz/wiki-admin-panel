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

	type ServiceKind = Service['kind'];
	type SortKey = 'name' | 'state' | 'health' | 'uptimeSeconds' | 'restarts' | 'cpuPercent' | 'memoryBytes';
	type Sort = { key: SortKey; direction: 'ascending' | 'descending' };
	const serviceKinds: ServiceKind[] = ['host', 'container'];
	const columns: { key: SortKey; label: string }[] = [
		{ key: 'name', label: 'Service' },
		{ key: 'state', label: 'State' },
		{ key: 'health', label: 'Health' },
		{ key: 'uptimeSeconds', label: 'Uptime' },
		{ key: 'restarts', label: 'Auto restarts' },
		{ key: 'cpuPercent', label: 'CPU' },
		{ key: 'memoryBytes', label: 'Memory' }
	];
	let sorts = $state<Record<ServiceKind, Sort>>({
		host: { key: 'name', direction: 'ascending' },
		container: { key: 'name', direction: 'ascending' }
	});
	let sortedServices = $derived({ host: sortServices('host'), container: sortServices('container') });

	function healthLabel(service: Service) {
		if (service.health) return service.health;
		if (['unknown', 'missing', 'ambiguous'].includes(service.state)) return 'Unavailable';
		return service.kind === 'host' ? 'Not configured' : 'No health check';
	}
	function sortServices(kind: ServiceKind) {
		const sort = sorts[kind];
		return (services?.items.filter((service) => service.kind === kind) || []).sort((left, right) => {
			const a = sort.key === 'health' ? healthLabel(left) : left[sort.key];
			const b = sort.key === 'health' ? healthLabel(right) : right[sort.key];
			if (a == null && b != null) return 1;
			if (b == null && a != null) return -1;
			let comparison = 0;
			if (typeof a === 'number' && typeof b === 'number') comparison = a - b;
			if (typeof a === 'string' && typeof b === 'string') comparison = a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
			if (comparison) return sort.direction === 'ascending' ? comparison : -comparison;
			return left.name.localeCompare(right.name, 'en', { numeric: true });
		});
	}
	function changeSort(kind: ServiceKind, key: SortKey) {
		const current = sorts[kind];
		sorts[kind] = { key, direction: current.key === key && current.direction === 'ascending' ? 'descending' : 'ascending' };
	}


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
<div class="page-heading">
	<div><h1>Services</h1><p>Updated {time(services?.collectedAt)}</p></div>
	{#if stale}<span class="status warn">Stale data</span>{/if}
</div>
{#if failure}<div class="notice" role="status">{failure}</div>{/if}
{#if services?.errors.length}
	<div class="notice" role="status">{#each services.errors as message}<p>{message}</p>{/each}</div>
{/if}
{#if activeOperations.length}
	<div class="notice" role="status">Restart {activeOperations[0].status} for {activeOperations[0].target.replace(/^(unit:|container:)/, '')}.</div>
{/if}

{#each serviceKinds as kind}
	<section class="service-section">
		<h2>{kind === 'host' ? 'Host services' : 'Production containers'}</h2>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">A dash in the health column means no health check is configured.</caption>
				<thead><tr>
					{#each columns as column}
						<th class="sortable" scope="col" aria-sort={sorts[kind].key === column.key ? sorts[kind].direction : 'none'}>
							<button type="button" onclick={() => changeSort(kind, column.key)} aria-label={`Sort by ${column.label}, ${sorts[kind].key === column.key && sorts[kind].direction === 'ascending' ? 'descending' : 'ascending'}`}>
								{column.label}
								{#if sorts[kind].key === column.key}<span class="sort-direction" aria-hidden="true">{sorts[kind].direction === 'ascending' ? 'Asc' : 'Desc'}</span>{/if}
							</button>
						</th>
					{/each}
					<th scope="col"><span class="sr-only">Actions</span></th>
				</tr></thead>
				<tbody>
					{#each sortedServices[kind] as service (service.target)}
						<tr>
							<td><strong>{service.name}</strong>{#if service.detail && service.detail !== 'running' && service.detail !== service.state}<span class="muted detail">{service.detail}</span>{/if}</td>
							<td><span class="status" class:good={['active','running'].includes(service.state)} class:bad={['failed','exited','dead','missing'].includes(service.state)} class:warn={['unknown','ambiguous','restarting','paused'].includes(service.state)}>{service.state}</span></td>
							<td><span title={healthLabel(service)} class:healthy={service.health === 'healthy'} class:unhealthy={service.health === 'unhealthy'}>{!service.health && !['unknown','missing','ambiguous'].includes(service.state) ? '—' : healthLabel(service)}</span></td>
							<td>{duration(service.uptimeSeconds)}</td>
							<td>{service.restarts ?? 'Unavailable'}</td>
							<td>{percent(service.cpuPercent)}</td>
							<td>{bytes(service.memoryBytes)}</td>
							<td class="row-action"><button class="quiet" disabled={!service.restartable || !canRestart} onclick={() => choose(service)} aria-label={`Restart ${service.name}`}>Restart</button></td>
						</tr>
					{:else}<tr><td colspan="8" class="muted">Awaiting service inventory</td></tr>{/each}
				</tbody>
			</table>
		</div>
	</section>
{/each}
<p class="muted footnote">CPU is measured per core and can exceed 100%.</p>

{#if operations.length}
	<details class="history" open={activeOperations.length > 0 || operations[0]?.status === 'failed'}>
		<summary>Restart history</summary>
		<div class="table-wrap"><table>
			<thead><tr><th>Requested</th><th>Target</th><th>Operator</th><th>Status</th><th><span class="sr-only">Details</span></th></tr></thead>
			<tbody>{#each operations as operation (operation.id)}
				<tr>
					<td>{time(operation.created)}</td><td>{operation.target.replace(/^(unit:|container:)/, '')}</td><td>{operation.actor}</td>
					<td><span class="status" class:good={operation.status === 'succeeded'} class:bad={operation.status === 'failed'} class:warn={['queued','running'].includes(operation.status)}>{operation.status}</span>{#if operation.status === 'failed'}<p class="detail">{operation.result}</p>{/if}</td>
					<td><details class="operation-detail"><summary>Details</summary><p>{operation.result}</p><code>{operation.id}</code>{#if operation.started}<p class="muted">Started {time(operation.started)}</p>{/if}{#if operation.finished}<p class="muted">Finished {time(operation.finished)}</p>{/if}</details></td>
				</tr>
			{/each}</tbody>
		</table></div>
	</details>
{/if}

<dialog bind:this={dialog} class="modal" aria-labelledby="restart-title" oncancel={(event) => { if (submitting) event.preventDefault(); else selected = null; }}>
	{#if selected}
		<h2 id="restart-title">Restart {selected.name}?</h2>
		<p>{impact(selected)}</p>
		{#if submissionError}<div class="notice" role="alert">{submissionError} Retry submits the same operation ID.</div>{/if}
		<div class="modal-actions"><button class="quiet" disabled={submitting} onclick={() => { selected = null; }}>Cancel</button><button disabled={submitting || stale || !!failure || activeOperations.length > 0} onclick={submit}>{submitting ? 'Submitting…' : 'Confirm restart'}</button></div>
	{/if}
</dialog>

<style>
	.service-section { margin-top: 1.75rem; }
	.service-section > h2 { margin-bottom: .8rem; }
	.table-wrap { overflow-x: auto; border-top: 1px solid var(--border); }
	table { width: 100%; border-collapse: collapse; text-align: left; font-size: .875rem; }
	th { font-weight: 400; color: var(--muted); }
	th, td { padding: .7rem .75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
	th:first-child, td:first-child { padding-left: 0; }
	th:last-child, td:last-child { padding-right: 0; }
	th.sortable { padding: 0; }
	th.sortable button { display: flex; align-items: center; gap: .5rem; width: 100%; padding: .7rem .75rem; border: 0; border-radius: 0; color: inherit; text-align: left; white-space: nowrap; }
	th.sortable:first-child button { padding-left: 0; }
	th.sortable button:hover { color: var(--text); background: transparent; }
	th.sortable button:focus-visible { outline-offset: -3px; }
	th[aria-sort='ascending'], th[aria-sort='descending'] { color: var(--text); }
	.sort-direction { color: var(--muted); font-size: .875rem; }
	td strong { font-weight: 500; }
	.detail { display: block; margin: .25rem 0 0; font-size: .875rem; overflow-wrap: anywhere; max-width: 28rem; }
	.healthy { color: #a4cdb9; }
	.unhealthy { color: #e5aaa5; }
	.row-action { text-align: right; }
	.footnote { font-size: .875rem; margin: .8rem 0 0; }
	.history { margin-top: 2rem; }
	.history > summary { cursor: pointer; padding: .75rem 0; font-size: .875rem; }
	.operation-detail { min-width: 5rem; max-width: 28rem; font-size: .875rem; }
	.operation-detail summary { cursor: pointer; color: var(--muted); }
	.operation-detail code { overflow-wrap: anywhere; }
	.operation-detail p { margin: .5rem 0; }
	.modal { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 1.5rem; width: min(calc(100% - 2rem), 30rem); max-height: calc(100dvh - 2rem); margin: auto; }
	.modal::backdrop { background: #0009; }
	.modal p { line-height: 1.65; }
	.modal-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
