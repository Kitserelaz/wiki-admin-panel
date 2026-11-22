#!/bin/sh
# Bootstrap the fixed deployment controller from the reviewed production checkout.
set -eu
cd "$(dirname "$0")/.."
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
bun=/opt/bun/bun-linux-x64/bun
"$bun" deploy/deployment-worker.ts --begin-install
systemctl stop cloudwiki-deployment-worker.service 2>/dev/null || true
id wiki-admin-build >/dev/null 2>&1 || useradd --system --home-dir /var/cache/wiki-admin-build --shell /usr/sbin/nologin wiki-admin-build
install -d -m 700 -o wiki-admin-build -g wiki-admin-build /var/cache/wiki-admin-build
install -d -m 700 /var/lib/cloudwiki-deployment
install -d -m 755 /opt/wiki-admin-panel-releases /opt/wiki-admin-panel-deployment
if [ ! -d /opt/wiki-admin-panel-deployment/build-tools ]; then
    cp -a /var/lib/cloudwiki/admin/build-tools /opt/wiki-admin-panel-deployment/build-tools
    chmod -R a+rX /opt/wiki-admin-panel-deployment/build-tools
fi
install -m 644 deploy/vite.production.config.mts /opt/wiki-admin-panel-deployment/vite.config.mts
install -m 644 deploy/farm-control.py /usr/local/libexec/cloudwiki-farm-control.py
"$bun" build deploy/deployment-worker.ts --target=bun --outfile=/usr/local/libexec/cloudwiki-deployment-worker.js
chmod 644 /usr/local/libexec/cloudwiki-deployment-worker.js
install -m 644 deploy/cloudwiki-deployment-worker.service /etc/systemd/system/cloudwiki-deployment-worker.service
sh deploy/install-agent.sh
systemctl daemon-reload
systemctl enable cloudwiki-deployment-worker.service
