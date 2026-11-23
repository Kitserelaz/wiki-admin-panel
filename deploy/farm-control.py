#!/usr/bin/env python3
"""Private bridge to the installed farm guard. Input and output are JSON."""
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path('/var/www')
STATE = Path('/var/lib/cloudwiki-deployment')
FARM = Path('/var/lib/cloudwiki')
REPOSITORY = 'https://github.com/Kitserelaz/mediawiki-www.git'
PRIVATE = {'mediawiki/PrivateSettings.php', 'docker/mediawiki/private.php'}


def run(args, cwd=ROOT, data=None, env=None):
    result = subprocess.run(args, cwd=cwd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=120, env=env, check=True)
    return result.stdout


def git(*args, cwd=ROOT, data=None, extra_env=None):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    if extra_env:
        env.update(extra_env)
    return run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.directory=/var/www', '--literal-pathspecs', *args], cwd=cwd, data=data, env=env)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(path):
    try:
        if path.is_symlink():
            return digest(b'symlink\0' + os.readlink(path).encode())
        if not path.is_file():
            return None
        h = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except FileNotFoundError:
        return None


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def guard_module():
    if Path('/etc/cloudwiki/runtime.json').exists():
        spec = importlib.util.spec_from_file_location('native_guard', '/usr/local/libexec/cloudwiki-native.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    spec = importlib.util.spec_from_file_location('farm_guard', '/usr/local/libexec/cloudwiki-deploy-production.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def config_state():
    guard = guard_module()
    path = FARM / guard.CONFIG_BASELINE
    baseline = None
    status = 'missing'
    if path.exists():
        try:
            baseline = json.loads(path.read_text())['files']
            if not isinstance(baseline, dict) or any(not isinstance(k, str) or (v is not None and not isinstance(v, str)) for k, v in baseline.items()):
                raise ValueError()
            status = 'valid'
        except (ValueError, KeyError, TypeError):
            status = 'malformed'
    actual = guard.capture_local_config(ROOT, guard.Runner(ROOT))
    files = []
    for name in sorted(set(baseline or {}) | set(actual)):
        old = (baseline or {}).get(name)
        current = actual.get(name)
        if baseline is None or name not in baseline or name not in actual or old != current:
            files.append({'id': digest(name.encode())[:24], 'path': name, 'before': old, 'after': current,
                          'status': 'removed' if name not in actual else 'added' if name not in (baseline or {}) else 'modified'})
    return {'baselineStatus': status, 'baselineHash': fingerprint(path), 'actual': actual, 'files': files}


def safe_source(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] == '.git':
        raise ValueError('Unsupported source path')
    current = ROOT
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlink source paths require SSH review')
    if current.exists() and not current.is_file():
        raise ValueError('Non-file source paths require SSH review')
    return current


def protected_source(name):
    path = Path(name)
    return name in PRIVATE or path.name.startswith('.env') or any(part in ('secrets', '.aws', '.ssh') for part in path.parts) or path.suffix.lower() in ('.pem', '.key', '.p12')


def source_state():
    head = git('rev-parse', 'HEAD').decode().strip()
    raw = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split(b'\0')
    files = []
    index = 0
    while index < len(raw):
        record = raw[index]
        index += 1
        if not record:
            continue
        status = record[:2].decode()
        name = record[3:].decode('utf8', 'surrogateescape')
        paths = [name]
        if 'R' in status or 'C' in status:
            paths.append(raw[index].decode('utf8', 'surrogateescape'))
            index += 1
        if status == '??' and not name.startswith('mediawiki/'):
            continue
        supported = True
        identities = {}
        for relative in paths:
            try:
                path = safe_source(relative)
                identities[relative] = {'hash': fingerprint(path), 'mode': stat.S_IMODE(path.stat().st_mode) if path.exists() else None}
            except ValueError:
                supported = False
                identities[relative] = {'hash': None, 'mode': None}
        sensitive = any(protected_source(relative) for relative in paths)
        files.append({'id': digest(name.encode('utf8', 'surrogateescape'))[:24], 'path': name,
                      'paths': paths, 'status': status, 'identities': identities,
                      'actionable': supported and not sensitive,
                      'note': 'Protected configuration requires SSH review' if sensitive else '' if supported else 'Non-file or symlink paths require SSH review'})
    return {'head': head, 'files': files, 'indexHash': digest(git('diff', '--cached', '--raw', '-z', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD'))}


def public_review(review):
    return {key: review[key] for key in ('id', 'kind', 'created', 'head', 'baselineStatus', 'baselineBackups', 'files') if key in review}


def review(kind):
    identity = str(uuid.uuid4())
    directory = STATE / 'reviews' / identity
    directory.mkdir(parents=True, mode=0o700)
    state = config_state() if kind == 'config' else source_state()
    result = {'id': identity, 'kind': kind, 'created': int(time.time()), **state}
    if kind == 'config':
        result['baselineBackups'] = [p.stem for p in sorted((STATE / 'baselines').glob('*.json'), reverse=True)[:20]]
    else:
        (directory / 'files').mkdir(mode=0o700)
        diff_budget = 512 * 1024
        for item in result['files']:
            if not item['actionable']:
                continue
            for relative, details in item['identities'].items():
                if details['hash'] is not None:
                    source = safe_source(relative)
                    destination = directory / 'files' / digest(relative.encode())
                    shutil.copy2(source, destination)
                    if fingerprint(destination) != details['hash']:
                        raise ValueError('Source changed during review; refresh the review')
            sizes = sum((safe_source(name).stat().st_size if safe_source(name).exists() else 0) for name in item['paths'])
            for name in item['paths']:
                try:
                    sizes += int(git('cat-file', '-s', result['head'] + ':' + name).decode())
                except subprocess.CalledProcessError:
                    pass
            if sizes > 128 * 1024:
                item['note'] = 'Large change; metadata shown'
                continue
            if item['status'] == '??':
                patch = safe_source(item['path']).read_bytes()[:32769]
            else:
                patch = git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', 'HEAD', '--', *item['paths'])
            if len(patch) <= min(32768, diff_budget) and b'\0' not in patch:
                text = patch.decode('utf8', 'replace')
                # Values on credential-bearing lines are excluded from the browser review.
                text = re.sub(r'(?im)^([^\n]*(?:secret|password|token|authorization)[^\n]*[:=])[^\n]*$', r'\1 [redacted]', text)
                item['diff'] = text
                diff_budget -= len(patch)
            else:
                item['note'] = 'Binary or large change; metadata shown'
    private_write(directory / 'review.json', result)
    return public_review(result)


def load_review(identity, kind):
    if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9-]{36}', identity):
        raise ValueError('Invalid review ID')
    directory = STATE / 'reviews' / identity
    result = json.loads((directory / 'review.json').read_text())
    if result['kind'] != kind or time.time() - result['created'] > (30 * 86400 if (directory / 'published.json').exists() else 1800):
        raise ValueError('Review expired; request a new review')
    return result, directory


def selected_files(review, body):
    identifiers = body.get('files')
    if not isinstance(identifiers, list) or not identifiers or len(identifiers) != len(set(identifiers)):
        raise ValueError('Select one or more reviewed files')
    selected = [item for item in review['files'] if item['id'] in identifiers]
    if len(selected) != len(identifiers):
        raise ValueError('Selection contains an unknown file')
    return selected


def verify_config(review):
    current = config_state()
    for key in ('baselineHash', 'actual', 'files'):
        if current[key] != review[key]:
            raise ValueError('Configuration changed after review; refresh the review')
    return current


def accept_config(body, actor, initialize=False):
    review, directory = load_review(body.get('review'), 'config')
    current = verify_config(review)
    guard = guard_module()
    baseline = FARM / guard.CONFIG_BASELINE
    if initialize:
        if current['baselineStatus'] == 'valid':
            raise ValueError('A valid baseline already exists')
        if any(value is None for value in current['actual'].values()):
            raise ValueError('Required configuration files are missing')
        updated = dict(current['actual'])
        selected = review['files']
    else:
        if current['baselineStatus'] != 'valid':
            raise ValueError('Initialize or restore the baseline first')
        selected = selected_files(review, body)
        updated = json.loads(baseline.read_text())['files']
        for item in selected:
            if item['path'] in current['actual']:
                if item['after'] is None:
                    raise ValueError('A required configuration file is missing')
                updated[item['path']] = item['after']
            else:
                updated.pop(item['path'], None)
    backup = STATE / 'baselines' / (str(time.time_ns()) + '.json')
    if baseline.exists():
        backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(baseline, backup)
        os.utime(backup, None)
    guard.save_config_baseline(FARM, updated, 'Panel review by Discord operator ' + actor)
    return {'message': 'Configuration baseline updated', 'files': selected, 'backup': backup.stem if backup.exists() else None}


def restore_baseline(body, actor):
    review, _ = load_review(body.get('review'), 'config')
    verify_config(review)
    name = body.get('backup', '')
    if not isinstance(name, str) or not re.fullmatch(r'\d+', name):
        raise ValueError('Invalid baseline backup')
    path = STATE / 'baselines' / (name + '.json')
    restored = json.loads(path.read_text())['files']
    if not isinstance(restored, dict):
        raise ValueError('Selected backup is invalid')
    guard = guard_module()
    baseline = FARM / guard.CONFIG_BASELINE
    if baseline.exists():
        saved = STATE / 'baselines' / (str(time.time_ns()) + '.json')
        shutil.copy2(baseline, saved)
        os.utime(saved, None)
    guard.save_config_baseline(FARM, restored, 'Baseline restored by Discord operator ' + actor)
    return {'message': 'Baseline backup restored. Remaining drift must be reviewed.'}


def verify_source(review):
    current = source_state()
    for key in ('head', 'indexHash'):
        if current[key] != review[key]:
            raise ValueError('Source or staged state changed after review; refresh the review')
    old = [{k: item[k] for k in ('id', 'paths', 'status', 'identities', 'actionable')} for item in review['files']]
    new = [{k: item[k] for k in ('id', 'paths', 'status', 'identities', 'actionable')} for item in current['files']]
    if old != new:
        raise ValueError('Source files changed after review; refresh the review')


@contextlib.contextmanager
def pause_editor():
    if Path('/etc/cloudwiki/runtime.json').exists():
        state = subprocess.run(['systemctl', 'is-active', '--quiet', 'cloudwiki-editor.service']).returncode == 0
        try:
            if state: run(['systemctl', 'stop', 'cloudwiki-editor.service'])
            yield
        finally:
            if state: run(['systemctl', 'start', 'cloudwiki-editor.service'])
        return
    containers = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=cloudwiki-production', '--filter', 'label=com.docker.compose.service=code']).decode().split()
    try:
        if containers:
            run(['docker', 'stop', '--time', '30', *containers])
        yield
    finally:
        if containers:
            run(['docker', 'start', *containers])


def archive_source(review, directory, selected, actor):
    destination = STATE / 'archives' / str(uuid.uuid4())
    destination.mkdir(parents=True, mode=0o700)
    (destination / 'files').mkdir(mode=0o700)
    for item in selected:
        for relative, details in item['identities'].items():
            if details['hash'] is not None:
                shutil.copy2(directory / 'files' / digest(relative.encode()), destination / 'files' / digest(relative.encode()))
    index = ROOT / '.git/index'
    if index.exists():
        shutil.copy2(index, destination / 'index')
    paths = sorted({name for item in selected for name in item['paths']})
    with (destination / 'staged.patch').open('wb') as output:
        subprocess.run(['git', '-c', 'safe.directory=/var/www', '--literal-pathspecs', 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', *paths], cwd=ROOT, stdout=output, stderr=subprocess.PIPE, check=True, timeout=120)
    private_write(destination / 'manifest.json', {'actor': actor, 'created': int(time.time()), 'head': review['head'], 'files': selected})
    return destination.name


def discard_source(body, actor):
    review, directory = load_review(body.get('review'), 'source')
    selected = selected_files(review, body)
    if any(not item['actionable'] for item in selected):
        raise ValueError('Selection contains protected or unsupported source files')
    with pause_editor():
        verify_source(review)
        archive = archive_source(review, directory, selected, actor)
        for item in selected:
            verify_paths = item['identities']
            for relative, details in verify_paths.items():
                if fingerprint(safe_source(relative)) != details['hash']:
                    raise ValueError('Source changed during discard. Recovery archive: ' + archive)
            if item['status'] == '??':
                safe_source(item['path']).unlink()
            else:
                git('restore', '--source=HEAD', '--staged', '--worktree', '--', *item['paths'])
    return {'message': 'Selected edits archived and discarded', 'archive': archive, 'files': [item['path'] for item in selected]}


def publish_source(body, actor):
    review, directory = load_review(body.get('review'), 'source')
    selected = selected_files(review, body)
    if any(not item['actionable'] for item in selected):
        raise ValueError('Selection contains protected or unsupported source files')
    message = body.get('message', '').strip()
    if not message or len(message) > 2000:
        raise ValueError('A commit message is required, up to 2000 characters')
    token = os.environ.get('CLOUDWIKI_GITHUB_TOKEN')
    if not token:
        raise ValueError('GitHub App configuration is required')
    auth = 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode()
    network_env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_0': auth}
    published_path = directory / 'published.json'
    with pause_editor():
        verify_source(review)
        paths = sorted({name for item in selected for name in item['paths']})
        publication = directory / 'publication'
        if published_path.exists():
            published = json.loads(published_path.read_text())
            if published['files'] != body['files']:
                raise ValueError('Reconciliation must use the original selection')
            commit = published['commit']
            remote = git('ls-remote', REPOSITORY, 'refs/heads/main', extra_env=network_env).decode().split()[0]
            if remote == review['head'] and not published.get('pushed'):
                git('push', REPOSITORY, 'HEAD:refs/heads/main', cwd=publication, extra_env=network_env)
            elif remote != commit:
                raise ValueError('Remote main changed after publication. The saved publication requires SSH reconciliation.')
            private_write(published_path, {**published, 'pushed': True})
        else:
            remote = git('ls-remote', REPOSITORY, 'refs/heads/main', extra_env=network_env).decode().split()[0]
            if remote != review['head']:
                raise ValueError('Remote main and production HEAD differ. Source edits were preserved; refresh or archive the selection.')
            if publication.exists():
                shutil.rmtree(publication)
            git('clone', '--no-hardlinks', '--no-checkout', str(ROOT), str(publication))
            git('checkout', '--detach', review['head'], cwd=publication)
            for relative in paths:
                target = publication / relative
                source = directory / 'files' / digest(relative.encode())
                if source.exists():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    # Git checkout may have symlinked ancestors; never write through them.
                    for parent in [target, *target.parents]:
                        if parent == publication.parent:
                            break
                        if parent.is_symlink():
                            raise ValueError('Symlink in publication path')
                    shutil.copy2(source, target)
                elif target.exists():
                    target.unlink()
            git('add', '-A', '--', *paths, cwd=publication)
            git('-c', 'user.name=CloudWiki operator ' + actor, '-c', 'user.email=operator-' + actor + '@cloudwiki.us', 'commit', '-m', message, cwd=publication)
            commit = git('rev-parse', 'HEAD', cwd=publication).decode().strip()
            verify_source(review)
            private_write(published_path, {'commit': commit, 'actor': actor, 'files': body['files'], 'pushed': False})
            git('push', REPOSITORY, 'HEAD:refs/heads/main', cwd=publication, extra_env=network_env)
            private_write(published_path, {'commit': commit, 'actor': actor, 'files': body['files'], 'pushed': True})
        try:
            verify_source(review)
            git('fetch', str(publication), commit)
            original_index = ROOT / '.git/index'
            temporary_index = directory / 'publication.index'
            shutil.copy2(original_index, temporary_index)
            for relative in paths:
                tree = git('ls-tree', '-z', commit, '--', relative)
                index_env = {'GIT_INDEX_FILE': str(temporary_index)}
                if tree:
                    header = tree.split(b'\t', 1)[0].decode().split()
                    git('update-index', '--add', '--cacheinfo', header[0], header[2], relative, extra_env=index_env)
                else:
                    git('update-index', '--force-remove', '--', relative, extra_env=index_env)
            verify_source(review)
            lock_path = ROOT / '.git/index.lock'
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                os.close(fd)
                git('update-ref', 'HEAD', commit, review['head'])
                os.replace(temporary_index, original_index)
            finally:
                lock_path.unlink(missing_ok=True)
        except Exception:
            return {'message': 'Commit was published, but production synchronization needs reconciliation', 'commit': commit,
                    'requiresReconcile': True, 'review': review['id'], 'files': body['files']}
    return {'message': 'Selected source edits published to main', 'commit': commit, 'files': paths}



def rollback_problem(record, settings, source_commit, guard):
    if settings is None:
        return 'Runtime compatibility information unavailable'
    commit = record['commit']
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        return 'Recorded commit is invalid'
    try:
        git('cat-file', '-e', commit + '^{commit}')
    except subprocess.CalledProcessError:
        return 'Recorded application source is unavailable'
    if settings.get('MW_NUMERIC_WIKI_IDS') == '1':
        try:
            git('cat-file', '-e', commit + ':docker/mediawiki/wiki-identity.php')
        except subprocess.CalledProcessError:
            return 'Predates the numeric wiki ID migration'
    mode = settings.get('MW_CODE_MODE', 'image')
    if record.get('code_mode', 'image') != mode:
        return 'Uses a different application deployment mode'
    if mode == 'bind':
        strategy = settings.get('MW_BIND_STRATEGY', 'versioned')
        if record.get('bind_strategy') != strategy:
            return 'Uses a different source deployment layout'
        if strategy != 'live' and not (FARM / 'releases' / commit / 'release.json').is_file():
            return 'Retained application source is unavailable'
    if not guard.rollback_approved(FARM, commit, source_commit):
        return 'Compatibility approval required'
    return None


def overview():
    if Path('/etc/cloudwiki/runtime.json').exists():
        result = guard_module().overview()
        result['sourceEdits'] = len(source_state()['files'])
        return result
    result = {'sourceCommit': git('rev-parse', 'HEAD').decode().strip(), 'sourceEdits': 0,
              'configuration': {'status': 'unavailable', 'files': []}, 'releases': [], 'images': {}}
    result['sourceEdits'] = len(source_state()['files'])
    try:
        state = config_state()
        result['configuration'] = {'status': 'clean' if state['baselineStatus'] == 'valid' and not state['files'] else state['baselineStatus'] if state['baselineStatus'] != 'valid' else 'changed', 'files': state['files']}
    except Exception:
        result['configuration']['message'] = 'Configuration inventory unavailable or invalid'
    guard = guard_module()
    settings = None
    try:
        resolved = run(['python3', 'scripts/compose', '--env-file', str(ROOT / '.env.production'), 'config', '--environment']).decode()
        settings = dict(line.split('=', 1) for line in resolved.splitlines() if '=' in line)
    except Exception:
        pass
    for path in sorted((FARM / 'history').glob('deploy-*.json'), reverse=True):
        try:
            record = json.loads(path.read_text())
            commit = record['commit']
            reason = rollback_problem(record, settings, result['sourceCommit'], guard)
            result['releases'].append({'id': path.stem, 'commit': commit,
                'created': int(path.stat().st_mtime), 'rollbackEligible': reason is None,
                'reason': reason})
        except (OSError, ValueError, KeyError):
            continue
    try:
        result['lastSuccess'] = json.loads((FARM / 'last-success.json').read_text())['commit']
    except (OSError, ValueError, KeyError):
        result['lastSuccess'] = None
    try:
        result['dashboardCommit'] = json.loads((FARM / 'diff/dashboard-release.json').read_text()).get('commit')
    except (OSError, ValueError):
        result['dashboardCommit'] = None
    try:
        result['progress'] = json.loads((FARM / 'deployment-progress.json').read_text())
    except (OSError, ValueError):
        result['progress'] = None
    try:
        for service in ('php', 'web', 'counter'):
            ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=cloudwiki-production', '--filter', 'label=com.docker.compose.service=' + service]).decode().split()
            if len(ids) == 1:
                image = run(['docker', 'inspect', '--format', '{{.Image}}', ids[0]]).decode().strip()
                result['images'][service] = run(['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]).decode().strip()
    except Exception:
        result['imagesUnavailable'] = True
    return result


def main():
    os.umask(0o077)
    body = json.load(sys.stdin)
    action = body.get('action')
    if action == 'overview':
        return overview()
    if action in ('review_config', 'review_source'):
        with (FARM / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return review('config' if action == 'review_config' else 'source')
    actor = body.get('actor', '')
    if not re.fullmatch(r'\d{17,20}', actor):
        raise ValueError('Invalid operator identity')
    with (FARM / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == 'accept_config': return accept_config(body, actor)
        if action == 'initialize_baseline': return accept_config(body, actor, initialize=True)
        if action == 'restore_baseline': return restore_baseline(body, actor)
        if action == 'discard_source': return discard_source(body, actor)
        if action == 'publish_source': return publish_source(body, actor)
    raise ValueError('Unknown farm control action')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': main()}))
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok': False, 'message': 'Farm command timed out; inspect current state before retrying'}))
    except subprocess.CalledProcessError:
        print(json.dumps({'ok': False, 'message': 'Farm command failed. Edits were preserved where possible; inspect the operation record and refresh the review.'}))
    except BlockingIOError:
        print(json.dumps({'ok': False, 'message': 'A MediaWiki deployment or resolution is already running'}))
    except Exception as exc:
        message = str(exc) if isinstance(exc, ValueError) else 'Farm operation could not be completed; refresh the review and inspect host logs'
        print(json.dumps({'ok': False, 'message': message}))
