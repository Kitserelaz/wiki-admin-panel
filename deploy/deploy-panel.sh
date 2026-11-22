#!/bin/sh
# Manual deployment. No tests or outage simulations are run.
set -eu
cd "$(dirname "$0")/.."
if [ "$(id -u)" -ne 0 ]; then echo 'Run this deployer as root'; exit 1; fi
exec 9>/run/wiki-admin-panel-deploy.lock
flock -n 9 || { echo 'Panel deployment already running'; exit 1; }
bun=/opt/bun/bun-linux-x64/bun
"$bun" install --frozen-lockfile
"$bun" --bun node_modules/vite/bin/vite.js build --config /var/lib/cloudwiki/admin/vite.auth.config.mts --configLoader native
backup="/opt/wiki-admin-panel-build-$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$backup" ]; then echo 'Backup destination exists'; exit 1; fi
restore_needed=1
restore_previous() {
    if [ "$restore_needed" -eq 1 ]; then
        systemctl stop wiki-admin-panel.service || true
        if [ -e "$backup" ]; then
            if [ -e /opt/wiki-admin-panel-build ]; then
                mv /opt/wiki-admin-panel-build "$backup-failed" || true
            fi
            mv "$backup" /opt/wiki-admin-panel-build
        fi
        systemctl start wiki-admin-panel.service
    fi
}
trap restore_previous EXIT
systemctl stop wiki-admin-panel.service
mv /opt/wiki-admin-panel-build "$backup"
mv /opt/wiki-admin-panel-build-next /opt/wiki-admin-panel-build
systemctl start wiki-admin-panel.service
restore_needed=0
trap - EXIT
printf 'Previous panel build retained at %s\n' "$backup"
