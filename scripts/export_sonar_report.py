#!/usr/bin/env python3
"""Write the latest SonarQube result for this project to SONARQUBE.md, using live API data only."""
import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
PROJECT = os.environ.get('SONAR_PROJECT_KEY', 'docker')
HOST = os.environ.get('SONAR_HOST_URL', 'http://127.0.0.1:9000').rstrip('/')
MEASURES = {
    'coverage': 'Coverage (%)', 'new_coverage': 'Coverage on new code (%)',
    'duplicated_lines_density': 'Duplicated lines (%)', 'new_duplicated_lines_density': 'Duplicated lines on new code (%)',
    'bugs': 'Bugs', 'vulnerabilities': 'Vulnerabilities', 'code_smells': 'Code smells',
    'security_hotspots': 'Security hotspots', 'new_violations': 'New issues', 'ncloc': 'Lines of code',
}


def fetch(path, **params):
    request = Request(f'{HOST}{path}?{urlencode(params)}')
    token = base64.b64encode((os.environ['SONAR_TOKEN'] + ':').encode()).decode()
    request.add_header('Authorization', 'Basic ' + token)
    with urlopen(request, timeout=30) as response:  # noqa: S310 - the host is the configured scanner server
        return json.load(response)


def main():
    status = fetch('/api/qualitygates/project_status', projectKey=PROJECT)['projectStatus']
    found = fetch('/api/measures/component', component=PROJECT, metricKeys=','.join(MEASURES))['component']['measures']
    values = {item['metric']: item.get('value', item.get('period', {}).get('value', 'n/a')) for item in found}
    issues = fetch('/api/issues/search', componentKeys=PROJECT, statuses='OPEN,CONFIRMED,REOPENED', ps=100)
    lines = ['# SonarQube results', '',
             f"**Quality gate: {'PASSED' if status['status'] == 'OK' else 'FAILED'}**", '',
             f"Exported {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC with `scripts/export_sonar_report.py` from the project's own SonarQube server.", '',
             '## Gate conditions', '', '| Condition | Result | Value | Limit |', '| --- | --- | --- | --- |']
    lines += [f"| {item['metricKey']} | {item['status']} | {item.get('actualValue', 'n/a')} | {item.get('errorThreshold', 'n/a')} |" for item in status['conditions']]
    lines += ['', '## Measures', '', '| Measure | Value |', '| --- | --- |']
    lines += [f"| {label} | {values.get(key, 'n/a')} |" for key, label in MEASURES.items()]
    lines += ['', f"## Open issues ({issues['total']})", '']
    if issues['issues']:
        lines += ['| Severity | Rule | File | Line | Message |', '| --- | --- | --- | --- | --- |']
        lines += [f"| {item['severity']} | {item['rule']} | {item['component'].split(':', 1)[-1]} | {item.get('line', '')} | {item['message']} |" for item in issues['issues']]
    else:
        lines.append('None.')
    (ROOT / 'SONARQUBE.md').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
