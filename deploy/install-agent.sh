#!/bin/sh
# Run as root from the checked-out repository on the production host.
set -eu
cd "$(dirname "$0")/.."
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer as root'; exit 1; fi
getent group wiki-admin-panel >/dev/null
install -d -m 755 /usr/local/libexec
/opt/bun/bun-linux-x64/bun build deploy/agent.ts --target=bun --outfile=/usr/local/libexec/cloudwiki-admin-agent.js
chmod 644 /usr/local/libexec/cloudwiki-admin-agent.js
# Generate only the service inventory. Credentials from Compose stay in this process.
python3 - <<'PY'
import json, os, subprocess, tempfile
from pathlib import Path
result = subprocess.run(['python3', 'scripts/compose', '--env-file', '/var/www/.env.production', 'config', '--format', 'json'], cwd='/var/www', capture_output=True, text=True, check=True)
config = json.loads(result.stdout)
if config.get('name') != 'cloudwiki-production':
    raise SystemExit('Unexpected Compose project')
services = sorted(name for name, service in config['services'].items() if not service.get('profiles'))
if not services:
    raise SystemExit('Production inventory is empty')
fd, temporary = tempfile.mkstemp(prefix='.cloudwiki-agent-', dir='/etc')
try:
    with os.fdopen(fd, 'w') as output:
        json.dump({'project': 'cloudwiki-production', 'services': services}, output)
        output.write('\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, '/etc/cloudwiki-admin-agent.json')
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
install -m 644 deploy/cloudwiki-admin-agent.service /etc/systemd/system/cloudwiki-admin-agent.service
systemctl daemon-reload
systemctl enable cloudwiki-admin-agent.service
systemctl restart cloudwiki-admin-agent.service
