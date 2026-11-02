#!/usr/bin/env python3
"""Deploy core alone, add selected plugins, or release one selected component.

The saved installation manifest contains feature choices only, never credentials.
Use --check to validate Compose without building, deploying or saving choices.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / 'deploy' / 'buddy-installation.json'
FEATURES = {'office', 'people', 'projects', 'decisions', 'learning'}


def normalized_features(features):
    # Saved pre-rename installation choices remain valid until the first
    # successful DecisionsBuddy deployment writes the updated manifest.
    result = sorted({'decisions' if feature == 'zen' else feature for feature in features})
    if not set(result) <= FEATURES:
        raise ValueError('The installation includes an unknown feature')
    return result


def configuration(features, https=False, remote=False):
    features = normalized_features(features)
    command = ['docker', 'compose', '-f', 'docker-compose.remote.yml' if remote else 'docker-compose.yml']
    for feature in sorted(features):
        command += ['-f', f'docker-compose.{feature}.yml']
    if https:
        command += ['-f', 'docker-compose.https.yml']
    for feature in sorted(features):
        command += ['--profile', feature]
    return command


def targets(features, only=None, https=False):
    features = normalized_features(features)
    result = []
    if only in (None, 'core'):
        result += ['bob-agent', 'bob-worker']
        if https:
            result += ['https-proxy']
    if 'office' in features and only in (None, 'office'):
        result += ['office-plugin']
    if 'learning' in features and only in (None, 'learning'):
        result += ['learning-plugin']
    if 'people' in features and only in (None, 'people'):
        result += ['people-plugin', 'people-worker']
    if 'projects' in features and only in (None, 'projects'):
        result += ['projects-plugin']
    if 'decisions' in features and only in (None, 'decisions'):
        result += ['decisions-plugin']
    return result


def run(command):
    subprocess.run(command, cwd=ROOT, check=True)


def retain_frontend_assets(command):
    """Keep public hashed files in the existing persistent private-data mount."""
    result = subprocess.run(command + ['ps', '-q', 'bob-agent'], cwd=ROOT,
                            check=True, capture_output=True, text=True)
    containers = result.stdout.split()
    if any(not re.fullmatch(r'[0-9a-f]{12,64}', container) for container in containers):
        raise ValueError('Compose returned an invalid container ID')
    if not containers:
        return
    archive = ROOT / '.bob-private' / 'frontend-assets'
    archive.mkdir(parents=True, exist_ok=True, mode=0o700)
    for container in containers:
        run(['docker', 'cp', f'{container}:/opt/bob-a2a/app/static/dist/assets/.', str(archive)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--features', nargs='*', choices=sorted(FEATURES), default=None,
                        help='Enabled plugins; omit to retain saved choices; empty means core only')
    parser.add_argument('--https', action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument('--remote', action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument('--build-runtime', action='store_true', help='Build a new shared runtime SDK image first')
    parser.add_argument('--build', action='store_true', help='Build selected component images')
    parser.add_argument('--pull', action='store_true', help='Pull selected prebuilt release images')
    parser.add_argument('--only', choices=['core', *sorted(FEATURES)], help='Release one component without recreating the others')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.build and args.pull:
        parser.error('Choose --build or --pull')
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    if previous:
        previous['features'] = normalized_features(previous.get('features', []))
    features = normalized_features(args.features if args.features is not None else previous.get('features', []))
    https = args.https if args.https is not None else previous.get('https', False)
    remote = args.remote if args.remote is not None else previous.get('remote', False)
    desired = {'version': 1, 'features': features, 'https': https, 'remote': remote}
    if args.only:
        if not previous or any(previous.get(k) != desired[k] for k in ('features', 'https', 'remote')):
            parser.error('--only requires an existing installation with unchanged feature choices')
        if args.only != 'core' and args.only not in features:
            parser.error('The selected plugin must already be enabled')
    command = configuration(features, https, remote)
    run(command + ['config', '--quiet'])
    rendered = subprocess.run(command + ['config', '--format', 'json'], cwd=ROOT,
                              check=True, capture_output=True, text=True)
    resolved = json.loads(rendered.stdout)
    if 'office' in features:
        environment = resolved['services']['office-plugin']['environment']
        missing = [key for key in ('BOB_S3_BUCKET', 'BOB_S3_ENDPOINT', 'BOB_S3_ACCESS_KEY_ID',
                                  'BOB_S3_SECRET_ACCESS_KEY', 'OFFICE_JWT_SECRET') if not environment.get(key)]
        if missing:
            parser.error('Office requires these settings in .env: ' + ', '.join(missing))
    if args.check:
        return
    if args.build_runtime:
        runtime = resolved['services']['bob-agent']['build']['args']['BUDDY_RUNTIME_IMAGE']
        run(['docker', 'build', '-f', 'Dockerfile.runtime', '-t', runtime, '.'])
    services = targets(features, args.only, https)
    if args.build:
        build_services = [s for s in services if s not in ('https-proxy', 'people-worker')]
        run(command + ['build'] + build_services)
    if args.pull:
        run(command + ['pull'] + services)
    removed = set(previous.get('features', [])) - set(features)
    if 'people' in removed:
        old = configuration(previous['features'], previous.get('https', False), previous.get('remote', False))
        run(old + ['stop', 'people-worker'])
    if 'bob-agent' in services:
        retain_frontend_assets(command)
    run(command + ['up', '-d', '--wait', '--wait-timeout', '180'] + (['--no-deps'] if args.only else []) + services)
    for feature in sorted(removed):
        old = configuration(previous['features'], previous.get('https', False), previous.get('remote', False))
        run(old + ['stop'] + [{'office': 'office-plugin', 'people': 'people-plugin', 'projects': 'projects-plugin', 'decisions': 'decisions-plugin'}[feature]])
    STATE.parent.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=STATE.parent, delete=False) as output:
        json.dump(desired, output, indent=2)
        output.write('\n')
        temporary = Path(output.name)
    temporary.chmod(0o644)
    temporary.replace(STATE)
    print('Buddy deployment complete: ' + (', '.join(features) if features else 'core only'))


if __name__ == '__main__':
    main()
