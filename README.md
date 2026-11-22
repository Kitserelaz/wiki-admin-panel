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
