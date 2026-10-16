#!/usr/bin/env python3
"""Run as root on the add-on host after copying this application to /opt/nandico-addon."""
import datetime
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request


def run(*args):
    subprocess.run(args, check=True)


if os.geteuid() != 0:
    raise SystemExit('Run this installer as root on the add-on server.')

app = Path('/opt/nandico-addon')
if not (app / '.env').is_file():
    raise SystemExit('Upload the application and its private production .env first.')

# Use the official Node.js 24 LTS distribution and verify its published SHA256.
node = Path('/usr/local/bin/node')
if not node.exists():
    if os.uname().machine != 'x86_64':
        raise SystemExit('This runtime installer currently supports x86_64 only.')
    base = 'https://nodejs.org/dist/latest-v24.x/'
    checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
    candidates = [line.split() for line in checksums.splitlines()
                  if re.search(r'node-v24\.\d+\.\d+-linux-x64\.tar\.xz$', line)]
    if len(candidates) != 1:
        raise SystemExit('Cannot identify the official Node.js runtime archive.')
    expected, filename = candidates[0]
    with tempfile.TemporaryDirectory(prefix='nandico-node-') as temporary:
        archive = Path(temporary) / filename
        with urllib.request.urlopen(base + filename, timeout=60) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise SystemExit('Node.js archive checksum mismatch.')
        runtime = Path('/opt/nodejs')
        runtime.mkdir(exist_ok=True)
        run('tar', '-xJf', str(archive), '-C', str(runtime))
        node.symlink_to(runtime / filename.removesuffix('.tar.xz') / 'bin/node')

run(str(node), '-e', "const v=process.versions.node.split('.').map(Number); if(v[0]<22||(v[0]===22&&v[1]<13))process.exit(1); require('node:sqlite');")
if subprocess.run(['id', '-u', 'nandico'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
    run('useradd', '--system', '--user-group', '--home-dir', str(app), '--shell', '/usr/sbin/nologin', 'nandico')
for folder in ['data', 'logs']:
    directory = app / folder
    directory.mkdir(mode=0o700, exist_ok=True)
    run('chown', '-R', 'nandico:nandico', str(directory))
run('chown', 'nandico:nandico', str(app / '.env'))
os.chmod(app / '.env', 0o600)

site = Path('/etc/nginx/sites-available/default')
original = site.read_text()
include = '    include /etc/nginx/snippets/nandico-outbox.conf;'
if include not in original:
    pattern = r'(?m)^\s*server_name addon\.nandico\.in;[^\n]*$'
    if len(re.findall(pattern, original)) != 1:
        raise SystemExit('Expected exactly one addon.nandico.in server block; inspect Nginx manually.')
    updated = re.sub(pattern, lambda match: match.group(0) + '\n' + include, original)
else:
    updated = original

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/var/backups/nandico-addon') / stamp
backup.mkdir(parents=True, mode=0o700)
shutil.copy2(site, backup / 'nginx-default')
snippet = Path('/etc/nginx/snippets/nandico-outbox.conf')
if snippet.exists():
    shutil.copy2(snippet, backup / 'nginx-outbox.conf')
shutil.copy2(app / 'deploy/nginx.conf', snippet)
site.write_text(updated)
try:
    run('nginx', '-t')
except subprocess.CalledProcessError:
    site.write_text(original)
    if (backup / 'nginx-outbox.conf').exists():
        shutil.copy2(backup / 'nginx-outbox.conf', snippet)
    else:
        snippet.unlink(missing_ok=True)
    raise

service = Path('/etc/systemd/system/nandico-addon.service')
if service.exists():
    shutil.copy2(service, backup / 'nandico-addon.service')
shutil.copy2(app / 'deploy/nandico-addon.service', service)
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', 'nandico-addon')
run('systemctl', 'restart', 'nandico-addon')
# Confirm application startup before putting the proxy configuration into use.
run('curl', '--fail', '--silent', '--show-error', '--retry', '10', '--retry-connrefused',
    '--retry-delay', '1', '--max-time', '5', 'http://127.0.0.1:3999/health')
run('systemctl', 'reload', 'nginx')
print('\nBackend installed. Nginx backup:', backup)
