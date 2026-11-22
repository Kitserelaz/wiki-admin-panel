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
