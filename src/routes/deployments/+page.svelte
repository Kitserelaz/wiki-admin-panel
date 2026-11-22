<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';
	import type { Application, DeploymentSummary, DeploymentJob, DeploymentRequest, Review, Release } from '#lib/deployments.ts';
	import { pollVisible, readApi } from '#lib/polling.ts';
	import { time } from '#lib/format.ts';
	let { data }: PageProps = $props();
	let summary = $derived(data.summary);
	let application = $state<Application>('panel');
	let failure = $state('');
	let submitting = $state(false);
	let confirmation = $state<{ request: DeploymentRequest; title: string; description: string } | null>(null);
	let dialog = $state<HTMLDialogElement>();
	let requestId = $state('');
	let requestError = $state('');
	let review = $state<Review | null>(null);
	let selectedFiles = $state<string[]>([]);
	let commitMessage = $state('');
	let baselineBackup = $state('');
	let reviewingJob = $state<string | null>(null);
	let logJob = $state<string | null>(null);
	let logText = $state('');
	let truncated = $state(false);
	let busy = $derived(submitting || !!summary?.jobs.some((job) => job.status === 'queued' || job.status === 'running'));
	let ready = $derived(!!summary?.workerActive && !summary?.maintenance && !busy && !failure);
	let update = $derived(summary?.updates[application]);
	let current = $derived(application === 'panel' ? summary?.panel.commit : summary?.mediawiki.sourceCommit);
	let releases = $derived(application === 'panel' ? summary?.panel.releases || [] : summary?.mediawiki.releases || []);
	let history = $derived(summary?.jobs.filter((job) => job.application === application) || []);
	let blocked = $derived(application === 'mediawiki' && (!!summary?.mediawiki.sourceEdits || summary?.mediawiki.configuration?.status !== 'clean'));
	let selectedPaths = $derived(review?.files.filter((file) => selectedFiles.includes(file.id)).map((file) => file.path) || []);
	$effect(() => {
		if (confirmation && dialog && !dialog.open) dialog.showModal();
		if (!confirmation && dialog?.open) dialog.close();
	});
	function switchApplication(next: Application) {
		application = next;
		review = null;
		selectedFiles = [];
		failure = '';
	}
	function confirm(request: DeploymentRequest, title: string, description: string) {
		confirmation = { request, title, description };
		requestId = crypto.randomUUID();
		requestError = '';
	}
	async function send(request: DeploymentRequest, id: string) {
		const response = await fetch('/api/deployments', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...request, confirmed: true }) });
		if (response.redirected) { window.location.assign('/login'); throw new Error('Sign in required'); }
		const body = await response.json();
		if (!response.ok) throw new Error(body.message || 'Operation could not be submitted');
		const job = body as DeploymentJob;
		if (summary) summary = { ...summary, jobs: [job, ...summary.jobs.filter((item) => item.id !== job.id)].slice(0, 50) };
		logJob = job.id;
		logText = '';
		return job;
	}
	async function quick(action: 'check_updates' | 'review_config' | 'review_source') {
		if (!ready) return;
		submitting = true;
		try {
			const operation = await send({ application, action }, crypto.randomUUID());
			if (action.startsWith('review_')) reviewingJob = operation.id;
		} catch (cause) { failure = cause instanceof Error ? cause.message : 'Operation could not be submitted'; }
		finally { submitting = false; }
	}
	async function submitConfirmed() {
		if (!confirmation || submitting) return;
		submitting = true;
		try {
			await send(confirmation.request, requestId);
			confirmation = null;
		} catch (cause) { requestError = cause instanceof Error ? cause.message : 'Submission failed'; }
		finally { submitting = false; }
	}
	async function openReview(id: string) {
		try {
			review = await readApi<Review>(`/api/deployments/reviews/${id}`);
			selectedFiles = [];
			commitMessage = '';
			baselineBackup = '';
		} catch (cause) { failure = cause instanceof Error ? cause.message : 'Review unavailable'; }
	}
	function toggleFile(id: string) {
		selectedFiles = selectedFiles.includes(id) ? selectedFiles.filter((value) => value !== id) : [...selectedFiles, id];
	}
	function selectAll() { selectedFiles = review?.files.filter((file) => file.actionable !== false).map((file) => file.id) || []; }
	function deploy() {
		if (!update) return;
		confirm({ application, action: 'deploy', commit: update.commit }, `Deploy ${application === 'panel' ? 'panel' : 'MediaWiki'} ${short(update.commit)}?`, application === 'panel'
			? 'The current panel stays online while the build runs. Activation restarts the panel and ends all panel sessions. Sign in again to see the result.'
			: 'The existing GitHub production workflow will deploy this exact CI release. The farm will enter maintenance while it takes a recovery snapshot and runs migrations.');
	}
	function rollback(release: Release) {
		confirm({ application, action: 'rollback', release: release.id }, `Roll back to ${short(release.commit)}?`, application === 'panel'
			? 'This activates the retained build without rebuilding. The panel restarts and all operators must sign in again.'
			: 'This requests a compatible application rollback through the existing production workflow. Current database contents and data volumes are preserved. The farm will have a maintenance interruption.');
	}
	function resolve(action: DeploymentRequest['action']) {
		if (!review) return;
		const request: DeploymentRequest = { application: 'mediawiki', action, review: review.id, files: selectedFiles, message: commitMessage, backup: baselineBackup };
		const descriptions: Record<string, [string, string]> = {
			accept_config: ['Accept selected configuration changes?', 'The selected current fingerprints will become approved. Remaining configuration drift continues to block deployment.'],
			initialize_baseline: ['Initialize the configuration baseline?', 'This approves the complete current configuration inventory. Review every listed file before confirming.'],
			restore_baseline: ['Restore the selected baseline backup?', 'The previous baseline will be saved. Any differences from the restored baseline remain visible as configuration drift.'],
			publish_source: ['Publish selected live edits to main?', 'This commits and pushes the selected contents to the MediaWiki main branch. The push triggers existing CI and automatic deployment. Unselected edits remain in production.'],
			discard_source: ['Archive and discard selected edits?', 'A root-only recovery archive will be retained for 30 days. Selected tracked files will be restored to production HEAD and selected untracked files removed. The live editor is paused during the operation.']
		};
		const [title, description] = descriptions[action];
		confirm(request, title, description);
	}
	function reconcile(operation: DeploymentJob) {
		confirm({ ...operation.request }, 'Reconcile the source publication?', 'The worker will inspect the saved publication and complete it without creating a duplicate commit. A completed push can trigger existing CI and automatic deployment. Changed source files require a fresh review.');
	}
	function short(value: string | null | undefined) { return value ? value.slice(0, 12) : 'Unknown'; }
	onMount(() => pollVisible(async (signal) => {
		try {
			const latest = await readApi<DeploymentSummary>('/api/deployments', signal);
			if (signal.aborted) return;
			summary = latest;
			failure = '';
			if (reviewingJob) {
				const operation = latest.jobs.find((job) => job.id === reviewingJob);
				if (operation?.detail?.review && operation.status === 'succeeded') { await openReview(operation.detail.review); reviewingJob = null; }
				else if (operation?.status === 'failed') reviewingJob = null;
			}
			if (logJob) {
				const output = await readApi<{ text: string; truncated: boolean }>(`/api/deployments/jobs/${logJob}/log`, signal);
				if (!signal.aborted) { logText = output.text; truncated = output.truncated; }
			}
		} catch { if (!signal.aborted) failure = 'Deployment worker data is unavailable. Displaying the last recorded state.'; }
	}));
</script>
<svelte:head><title>Deployments · CloudWiki Admin</title></svelte:head>
<div class="page-heading"><div><h1>Deployments</h1><p>Release history and operator-controlled changes</p></div><span class="status" class:good={summary?.workerActive} class:warn={!summary?.workerActive}>{summary?.workerActive ? 'Worker online' : 'Worker unavailable'}</span></div>
<div class="tabs" role="group" aria-label="Application"><button class:chosen={application === 'panel'} aria-pressed={application === 'panel'} onclick={() => switchApplication('panel')}>Bun panel</button><button class:chosen={application === 'mediawiki'} aria-pressed={application === 'mediawiki'} onclick={() => switchApplication('mediawiki')}>MediaWiki farm</button></div>
{#if failure}<div class="notice" role="status">{failure}</div>{/if}
{#if summary?.maintenance}<div class="notice">Deployment services are being installed.</div>{/if}
{#if busy}<div class="notice" role="status">An operation is queued or running. Changes execute one at a time.</div>{/if}
{#if application === 'mediawiki' && !summary?.githubConfigured}<div class="notice">GitHub App configuration is required for publishing and workflow dispatch.</div>{/if}
<div class="release-grid">
	<section class="card"><h2>{application === 'panel' ? 'Running panel build' : 'Live MediaWiki source'}</h2><p class="commit">{short(current)}</p>{#if current}<a href={`https://github.com/Kitserelaz/${application === 'panel' ? 'wiki-admin-panel' : 'mediawiki-www'}/commit/${current}`} target="_blank" rel="noreferrer">View commit on GitHub</a>{:else}<p class="muted">This legacy build has no recorded commit.</p>{/if}
		{#if application === 'mediawiki'}<div class="runtime"><span class="muted">Last recorded release</span><code>{short(summary?.mediawiki.lastSuccess)}</code>{#each Object.entries(summary?.mediawiki.images || {}) as [service, commit]}<span class="muted">{service} runtime image</span><code>{short(commit)}</code>{/each}</div>{/if}
	</section>
	<section class="card"><div class="section-header"><h2>Available update</h2><button disabled={!ready} onclick={() => quick('check_updates')}>Check for updates</button></div>
		{#if update}<p class="commit">{short(update.commit)}</p><p>{update.message}</p><p class="muted small">Checked {time(update.checkedAt)}</p>{#if update.error}<p class="notice">{update.error}</p>{/if}{#if application === 'mediawiki'}<p class="muted">{update.ciReady ? 'Successful CI release available' : 'A successful, unexpired CI release is required'}</p>{/if}
		<button disabled={!ready || (application === 'mediawiki' && update.artifact === 'dashboard-manifest' ? summary?.mediawiki.dashboardCommit : current) === update.commit || blocked || (application === 'mediawiki' && (!summary?.githubConfigured || !update.ciReady))} onclick={deploy}>Deploy this commit</button>
		{:else}<p class="muted">Check GitHub to discover the latest main commit.</p>{/if}
	</section>
</div>
{#if application === 'mediawiki'}
	<section class="card blockers"><h2>Deployment blockers</h2><div class="blocker"><div><strong>Configuration baseline</strong><p class="muted">{summary?.mediawiki.configuration?.status || 'Unavailable'} · {summary?.mediawiki.configuration?.files.length || 0} changed files</p>{#if summary?.mediawiki.configuration?.message}<p>{summary.mediawiki.configuration.message}</p>{/if}</div><button disabled={!ready} onclick={() => quick('review_config')}>Review configuration</button></div><div class="blocker"><div><strong>Local source edits</strong><p class="muted">{summary?.mediawiki.sourceEdits ?? 'Unknown'} deployment-blocking changes</p></div><button disabled={!ready} onclick={() => quick('review_source')}>Review source edits</button></div>
	{#if summary?.mediawiki.progress?.status === 'running'}<p class="notice">Farm deployment stage {summary.mediawiki.progress.stage}</p>{/if}</section>
{/if}
{#if review && application === 'mediawiki'}
	<section class="card review"><div class="section-header"><div><h2>{review.kind === 'config' ? 'Configuration review' : 'Source review'}</h2><p class="muted small">Created {time(review.created)}{#if review.head} · HEAD {short(review.head)}{/if}</p></div><button class="quiet" onclick={() => { review = null; }}>Close review</button></div>
		{#if review.files.length}<div class="selection"><button class="quiet" onclick={selectAll}>Select all supported files</button><button class="quiet" onclick={() => { selectedFiles = []; }}>Clear selection</button><span class="muted">{selectedFiles.length} selected</span></div>{/if}
		{#each review.files as file (file.id)}<article class="review-file"><label><input type="checkbox" checked={selectedFiles.includes(file.id)} disabled={file.actionable === false || busy} onchange={() => toggleFile(file.id)} /><strong>{file.path}</strong><span class="status">{file.status}</span></label>{#if file.note}<p class="muted">{file.note}</p>{/if}{#if review.kind === 'config'}<div class="hashes"><span>Accepted fingerprint <code>{file.before || 'Absent'}</code></span><span>Current fingerprint <code>{file.after || 'Absent'}</code></span></div>{/if}{#if file.diff}<details><summary>View source diff</summary><pre>{file.diff}</pre></details>{/if}</article>{:else}<p class="muted">No changes to resolve.</p>{/each}
		{#if review.kind === 'config'}
			{#if review.baselineStatus === 'valid'}<button disabled={!ready || !selectedFiles.length} onclick={() => resolve('accept_config')}>Accept selected changes</button>{:else}<p class="notice">The baseline is {review.baselineStatus}. Initialization approves the complete displayed inventory.</p><button disabled={!ready} onclick={() => resolve('initialize_baseline')}>Initialize baseline</button>{/if}
			{#if review.baselineBackups?.length}<div class="baseline-restore"><label for="baseline-backup">Baseline backup</label><select id="baseline-backup" bind:value={baselineBackup}><option value="">Select a backup</option>{#each review.baselineBackups as backup}<option value={backup}>{time(Number(backup) / 1e9)}</option>{/each}</select><button disabled={!ready || !baselineBackup} onclick={() => resolve('restore_baseline')}>Restore baseline backup</button></div>{/if}
		{:else}<label class="message-label" for="commit-message">Commit message</label><textarea id="commit-message" rows="3" maxlength="2000" placeholder="Describe the selected live edits" bind:value={commitMessage}></textarea><div class="selection"><button disabled={!ready || !selectedFiles.length || !commitMessage.trim() || !summary?.githubConfigured} onclick={() => resolve('publish_source')}>Publish selected edits</button><button class="quiet" disabled={!ready || !selectedFiles.length} onclick={() => resolve('discard_source')}>Archive and discard selected edits</button></div>{/if}
	</section>
{/if}
<section class="section"><h2>Retained releases</h2><div class="table-wrap card"><table><thead><tr><th>Recorded</th><th>Commit</th><th>Release</th><th>Rollback</th></tr></thead><tbody>{#each releases as release (release.id)}<tr><td>{time(release.created)}</td><td><code>{short(release.commit)}</code>{#if release.active}<span class="status good">Active</span>{/if}{#if release.legacy}<span class="status">Legacy</span>{/if}</td><td class="small">{release.id}</td><td>{#if release.rollbackEligible}<button disabled={!ready || (application === 'mediawiki' && (!summary?.githubConfigured || blocked))} onclick={() => rollback(release)}>Roll back</button>{:else}<span class="muted">{release.reason || (release.active ? 'Current release' : release.legacy ? 'Commit metadata unavailable' : 'Unavailable')}</span>{/if}</td></tr>{:else}<tr><td colspan="4" class="muted">No retained releases recorded</td></tr>{/each}</tbody></table></div></section>
<section class="section"><h2>Operation history</h2><p class="muted small">Last 30 days · most recent 50 operations across applications</p><div class="table-wrap card"><table><thead><tr><th>Requested</th><th>Action</th><th>Operator</th><th>Status</th><th>Result</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>{#each history as operation (operation.id)}<tr><td>{time(operation.created)}<code class="operation-id">{operation.id}</code></td><td>{operation.action.replaceAll('_', ' ')}{#if operation.detail?.commit}<code class="operation-id">{short(operation.detail.commit)}</code>{/if}</td><td>{operation.actor}</td><td><span class="status" class:good={operation.status === 'succeeded'} class:bad={operation.status === 'failed'} class:warn={['queued','running','skipped'].includes(operation.status)}>{operation.status}</span></td><td>{operation.result || String(operation.detail?.phase || 'Waiting for the worker')}{#if operation.detail?.workflowUrl}<a class="workflow-link" href={operation.detail.workflowUrl} target="_blank" rel="noreferrer">Open GitHub workflow</a>{/if}{#if operation.started}<span class="muted operation-id">Started {time(operation.started)}</span>{/if}{#if operation.finished}<span class="muted operation-id">Finished {time(operation.finished)}</span>{/if}</td><td class="actions"><button class="quiet" onclick={() => { logJob = operation.id; logText = ''; }}>View output</button>{#if operation.detail?.review && operation.status === 'succeeded'}<button class="quiet" onclick={() => openReview(operation.detail!.review!)}>Open review</button>{/if}{#if operation.detail?.requiresReconcile}<button disabled={!ready} onclick={() => reconcile(operation)}>Reconcile production</button>{/if}</td></tr>{:else}<tr><td colspan="6" class="muted">No operations recorded</td></tr>{/each}</tbody></table></div></section>
{#if logJob}<section class="card output"><div class="section-header"><h2>Operation output</h2><button class="quiet" onclick={() => { logJob = null; }}>Close output</button></div><code class="muted small">{logJob}</code>{#if truncated}<p class="muted">Showing the most recent 256 KiB of output.</p>{/if}<pre aria-live="off">{logText || 'Waiting for output. Review operations report their result in operation history.'}</pre></section>{/if}
<dialog class="modal card" bind:this={dialog} aria-labelledby="deployment-confirm-title" oncancel={(event) => { if (submitting) event.preventDefault(); else confirmation = null; }}>
	{#if confirmation}<h2 id="deployment-confirm-title">{confirmation.title}</h2><p>{confirmation.description}</p>{#if confirmation.request.files?.length}<ul>{#each selectedPaths as path}<li>{path}</li>{/each}</ul>{/if}{#if requestError}<div class="notice" role="alert">{requestError} Retrying uses the same operation ID.</div>{/if}<div class="modal-actions"><button class="quiet" disabled={submitting} onclick={() => { confirmation = null; }}>Cancel</button><button disabled={submitting || !summary?.workerActive} onclick={submitConfirmed}>{submitting ? 'Submitting…' : 'Confirm'}</button></div>{/if}
</dialog>
<style>
	.tabs { display: flex; gap: .5rem; margin-bottom: 1.5rem; }.tabs .chosen { background: #18383f; border-color: #477b7d; color: var(--accent); }.release-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; }.commit { font: 1.7rem ui-monospace,monospace; letter-spacing: -.035em; margin: 1rem 0; }.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }.runtime { display: grid; grid-template-columns: 1fr auto; gap: .6rem; margin-top: 1.5rem; font-size: .875rem; }.small { font-size: .875rem; }.blockers,.review,.output { margin-top: 1.5rem; }.blocker { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; border-top: 1px solid var(--border); padding-top: 1rem; margin-top: 1rem; }.blocker p { margin: .4rem 0 0; }.section { margin-top: 2rem; }.section > h2 { margin-bottom: 1rem; }.table-wrap { padding: 0; overflow-x: auto; }table { border-collapse: collapse; width: 100%; text-align: left; font-size: .9rem; }th { color: var(--muted); font-size: .85rem; font-weight: 500; background: #172234; }th,td { padding: 1rem; border-bottom: 1px solid var(--border); vertical-align: top; }tr:last-child td { border: 0; }td .status { margin-left: .5rem; }.operation-id { display: block; margin-top: .4rem; font-size: .8rem; max-width: 24rem; overflow-wrap: anywhere; }.workflow-link { display: block; margin-top: .4rem; }.actions button { margin-bottom: .4rem; font-size: .85rem; white-space: nowrap; }.selection { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; margin: 1rem 0; }.review-file { padding: 1rem 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }.review-file label { display: flex; align-items: center; flex-wrap: wrap; gap: .7rem; }.review-file strong { font-weight: 500; font-size: .9rem; }.review-file input { width: 1.1rem; height: 1.1rem; accent-color: var(--accent); }.hashes { display: grid; gap: .5rem; font-size: .85rem; color: var(--muted); margin: .75rem 0; }.hashes code { display: block; overflow-wrap: anywhere; }details { margin-top: .75rem; }summary { cursor: pointer; color: var(--accent); }pre { background: #090f19; border: 1px solid var(--border); border-radius: .5rem; padding: 1rem; font: .875rem/1.6 ui-monospace,monospace; overflow: auto; max-height: 32rem; white-space: pre-wrap; overflow-wrap: anywhere; }textarea,select { background: #0d1522; color: var(--text); border: 1px solid var(--border); border-radius: .4rem; font: inherit; padding: .7rem; }textarea { display: block; width: 100%; margin: .5rem 0 1rem; resize: vertical; }.message-label { display: block; margin-top: 1rem; }.baseline-restore { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }.modal { color: var(--text); width: min(95%,36rem); margin: auto; }.modal::backdrop { background: #020711ce; }.modal p { line-height: 1.7; }.modal li { overflow-wrap: anywhere; }.modal-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
	@media(max-width:850px) { .release-grid { grid-template-columns: 1fr; } }
</style>
