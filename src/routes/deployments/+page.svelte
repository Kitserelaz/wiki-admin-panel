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
	let activeOperation = $derived(summary?.jobs.find((job) => job.status === 'queued' || job.status === 'running'));
	let busy = $derived(submitting || !!activeOperation);
	let ready = $derived(!!summary?.workerActive && !summary?.maintenance && !busy && !failure);
	let update = $derived(summary?.updates[application]);
	let current = $derived(application === 'panel' ? summary?.panel.commit : summary?.mediawiki.sourceCommit);
	let releases = $derived(application === 'panel' ? summary?.panel.releases || [] : summary?.mediawiki.releases || []);
	let history = $derived(summary?.jobs.filter((job) => job.application === application) || []);
	let blocked = $derived(application === 'mediawiki' && (!!summary?.mediawiki.sourceEdits || summary?.mediawiki.configuration?.status !== 'clean'));
	let alreadyDeployed = $derived(!!update && (application === 'panel'
		? summary?.panel.commit === update.commit
		: update.artifact === 'dashboard-manifest'
			? summary?.mediawiki.dashboardCommit === update.commit
			: summary?.mediawiki.sourceCommit === update.commit && summary?.mediawiki.lastSuccess === update.commit && ['php', 'web', 'counter'].every((service) => summary?.mediawiki.images?.[service] === update.commit)));
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
<div class="page-heading"><h1>Deployments</h1></div>
<div class="tabs" role="group" aria-label="Application">
	<button class:chosen={application === 'panel'} aria-pressed={application === 'panel'} onclick={() => switchApplication('panel')}>Panel</button>
	<button class:chosen={application === 'mediawiki'} aria-pressed={application === 'mediawiki'} onclick={() => switchApplication('mediawiki')}>MediaWiki</button>
</div>
{#if failure}<div class="notice" role="status">{failure}</div>{/if}
{#if !summary?.workerActive && !failure}<div class="notice" role="status">Deployment worker unavailable.</div>{/if}
{#if summary?.maintenance}<div class="notice">Deployment services are being installed.</div>{/if}
{#if activeOperation}
	<div class="notice" role="status">{activeOperation.application === 'panel' ? 'Panel' : 'MediaWiki'} · {activeOperation.action.replaceAll('_', ' ')} · {activeOperation.status}{#if activeOperation.detail?.phase} · {String(activeOperation.detail.phase)}{/if}</div>
{/if}
{#if application === 'mediawiki' && !summary?.githubConfigured}<div class="notice">Configure the GitHub App to enable publishing and deployment.</div>{/if}

<div class="release-grid">
	<section>
		<h2>{application === 'panel' ? 'Current build' : 'Live source'}</h2>
		{#if current}
			<p class="commit"><a href={`https://github.com/Kitserelaz/${application === 'panel' ? 'wiki-admin-panel' : 'mediawiki-www'}/commit/${current}`} target="_blank" rel="noreferrer">{short(current)}</a></p>
		{:else}<p class="muted">Commit unavailable</p>{/if}
		{#if application === 'mediawiki'}
			<details class="runtime-details"><summary>Runtime revisions</summary>
				<dl class="runtime"><dt>Last recorded release</dt><dd><code>{short(summary?.mediawiki.lastSuccess)}</code></dd>{#each Object.entries(summary?.mediawiki.images || {}) as [service, commit]}<dt>{service} image</dt><dd><code>{short(commit)}</code></dd>{/each}</dl>
			</details>
		{/if}
	</section>
	<section>
		<div class="section-header"><h2>Updates</h2><button disabled={!ready} onclick={() => quick('check_updates')}>Check updates</button></div>
		{#if update}
			{#if alreadyDeployed}<p class="up-to-date">Up to date</p>
			{:else}
				<p class="commit"><a href={`https://github.com/Kitserelaz/${application === 'panel' ? 'wiki-admin-panel' : 'mediawiki-www'}/commit/${update.commit}`} target="_blank" rel="noreferrer">{short(update.commit)}</a></p>
				<p>{update.message}</p>
				{#if application === 'mediawiki'}<p class="muted small">{update.ciReady ? 'CI release ready' : 'Waiting for a successful CI release'}</p>{/if}
				<button disabled={!ready || blocked || (application === 'mediawiki' && (!summary?.githubConfigured || !update.ciReady))} onclick={deploy}>Deploy</button>
			{/if}
			<p class="muted small">Checked {time(update.checkedAt)}</p>
			{#if update.error}<p class="notice">{update.error}</p>{/if}
		{:else}<p class="muted small">Not checked yet</p>{/if}
	</section>
</div>

{#if application === 'mediawiki'}
	<details class="section manager" open={blocked || !!review}>
		<summary>Configuration and source</summary>
		<div class="blocker">
			<div><strong>Configuration baseline</strong><p class="muted">{summary?.mediawiki.configuration?.status === 'clean' ? 'No changes' : summary?.mediawiki.configuration?.status || 'Unavailable'}{#if summary?.mediawiki.configuration?.files.length} · {summary.mediawiki.configuration.files.length} files{/if}</p>{#if summary?.mediawiki.configuration?.message}<p>{summary.mediawiki.configuration.message}</p>{/if}</div>
			<button disabled={!ready} onclick={() => quick('review_config')}>Review configuration</button>
		</div>
		<div class="blocker"><div><strong>Source edits</strong><p class="muted">{summary?.mediawiki.sourceEdits === 0 ? 'No edits' : `${summary?.mediawiki.sourceEdits ?? 'Unknown'} edits`}</p></div><button disabled={!ready} onclick={() => quick('review_source')}>Review source</button></div>
		{#if summary?.mediawiki.progress?.status === 'running'}<p class="notice">Farm deployment · {summary.mediawiki.progress.stage}</p>{/if}
	</details>
{/if}

{#if review && application === 'mediawiki'}
	<section class="review">
		<div class="section-header"><h2>{review.kind === 'config' ? 'Configuration review' : 'Source review'}</h2><button class="quiet" onclick={() => { review = null; }}>Close</button></div>
		<details class="review-meta"><summary>Review details</summary><p class="muted small">Created {time(review.created)}{#if review.head} · HEAD {short(review.head)}{/if}</p></details>
		{#if review.files.length}<div class="selection"><button class="quiet" onclick={selectAll}>Select all</button><button class="quiet" onclick={() => { selectedFiles = []; }}>Clear</button><span class="muted small">{selectedFiles.length} selected</span></div>{/if}
		{#each review.files as file (file.id)}
			<article class="review-file">
				<label><input type="checkbox" checked={selectedFiles.includes(file.id)} disabled={file.actionable === false || busy} onchange={() => toggleFile(file.id)} /><strong>{file.path}</strong><span class="status">{file.status}</span></label>
				{#if file.note}<p class="muted small">{file.note}</p>{/if}
				{#if review.kind === 'config'}<details><summary>Fingerprints</summary><dl class="hashes"><dt>Accepted</dt><dd><code>{file.before || 'Absent'}</code></dd><dt>Current</dt><dd><code>{file.after || 'Absent'}</code></dd></dl></details>{/if}
				{#if file.diff}<details><summary>Source diff</summary><pre>{file.diff}</pre></details>{/if}
			</article>
		{:else}<p class="muted small">No changes to resolve.</p>{/each}
		{#if review.kind === 'config'}
			{#if review.baselineStatus === 'valid'}<button disabled={!ready || !selectedFiles.length} onclick={() => resolve('accept_config')}>Accept selected</button>
			{:else}<p class="notice">The baseline is {review.baselineStatus}. Initialization approves the complete displayed inventory.</p><button disabled={!ready} onclick={() => resolve('initialize_baseline')}>Initialize baseline</button>{/if}
			{#if review.baselineBackups?.length}
				<details class="baseline-restore"><summary>Restore a baseline backup</summary><div>
					<label class="sr-only" for="baseline-backup">Baseline backup</label><select id="baseline-backup" bind:value={baselineBackup}><option value="">Choose backup</option>{#each review.baselineBackups as backup}<option value={backup}>{time(Number(backup) / 1e9)}</option>{/each}</select>
					<button disabled={!ready || !baselineBackup} onclick={() => resolve('restore_baseline')}>Restore backup</button>
				</div></details>
			{/if}
		{:else}
			<label class="message-label" for="commit-message">Commit message</label><textarea id="commit-message" rows="2" maxlength="2000" bind:value={commitMessage}></textarea>
			<div class="selection"><button disabled={!ready || !selectedFiles.length || !commitMessage.trim() || !summary?.githubConfigured} onclick={() => resolve('publish_source')}>Publish selected</button><button class="quiet" disabled={!ready || !selectedFiles.length} onclick={() => resolve('discard_source')}>Archive and discard</button></div>
		{/if}
	</section>
{/if}

<details class="section">
	<summary>Releases</summary>
	<div class="table-wrap"><table>
		<thead><tr><th>Recorded</th><th>Commit</th><th>Rollback</th></tr></thead>
		<tbody>{#each releases as release (release.id)}<tr>
			<td>{time(release.created)}</td><td><code title={release.id}>{short(release.commit)}</code>{#if release.active}<span class="muted current-label">Current</span>{/if}</td>
			<td>{#if release.rollbackEligible}<button disabled={!ready || (application === 'mediawiki' && (!summary?.githubConfigured || blocked))} onclick={() => rollback(release)}>Roll back</button>{:else}<span class="muted">{release.reason || (release.active ? 'Current release' : release.legacy ? 'Commit metadata unavailable' : 'Unavailable')}</span>{/if}</td>
		</tr>{:else}<tr><td colspan="3" class="muted">No retained releases</td></tr>{/each}</tbody>
	</table></div>
</details>

{#if history.length}
	<details class="section" open={history.some((operation) => operation.status === 'queued' || operation.status === 'running') || history[0]?.status === 'failed'}>
		<summary>Operation history</summary>
		<p class="muted small">Most recent 50 operations across applications · retained for 30 days</p>
		<div class="table-wrap"><table>
			<thead><tr><th>Requested</th><th>Action</th><th>Operator</th><th>Status</th><th><span class="sr-only">Details</span></th></tr></thead>
			<tbody>{#each history as operation (operation.id)}<tr>
				<td>{time(operation.created)}</td><td>{operation.action.replaceAll('_', ' ')}{#if operation.detail?.commit}<code class="detail">{short(operation.detail.commit)}</code>{/if}</td><td>{operation.actor}</td>
				<td><span class="status" class:good={operation.status === 'succeeded'} class:bad={operation.status === 'failed'} class:warn={['queued','running','skipped'].includes(operation.status)}>{operation.status}</span>
					{#if operation.status === 'failed'}<p class="detail">{operation.result}</p>{/if}
					{#if operation.detail?.workflowUrl}<a class="workflow-link" href={operation.detail.workflowUrl} target="_blank" rel="noreferrer">Workflow</a>{/if}
				</td>
				<td class="actions"><button class="quiet" onclick={() => { logJob = operation.id; logText = ''; }}>Output</button>{#if operation.detail?.review && operation.status === 'succeeded'}<button class="quiet" onclick={() => openReview(operation.detail!.review!)}>Open review</button>{/if}{#if operation.detail?.requiresReconcile}<button disabled={!ready} onclick={() => reconcile(operation)}>Reconcile production</button>{/if}
					<details class="operation-detail"><summary>Details</summary><code>{operation.id}</code>{#if operation.status !== 'failed'}<p>{operation.result}</p>{/if}{#if operation.started}<p class="muted">Started {time(operation.started)}</p>{/if}{#if operation.finished}<p class="muted">Finished {time(operation.finished)}</p>{/if}</details>
				</td>
			</tr>{/each}</tbody>
		</table></div>
	</details>
{/if}

{#if logJob}
	<section class="output"><div class="section-header"><h2>Operation output</h2><button class="quiet" onclick={() => { logJob = null; }}>Close</button></div><code class="muted small">{logJob}</code>{#if truncated}<p class="muted small">Showing the most recent 256 KiB.</p>{/if}<pre aria-live="off">{logText || 'Waiting for output'}</pre></section>
{/if}

<dialog class="modal" bind:this={dialog} aria-labelledby="deployment-confirm-title" oncancel={(event) => { if (submitting) event.preventDefault(); else confirmation = null; }}>
	{#if confirmation}<h2 id="deployment-confirm-title">{confirmation.title}</h2><p>{confirmation.description}</p>{#if confirmation.request.files?.length}<ul>{#each selectedPaths as path}<li>{path}</li>{/each}</ul>{/if}{#if requestError}<div class="notice" role="alert">{requestError} Retrying uses the same operation ID.</div>{/if}<div class="modal-actions"><button class="quiet" disabled={submitting} onclick={() => { confirmation = null; }}>Cancel</button><button disabled={submitting || !summary?.workerActive} onclick={submitConfirmed}>{submitting ? 'Submitting…' : 'Confirm'}</button></div>{/if}
</dialog>

<style>
	.tabs { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
	.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: .5rem 0 .7rem; color: var(--muted); }
	.tabs button.chosen { color: var(--text); border-bottom-color: var(--text); }
	.tabs button:hover { background: transparent; color: var(--text); }
	.release-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; padding: .5rem 0 1rem; }
	.release-grid > section + section { border-left: 1px solid var(--border); padding-left: 2rem; }
	.commit { font: 1.5rem ui-monospace, monospace; letter-spacing: -.035em; margin: 1rem 0; }
	.commit a { text-decoration: none; }
	.commit a:hover { text-decoration: underline; }
	.up-to-date { margin: 1rem 0; }
	.section-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
	.small { font-size: .875rem; }
	.runtime-details { margin-top: 1rem; }
	.runtime-details summary, .review-meta summary, .review-file summary, .baseline-restore summary, .operation-detail summary { color: var(--muted); font-size: .875rem; cursor: pointer; }
	.runtime { display: grid; grid-template-columns: 1fr auto; gap: .5rem 1rem; margin-top: .75rem; font-size: .875rem; }
	dt { color: var(--muted); }
	dd { margin: 0; }
	.section { margin-top: 1.5rem; border-top: 1px solid var(--border); }
	.section > summary { cursor: pointer; padding: .9rem 0; font-size: .95rem; }
	.blocker { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; padding: .8rem 0; }
	.blocker strong { font-size: .875rem; font-weight: 500; }
	.blocker p { font-size: .875rem; margin: .25rem 0 0; }
	.review, .output { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
	.review-meta { margin-top: .6rem; }
	.table-wrap { overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; text-align: left; font-size: .875rem; }
	th { color: var(--muted); font-weight: 400; }
	th, td { padding: .7rem .75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
	th:first-child, td:first-child { padding-left: 0; }
	th:last-child, td:last-child { padding-right: 0; }
	.current-label { margin-left: .65rem; font-size: .875rem; }
	.detail { display: block; margin: .3rem 0 0; font-size: .875rem; max-width: 28rem; overflow-wrap: anywhere; }
	.workflow-link { display: block; margin-top: .4rem; }
	.actions button { margin: 0 .25rem .4rem 0; white-space: nowrap; }
	.operation-detail { min-width: 5rem; max-width: 28rem; }
	.operation-detail code { display: block; margin-top: .5rem; overflow-wrap: anywhere; }
	.operation-detail p { font-size: .875rem; margin: .4rem 0; }
	.selection { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; margin: 1rem 0; }
	.review-file { padding: .8rem 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
	.review-file label { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; }
	.review-file strong { font-weight: 400; font-size: .875rem; }
	.review-file input { width: 1rem; height: 1rem; accent-color: var(--accent); }
	.review-file details { margin-top: .6rem; }
	.hashes { display: grid; gap: .35rem; font-size: .875rem; margin: .6rem 0; }
	.hashes code { overflow-wrap: anywhere; }
	pre { background: #0c0e10; border-radius: 4px; padding: 1rem; font: .875rem/1.6 ui-monospace, monospace; overflow: auto; max-height: 32rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	textarea, select { background: var(--background); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font: inherit; font-size: .875rem; padding: .6rem; }
	textarea { display: block; width: 100%; margin: .5rem 0 1rem; resize: vertical; }
	.message-label { display: block; margin-top: 1rem; font-size: .875rem; }
	.baseline-restore { margin-top: 1.25rem; }
	.baseline-restore > div { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; margin-top: .75rem; }
	.modal { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 1.5rem; width: min(calc(100% - 2rem), 34rem); max-height: calc(100dvh - 2rem); margin: auto; }
	.modal::backdrop { background: #0009; }
	.modal p { line-height: 1.65; }
	.modal li { overflow-wrap: anywhere; }
	.modal-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
	@media (max-width: 760px) {
		.release-grid { grid-template-columns: 1fr; gap: 1.5rem; }
		.release-grid > section + section { border-left: 0; padding-left: 0; padding-top: 1.5rem; border-top: 1px solid var(--border); }
	}
</style>
