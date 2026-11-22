#!/bin/sh
# Manual deployment through the fixed controller. No tests are run.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
exec 9>/run/wiki-admin-panel-deploy.lock
flock -n 9 || { echo 'A panel deployment is already running'; exit 1; }
/opt/bun/bun-linux-x64/bun /usr/local/libexec/cloudwiki-deployment-worker.js --begin-install
was_running=$(systemctl is-active cloudwiki-deployment-worker.service || true)
systemctl stop cloudwiki-deployment-worker.service
resume_worker() {
    if [ "$was_running" = active ]; then systemctl start cloudwiki-deployment-worker.service; fi
}
trap resume_worker EXIT
/opt/bun/bun-linux-x64/bun /usr/local/libexec/cloudwiki-deployment-worker.js --deploy-current
/opt/bun/bun-linux-x64/bun /usr/local/libexec/cloudwiki-deployment-worker.js --finish-install
systemctl start cloudwiki-deployment-worker.service
trap - EXIT
