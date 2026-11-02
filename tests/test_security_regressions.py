import socket
import os
import subprocess
import sys
import sqlite3
import asyncio
import io

import pytest

from app.mcp_command_policy import validate_stdio_config
from app.decisions_buddy import watsonx_inference as inference
from app import safe_http
from app.mcp_oauth import popup_response
from app.mcp_broker import TRUSTED_MODULE_ROOT
from app.conversation_delete import _delete_bob_tasks
from app.postgres_storage import partition_home
from unittest.mock import AsyncMock, patch


def test_mcp_command_and_environment_are_restricted():
    assert validate_stdio_config({'command': 'python3', 'args': ['-m', 'app.mcp_search'], 'env': {'BRAVE_API_KEY': 'key'}}) == ('python3', ['-m', 'app.mcp_search'])
    for config in (
        {'command': 'sh', 'args': ['-c', 'id']},
        {'command': 'python3', 'args': ['-c', 'print(1)']},
        {'command': 'python3', 'args': ['-m', 'app.mcp_search'], 'env': {'PYTHONSTARTUP': '/tmp/payload'}},
        {'command': 'mcp-server-monday-api', 'args': ['--help']},
    ):
        with pytest.raises(ValueError):
            validate_stdio_config(config)


def test_python_safe_path_prevents_workspace_module_shadowing(tmp_path):
    shadow = tmp_path / 'app'
    shadow.mkdir()
    (shadow / '__init__.py').write_text('raise RuntimeError("workspace module loaded")')
    env = {**os.environ, 'PYTHONPATH': TRUSTED_MODULE_ROOT, 'PYTHONSAFEPATH': '1'}
    result = subprocess.run([sys.executable, '-c', 'import app; print(app.__file__)'],
                            cwd=tmp_path, env=env, capture_output=True, text=True, check=True)
    assert str(shadow) not in result.stdout


def test_task_deletion_quotes_table_names_and_binds_ids(tmp_path):
    database = tmp_path / 'tasks.db'
    hostile_id = "x') OR 1=1 --"
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE tasks (id TEXT, parent_id TEXT)')
        db.execute('CREATE TABLE "odd""name" (task_id TEXT)')
        db.executemany('INSERT INTO tasks VALUES (?, NULL)', [(hostile_id,), ('keep',)])
        db.executemany('INSERT INTO "odd""name" VALUES (?)', [(hostile_id,), ('keep',)])
    assert _delete_bob_tasks(database, {hostile_id}, None) == 1
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT id FROM tasks').fetchall() == [('keep',)]
        assert db.execute('SELECT task_id FROM "odd""name"').fetchall() == [('keep',)]


def test_partition_home_keeps_only_related_tasks_for_unusual_id(tmp_path):
    database = tmp_path / '.bob' / 'db' / 'bob.db'
    database.parent.mkdir(parents=True)
    hostile_id = "x') OR 1=1 --"
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE tasks (id TEXT, parent_id TEXT)')
        db.executemany('INSERT INTO tasks VALUES (?, ?)', [('parent', None), (hostile_id, 'parent'), ('other', None)])
    with patch('app.sessions.read_history', return_value=[{'type': 'done', 'session_id': hostile_id}]), \
         patch('app.job_queue.session_done_task_ids', return_value=[]), \
         patch('app.job_queue.session_unique_bob_prompts', return_value=set()):
        partition_home('alice', 'session', tmp_path)
    with sqlite3.connect(database) as db:
        assert {row[0] for row in db.execute('SELECT id FROM tasks')} == {'parent', hostile_id}


def test_spreadsheet_upload_uses_safe_temporary_name():
    from fastapi import UploadFile
    from app.main import upload_session_file
    upload = UploadFile(filename='../../outside.csv', file=io.BytesIO(b'name,value\nexample,1\n'))
    with patch('app.main._save_stored_file', new_callable=AsyncMock):
        result = asyncio.run(upload_session_file('session', upload, {'username': 'alice'}))
    assert result['filename'] == 'outside.csv'
    assert result['summary']['filename'] == 'outside.csv'
    assert result['summary']['columns'] == ['name', 'value']


def test_spreadsheet_upload_parses_excel_and_tsv_with_fixed_temp_name():
    import openpyxl
    from fastapi import UploadFile
    from app.main import upload_session_file
    workbook = openpyxl.Workbook()
    workbook.active.append(['name', 'value'])
    content = io.BytesIO()
    workbook.save(content)
    for filename, data in [('sample.xlsx', content.getvalue()), ('sample.tsv', b'name\tvalue\nexample\t1\n')]:
        upload = UploadFile(filename=filename, file=io.BytesIO(data))
        with patch('app.main._save_stored_file', new_callable=AsyncMock):
            result = asyncio.run(upload_session_file('session', upload, {'username': 'alice'}))
        assert result['summary']['filename'] == filename
        assert 'error' not in result['summary']


def test_watsonx_blocks_private_dns_and_unsafe_urls(monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])
    with pytest.raises(ValueError):
        safe_http.resolve('attacker.example', 443)
    for url in ('http://example.com', 'https://127.0.0.1', 'https://user@example.com', 'https://example.com:8080'):
        with pytest.raises(ValueError):
            inference._validate_watsonx_url(url)


def test_oauth_popup_encodes_untrusted_values():
    response = popup_response('https://example.com', '</script><script>alert(1)</script>', message='<img src=x onerror=alert(1)>')
    body = response.body.decode()
    assert '</script><script>alert(1)</script>' not in body
    assert '<img src=x' not in body
    assert '&lt;img' in body
