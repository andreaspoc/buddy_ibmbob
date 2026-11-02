"""Deterministic relationship tracing. No inferred delivery dates or invented capacity."""
from collections import deque
from datetime import date, datetime, timezone


def analyze(snapshot, change=None, today=None):
    today = today or datetime.now(timezone.utc).date()
    projects = {p['id']: dict(p) for p in snapshot['projects']}
    people = {p['id']: dict(p) for p in snapshot['people']}
    change = change or {}
    if change.get('kind') == 'person_departure' and change.get('person_id') in people:
        people[change['person_id']].update({k: v for k, v in change.items() if k in ('status', 'departure_date')})
    if change.get('kind') == 'project_change' and change.get('project_id') in projects:
        projects[change['project_id']].update({k: v for k, v in change.items() if k in (
            'name', 'description', 'business_case', 'product_description', 'stage',
            'tolerance_days', 'exception_status', 'tailoring_level',
            'status', 'start_date', 'due_date', 'priority', 'milestone')})
    items = []
    def add(pid, level, reason, evidence, path=None):
        items.append(dict(project_id=pid, level=level, reason=reason, evidence=evidence, path=path or [pid]))
    for assignment in snapshot['assignments']:
        pid = assignment['project_id']
        if projects[pid]['status'] == 'completed':
            continue
        person = people.get(assignment['person_id'])
        if not person or person['status'] == 'active':
            continue
        backup = people.get(assignment.get('backup_person_id'))
        covered = backup and backup['status'] == 'active'
        departed = person['status'] == 'departed'
        level = 'confirmed' if departed and not covered else 'risk'
        reason = ('Responsibility has no active owner or backup' if level == 'confirmed' else
                  'Handover to the listed backup needs confirmation' if covered else 'Departure requires a handover and backup')
        add(pid, level, reason, {'assignment_id': assignment['id'], 'person_id': person['id'],
            'responsibility': assignment['responsibility'], 'backup_person_id': assignment.get('backup_person_id')})
    for pid, project in projects.items():
        if project['status'] == 'paused':
            add(pid, 'confirmed', 'Project is paused', {'status': 'paused'})
        if project.get('exception_status') == 'breached':
            add(pid, 'confirmed', 'PRINCE2 Exception: Project tolerances breached (Board Exception Report required)', {'exception_status': 'breached'})
        elif project.get('exception_status') == 'threatened':
            add(pid, 'risk', 'PRINCE2 Warning: Project tolerances threatened', {'exception_status': 'threatened'})
        project_due = project.get('due_date')
        if project_due:
            if isinstance(project_due, str):
                try:
                    project_due = date.fromisoformat(project_due)
                except ValueError:
                    project_due = None
            if project_due and project['status'] != 'completed' and project_due < today:
                tolerance = project.get('tolerance_days') or 0
                days_over = (today - project_due).days
                if tolerance > 0 and days_over <= tolerance:
                    add(pid, 'risk', f'Project schedule is past target date (+{days_over}d) but within PRINCE2 tolerance (±{tolerance}d)',
                        {'due_date': project_due.isoformat(), 'tolerance_days': tolerance, 'days_over': days_over, 'as_of': today.isoformat()})
                elif days_over > tolerance:
                    add(pid, 'confirmed', f'PRINCE2 Exception: Project schedule exceeds agreed tolerance (+{days_over}d vs ±{tolerance}d)',
                        {'due_date': project_due.isoformat(), 'tolerance_days': tolerance, 'days_over': days_over, 'as_of': today.isoformat()})
        if change.get('kind') == 'project_change' and change.get('project_id') == pid:
            original = next(p for p in snapshot['projects'] if p['id'] == pid)
            differences = {key: {'before': original.get(key), 'after': change[key]}
                for key in ('name', 'description', 'business_case', 'product_description', 'stage',
                            'tolerance_days', 'exception_status', 'tailoring_level',
                            'status', 'start_date', 'due_date', 'priority', 'milestone')
                if key in change and original.get(key) != change[key]}
            if differences:
                add(pid, 'confirmed', 'Recorded project details change', {'changes': differences})
    for work in snapshot.get('work_items', []):
        pid = work['project_id']
        if pid not in projects or projects[pid]['status'] == 'completed':
            continue
        kind, status = work['kind'], work['status']
        evidence = {'work_item_id': work['id'], 'kind': kind, 'title': work['title'], 'status': status,
            'owner_id': work.get('owner_id'), 'due_date': work.get('due_date')}
        owner = people.get(work.get('owner_id'))
        closed = status in ('done', 'resolved', 'approved', 'declined', 'accepted', 'applied')
        if owner and owner['status'] != 'active' and not closed:
            add(pid, 'confirmed' if owner['status'] == 'departed' else 'risk',
                'An open work item has a departed owner' if owner['status'] == 'departed' else 'An open work item needs a departure handover',
                {**evidence, 'person_id': owner['id'], 'owner_status': owner['status']})
        if kind in ('task', 'milestone') and status == 'blocked':
            add(pid, 'confirmed', 'A recorded milestone is blocked' if kind == 'milestone' else 'A recorded task is blocked', evidence)
        elif kind == 'issue' and status != 'resolved':
            add(pid, 'confirmed', 'A recorded issue remains unresolved', evidence)
        elif kind == 'risk' and status != 'resolved':
            add(pid, 'risk', 'A recorded project risk requires review', evidence)
        elif kind == 'decision' and status == 'proposed':
            add(pid, 'risk', 'A proposed decision awaits a recorded outcome', evidence)
        elif kind == 'deliverable' and status == 'quality_review':
            add(pid, 'risk', 'PRINCE2 Product deliverable is awaiting quality review', evidence)
        due = work.get('due_date')
        if isinstance(due, str):
            due = date.fromisoformat(due)
        if kind in ('task', 'deliverable', 'milestone') and status not in ('done', 'accepted') and due and due < today:
            label = {'task': 'An unfinished task is past its recorded due date',
                     'milestone': 'An unfinished milestone is past its recorded target date',
                     'deliverable': 'A product deliverable is past its recorded target date'}[kind]
            add(pid, 'confirmed', label, {**evidence, 'as_of': today.isoformat()})
    outgoing = {}
    for edge in snapshot['dependencies']:
        outgoing.setdefault(edge['source_project_id'], []).append(edge)
    # Preserve each originating evidence chain, and terminate traversal even with cyclic graphs.
    for initial in list(items):
        queue = deque([(initial['project_id'], initial['path'])])
        seen = {initial['project_id']}
        while queue:
            source, path = queue.popleft()
            for edge in outgoing.get(source, []):
                target = edge['target_project_id']
                if target in seen or projects[target]['status'] == 'completed':
                    continue
                seen.add(target)
                next_path = path + [target]
                add(target, 'risk', 'Depends on an affected project; delivery impact needs review',
                    {'dependency_id': edge['id'], 'description': edge['description'],
                     'origin': initial['evidence'], 'source_project_id': source}, next_path)
                queue.append((target, next_path))
    return {'items': items, 'summary': {'confirmed': sum(x['level'] == 'confirmed' for x in items),
             'risks': sum(x['level'] == 'risk' for x in items),
             'affected_projects': len({x['project_id'] for x in items})},
            'limitations': 'Only recorded assignments, work items and dependencies are traced. Risks are not confirmed delays; backup capacity and handover completion require review.'}
