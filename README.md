# CloudWiki admin panel

SvelteKit panel with Discord OAuth sign-in restricted to explicitly allowed Discord user IDs.

## Configuration

Copy `.env.example` to `.env` for development. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and the comma-separated `DISCORD_ALLOWED_USER_IDS`. The names `CLIENT_ID` and `CLIENT_SECRET` are also supported for existing configurations. IDs are parsed as strings. Missing credentials or an empty or malformed allowlist disables sign-in.

Register `https://admin.cloudwiki.us/auth/discord/callback` in the Discord application's OAuth2 redirect list. For local development, also register `http://localhost:5173/auth/discord/callback`.

Only the `identify` scope is requested. Every protected request checks the session and current allowlist. Sessions expire after eight hours and are cleared when the server restarts. Sign-out deletes the server-side session. Production cookies are Secure, HttpOnly, and SameSite=Lax.

## Development

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun test
bun run build
```

## Production

Bun runs the Node adapter build under `wiki-admin-panel.service`. Production loads root-owned `/etc/wiki-admin-panel.env` through systemd's `EnvironmentFile`. Set `ORIGIN=https://admin.cloudwiki.us` and `NODE_ENV=production` in the service environment.

The host's external deployment configuration at `/var/lib/cloudwiki/admin/vite.config.mts` selects `adapter-node` and writes `/opt/wiki-admin-panel-build`. The checkout stays at `/opt/wiki-admin-panel`. Restart the service after deploying a build or changing its environment file.

## Host monitoring and restart agent

The host agent runs in Bun 1.4.5 using `bun:sqlite`. It is a separate systemd service with a Unix socket at `/run/cloudwiki-admin-agent/agent.sock`. Host metrics collect every 10 seconds and retain 24 hours of history. Restart records retain 30 days. The browser pauses polling in hidden tabs.

The root-owned agent exposes only selected metrics and fixed restart targets. The panel's service account can connect to the socket, while the SQLite database under `/var/lib/cloudwiki-admin-agent` stays root-only. The agent has no Docker startup dependency. Container inventory is restricted to the production Compose project and the active, non-profile services recorded at installation.

From `/opt/wiki-admin-panel` on production, manually install or update the agent and deploy the panel:

```sh
sudo sh deploy/install-agent.sh
sudo sh deploy/deploy-panel.sh
```

Run the agent installer again after changing the production service inventory. The panel deployer builds into a staging directory, retains the previous build, and restarts the Bun service. Automatic deployments remain disabled. Restarting the panel clears login sessions. Running agent operations interrupted by an agent restart are marked failed with an uncertain outcome and require inspection before retrying.

Functional acceptance scenarios are documented in `docs/ACCEPTANCE.md` and remain unexecuted.

## Deployment history and resolution controls

The Deployments page separates the panel from the MediaWiki farm. Deploy starts immediately and resolves the latest main commit. Rollback, baseline acceptance, source publishing, and archive-and-discard actions retain their explicit reviews.

The Bun deployment worker runs independently of the panel and uses the agent's root-only SQLite database. GitHub App configuration lives in `/etc/cloudwiki-deployment/github.json` with `appId`, `installationId`, and an absolute `privateKeyFile` inside that root-only directory. Both JSON and PEM must be owned by root with mode `600`. The App needs repository access to `Kitserelaz/mediawiki-www`, Contents write, Actions write, and Workflows write for publishing workflow changes. Tokens are short-lived and stay in the worker.

Install the reviewed deployment controller and build a stamped initial release from the production checkout:

```sh
sudo sh deploy/install-deployments.sh
sudo sh deploy/deploy-panel.sh
```

Subsequent deployments initiated in the UI build the exact latest panel main commit in a separate workspace under `wiki-admin-build`. The fixed controller activates artifacts under `/opt/wiki-admin-panel-releases`. `/opt/wiki-admin-panel-build` becomes the active-release symlink. The last five successful builds are retained, along with the active and previous builds. Existing unstamped directories remain legacy entries.

Native MediaWiki deployment resolves the latest main commit and invokes the fixed local native controller. Deploy starts with one click without a separate update check, confirmation dialog, CI success, or GitHub Actions run. The App token is used only to fetch source; dependency builds run under the limited build account without that token. Failures after database updates require a forward fix. Docker remains the development runtime.

Configuration and source reviews expire after 30 minutes. Pending published-source reconciliation can use its retained review for up to 30 days. Configuration credentials stay metadata-only in the UI. Source credential files, symlinks, and non-file entries require SSH review. Source publication requires production HEAD to match remote main and uses a fast-forward push. Archived discarded edits and baseline backups live under `/var/lib/cloudwiki-deployment` for 30 days, accessible through SSH.

A source recovery archive includes a manifest mapping selected paths to files, their original mode and HEAD, plus staged-state recovery data. Restore selected files and staged entries deliberately from SSH, preserving unrelated live edits. Recompute deployment blockers after any recovery.
