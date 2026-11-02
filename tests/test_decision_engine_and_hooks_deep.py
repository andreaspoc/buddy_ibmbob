"""Hermetic unit tests for Decision Engine, Decisions DB & SQLite Migration, and Lifecycle Hooks.

Strictly adheres to the Zero Fake Data Policy. Hermetically mocks all external dependencies,
network sockets, filesystem symlinks, and PostgreSQL databases.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.decisions_buddy import db as decisions_db
from app.decisions_buddy import decision_engine
from app.decisions_buddy import migrate_sqlite
from app import hooks


class MockDbCursor:
    """Mock database connection/cursor for Decisions DB operations."""
    def __init__(self, fetchone_val=None, fetchall_val=None, rowcount=1):
        self.fetchone_val = fetchone_val
        self.fetchall_val = fetchall_val if fetchall_val is not None else []
        self.executed = []
        self.rowcount = rowcount
        self.info = SimpleNamespace(transaction_status=0)

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        if isinstance(self.fetchone_val, list):
            return self.fetchone_val.pop(0) if self.fetchone_val else None
        return self.fetchone_val

    def fetchall(self):
        if isinstance(self.fetchall_val, list) and self.fetchall_val and isinstance(self.fetchall_val[0], list):
            return self.fetchall_val.pop(0)
        return self.fetchall_val

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class DecisionEngineDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/decisions_buddy/decision_engine.py."""

    def test_get_and_set_by_path_edge_cases(self):
        self.assertIsNone(decision_engine.get_by_path(None, "a.b"))
        self.assertEqual(decision_engine.get_by_path({"x": 10}, ""), {"x": 10})
        self.assertEqual(decision_engine.get_by_path({"x": 10}, "$"), {"x": 10})

        data = {"items": [{"price": 10}, {"price": 20}], "matrix": [[1, 2], [3, 4]]}
        self.assertEqual(decision_engine.get_by_path(data, "items[1].price"), 20)
        self.assertEqual(decision_engine.get_by_path(data, "matrix[0][1]"), 2)
        self.assertIsNone(decision_engine.get_by_path(data, "items[5].price"))
        self.assertIsNone(decision_engine.get_by_path(data, "items.invalid"))
        self.assertIsNone(decision_engine.get_by_path("not_a_container", "a.b"))

        # set_by_path root dictionary update ($)
        root = {"a": 1}
        decision_engine.set_by_path(root, "$", {"b": 2})
        self.assertEqual(root, {"a": 1, "b": 2})

        # nested set
        target = {}
        decision_engine.set_by_path(target, "user.profile.age", 30)
        self.assertEqual(target, {"user": {"profile": {"age": 30}}})

    def test_safe_matches_limits(self):
        self.assertFalse(decision_engine._safe_matches(None, ".*"))
        # Pattern exceeding limit raises ValueError
        with self.assertRaises(ValueError):
            decision_engine._safe_matches("subject", "a" * 201)
        # Subject exceeding limit gets truncated safely without error
        long_subject = "a" * 15000 + "target"
        self.assertTrue(decision_engine._safe_matches(long_subject, "^a+"))

    def test_parse_literal_and_loose_equals(self):
        self.assertEqual(decision_engine.parse_literal("true"), True)
        self.assertEqual(decision_engine.parse_literal("false"), False)
        self.assertIsNone(decision_engine.parse_literal("null"))
        self.assertIsNone(decision_engine.parse_literal("none"))
        self.assertEqual(decision_engine.parse_literal("1_000_000"), 1000000)
        self.assertEqual(decision_engine.parse_literal("3.14"), 3.14)
        self.assertEqual(decision_engine.parse_literal('"quoted"'), "quoted")

        # Context fallback lookup
        ctx = {"customer": {"tier": "gold"}}
        self.assertEqual(decision_engine.parse_literal("customer.tier", ctx), "gold")
        self.assertEqual(decision_engine.parse_literal("unknown.field", ctx), "unknown.field")

        # loose_equals
        self.assertTrue(decision_engine.loose_equals(None, None))
        self.assertFalse(decision_engine.loose_equals(None, "abc"))
        self.assertFalse(decision_engine.loose_equals("abc", None))
        self.assertTrue(decision_engine.loose_equals(" ACTIVE ", "active"))
        self.assertTrue(decision_engine.loose_equals("1_000", 1000.0))
        self.assertFalse(decision_engine.loose_equals("text", 123))

    def test_unary_evaluations(self):
        self.assertTrue(decision_engine.evaluate_unary(None, 10)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("-", 10)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("   ", 10)["passed"])

        # Range tests
        self.assertTrue(decision_engine.evaluate_unary("[10..20]", 15)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("[10..20]", 10)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("[10..20]", 20)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("[10..20]", 25)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("(10..20)", 10)["passed"])

        # String literals
        self.assertTrue(decision_engine.evaluate_unary('"INC", "LTD", "LLC"', "LTD")["passed"])
        self.assertFalse(decision_engine.evaluate_unary('"INC", "LTD", "LLC"', "CORP")["passed"])

        # Placeholder '?' or '$'
        self.assertTrue(decision_engine.evaluate_unary("? > 100", 150)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("? > 100", 50)["passed"])

        # Null and boolean checks
        self.assertTrue(decision_engine.evaluate_unary("is null", None)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("is null", 10)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("is not null", 10)["passed"])

    def test_builtins_functions(self):
        b = decision_engine.BUILTINS
        self.assertEqual(b["len"]([1, 2, 3]), 3)
        self.assertEqual(b["len"](None), 0)
        self.assertEqual(b["count"]("hello"), 5)
        self.assertEqual(b["upper"]("abc"), "ABC")
        self.assertEqual(b["lower"]("ABC"), "abc")
        self.assertEqual(b["trim"]("  hi  "), "hi")
        self.assertTrue(b["contains"](["a", "b"], "a"))
        self.assertTrue(b["startsWith"]("foobar", "foo"))
        self.assertTrue(b["endsWith"]("foobar", "bar"))
        self.assertEqual(b["abs"](-42), 42.0)
        self.assertEqual(b["round"](3.14159, 2), 3.14)
        self.assertEqual(b["floor"](3.9), 3)
        self.assertEqual(b["ceil"](3.1), 4)
        self.assertEqual(b["sum"]([10, 20, 30]), 60.0)
        self.assertEqual(b["avg"]([10, 20]), 15.0)
        self.assertEqual(b["min"](5, 2, 8), 2)
        self.assertEqual(b["max"](5, 2, 8), 8)
        self.assertEqual(b["coalesce"](None, None, "found", "ignored"), "found")
        self.assertEqual(b["year"]("2026-10-29T12:00:00"), 2026)
        self.assertEqual(b["diffDays"]("2026-01-01", "2026-01-10"), 9)
        self.assertEqual(b["flatten"]([[1, 2], [3, [4]]]), [1, 2, 3, [4]])
        self.assertEqual(b["unique"]([1, 2, 2, 3]), [1, 2, 3])
        self.assertEqual(b["join"](["a", "b"], "-"), "a-b")
        self.assertEqual(b["split"]("a,b,c", ","), ["a", "b", "c"])
        self.assertEqual(b["replace"]("hello world", "world", "buddy"), "hello buddy")
        self.assertEqual(b["slice"]([1, 2, 3, 4], 1, 3), [2, 3])

    def test_decision_table_hit_policies_and_execution(self):
        # Decision table with 'first' hit policy
        table_node = {
            "id": "dt_1",
            "name": "Discount Matrix",
            "type": "decisionTableNode",
            "content": {
                "hitPolicy": "first",
                "inputs": [{"id": "in_1", "field": "amount"}],
                "outputs": [{"id": "out_1", "field": "discount"}],
                "rules": [
                    {"_id": "r1", "in_1": "> 1000", "out_1": "0.15"},
                    {"_id": "r2", "in_1": "> 500", "out_1": "0.10"},
                    {"_id": "r3", "in_1": "-", "out_1": "0.0"},
                ]
            }
        }
        graph = {
            "nodes": [
                {"id": "input_1", "name": "Input", "type": "inputNode"},
                table_node,
                {"id": "output_1", "name": "Output", "type": "outputNode"},
            ],
            "edges": [
                {"id": "e1", "sourceId": "input_1", "targetId": "dt_1"},
                {"id": "e2", "sourceId": "dt_1", "targetId": "output_1"},
            ]
        }
        engine = decision_engine.DecisionEngine()
        res = engine.evaluate(graph, {"amount": 750})
        self.assertEqual(res["result"]["discount"], 0.10)
        self.assertGreater(len(res["trace"]), 0)

        # 'collect' hit policy
        table_collect = {
            "id": "dt_collect",
            "name": "Badge Collector",
            "type": "decisionTableNode",
            "content": {
                "hitPolicy": "collect",
                "inputs": [{"id": "in_score", "field": "score"}],
                "outputs": [{"id": "out_badge", "field": "badge"}],
                "rules": [
                    {"_id": "r1", "in_score": ">= 50", "out_badge": '"Participant"'},
                    {"_id": "r2", "in_score": ">= 80", "out_badge": '"Achiever"'},
                ]
            }
        }
        graph_collect = {
            "nodes": [
                {"id": "input_1", "name": "Input", "type": "inputNode"},
                table_collect,
                {"id": "output_1", "name": "Output", "type": "outputNode"},
            ],
            "edges": [
                {"id": "e1", "sourceId": "input_1", "targetId": "dt_collect"},
                {"id": "e2", "sourceId": "dt_collect", "targetId": "output_1"},
            ]
        }
        res_collect = engine.evaluate(graph_collect, {"score": 90})
        self.assertEqual(len(res_collect["result"]["results"]), 2)

    def test_expression_nodes_and_cycle_detection(self):
        expr_node = {
            "id": "expr_1",
            "name": "Calculator",
            "type": "expressionNode",
            "content": {
                "expressions": [
                    {"key": "total", "value": "price * quantity"}
                ]
            }
        }
        graph = {
            "nodes": [
                {"id": "in_1", "name": "Input", "type": "inputNode"},
                expr_node,
                {"id": "out_1", "name": "Output", "type": "outputNode"},
            ],
            "edges": [
                {"id": "e1", "sourceId": "in_1", "targetId": "expr_1"},
                {"id": "e2", "sourceId": "expr_1", "targetId": "out_1"},
            ]
        }
        engine = decision_engine.DecisionEngine()
        res = engine.evaluate(graph, {"price": 25, "quantity": 4})
        self.assertEqual(res["result"]["total"], 100)

        # Cycle detection
        cyclic_graph = {
            "nodes": [
                {"id": "n1", "name": "Node 1", "type": "expressionNode", "content": {"expressions": []}},
                {"id": "n2", "name": "Node 2", "type": "expressionNode", "content": {"expressions": []}},
            ],
            "edges": [
                {"id": "e1", "sourceId": "n1", "targetId": "n2"},
                {"id": "e2", "sourceId": "n2", "targetId": "n1"},
            ]
        }
        with self.assertRaises(ValueError) as ctx:
            engine.evaluate(cyclic_graph, {})
        self.assertIn("cycles", str(ctx.exception))

    def test_switch_and_sub_decision_and_function_rejection(self):
        # Function node rejection
        with self.assertRaises(ValueError) as ctx:
            decision_engine.execute_function_node("code", {})
        self.assertIn("Executable function nodes are disabled", str(ctx.exception))

        # Switch node graph
        graph = {
            "nodes": [
                {"id": "in_1", "type": "inputNode"},
                {
                    "id": "sw_1", "type": "switchNode",
                    "content": {
                        "statements": [
                            {"id": "stmt_high", "condition": "score > 80"},
                            {"id": "stmt_low", "condition": "true"},
                        ]
                    }
                },
                {"id": "out_high", "type": "outputNode"},
                {"id": "out_low", "type": "outputNode"},
            ],
            "edges": [
                {"id": "e1", "sourceId": "in_1", "targetId": "sw_1"},
                {"id": "e_h", "sourceId": "sw_1", "targetId": "out_high", "sourceHandle": "stmt_high"},
                {"id": "e_l", "sourceId": "sw_1", "targetId": "out_low", "sourceHandle": "stmt_low"},
            ]
        }
        engine = decision_engine.DecisionEngine()
        res_high = engine.evaluate(graph, {"score": 95})
        self.assertIsNotNone(res_high["result"])

        # Sub-decision node
        child_graph = {
            "nodes": [
                {"id": "c_in", "type": "inputNode"},
                {"id": "c_expr", "type": "expressionNode", "content": {"expressions": [{"key": "bonus", "value": "100"}]}},
                {"id": "c_out", "type": "outputNode"},
            ],
            "edges": [
                {"id": "ce1", "sourceId": "c_in", "targetId": "c_expr"},
                {"id": "ce2", "sourceId": "c_expr", "targetId": "c_out"},
            ]
        }
        parent_graph = {
            "nodes": [
                {"id": "p_in", "type": "inputNode"},
                {"id": "p_sub", "type": "decisionNode", "content": {"key": "child_rule"}},
                {"id": "p_out", "type": "outputNode"},
            ],
            "edges": [
                {"id": "pe1", "sourceId": "p_in", "targetId": "p_sub"},
                {"id": "pe2", "sourceId": "p_sub", "targetId": "p_out"},
            ]
        }
        engine.register_decision("child_rule", child_graph)
        res_parent = engine.evaluate(parent_graph, {})
        self.assertEqual(res_parent["result"]["bonus"], 100)


class DecisionsDbDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/decisions_buddy/db.py."""

    def setUp(self):
        decisions_db._schema_database = None

    def test_init_db_and_connection(self):
        # Missing DATABASE_URL raises RuntimeError
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                decisions_db.init_db()

        # Success init_db
        db_mock = MockDbCursor()
        with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://test/db'}), \
             patch.object(decisions_db, '_connect', return_value=db_mock):
            decisions_db.init_db()
            self.assertTrue(any('CREATE SCHEMA IF NOT EXISTS decisions' in sql for sql, _ in db_mock.executed))
            # Repeat is a no-op due to _schema_database cached check
            db_mock.executed.clear()
            decisions_db.init_db()
            self.assertEqual(len(db_mock.executed), 0)

    def test_get_decisions_access_and_records(self):
        # Anonymous user denied
        with self.assertRaises(PermissionError):
            decisions_db.get_all_decisions(None)
        with self.assertRaises(PermissionError):
            decisions_db.get_all_decisions({'username': ''})

        raw_row = {
            'id': 'd1', 'name': 'Pricing', 'description': 'desc',
            'graph': '{"nodes": [1, 2], "edges": [1]}', 'default_input': '{}',
            'version': 1, 'status': 'draft', 'environment': 'development',
            'updated_at': datetime(2026, 1, 1, tzinfo=timezone.utc), 'updated_by': 'alice',
            'approver': None, 'owner': 'alice', 'access_policy': 'private',
        }
        db = MockDbCursor(fetchall_val=[[raw_row]], fetchone_val=raw_row)
        with patch.object(decisions_db, 'connection', return_value=db):
            all_decisions = decisions_db.get_all_decisions({'username': 'alice'})
            self.assertEqual(len(all_decisions), 1)
            self.assertEqual(all_decisions[0]['nodeCount'], 2)
            self.assertEqual(all_decisions[0]['edgeCount'], 1)

            single = decisions_db.get_decision('d1')
            self.assertEqual(single['id'], 'd1')

    def test_save_and_delete_decision(self):
        db = MockDbCursor()
        # Invalid access policy
        with self.assertRaises(ValueError):
            decisions_db._save(db, 'd1', 'N', 'D', {}, {}, 'sum', 'alice', 'invalid_policy', None, False)

        # Invalid non-dict graph
        with self.assertRaises(ValueError):
            decisions_db._save(db, 'd1', 'N', 'D', "not_dict", {}, 'sum', 'alice', 'private', None, False)

        # Owner mismatch raises PermissionError
        existing_other_owner = {'owner': 'bob', 'version': 1}
        with self.assertRaises(PermissionError):
            decisions_db._check_owner(existing_other_owner, 'alice', is_admin=False)

        # Version mismatch raises RevisionConflict
        with self.assertRaises(decisions_db.RevisionConflict):
            decisions_db._check_version(existing_other_owner, expected_version=2)

        # Successful save
        created_row = {
            'id': 'd1', 'name': 'N', 'description': 'D', 'graph': '{}', 'default_input': '{}',
            'version': 1, 'status': 'draft', 'environment': 'development',
            'updated_at': datetime.now(timezone.utc), 'updated_by': 'alice', 'approver': None,
            'owner': 'alice', 'access_policy': 'private',
        }
        db_save = MockDbCursor(fetchone_val=[None, created_row])  # _locked returns None (new)
        saved = decisions_db._save(db_save, 'd1', 'N', 'D', {}, {}, 'sum', 'alice', 'private', None, False)
        self.assertEqual(saved['id'], 'd1')

        # Delete decision
        db_del = MockDbCursor(fetchone_val=created_row)
        with patch.object(decisions_db, 'connection', return_value=db_del):
            self.assertTrue(decisions_db.delete_decision('d1', author='alice'))

        db_not_found = MockDbCursor(fetchone_val=None)
        with patch.object(decisions_db, 'connection', return_value=db_not_found):
            self.assertFalse(decisions_db.delete_decision('d_missing', author='alice'))

    def test_governance_and_test_suites(self):
        row = {
            'id': 'd1', 'name': 'Pricing', 'version': 1, 'environment': 'development', 'status': 'draft',
            'owner': 'alice', 'graph': {},
        }
        db = MockDbCursor(fetchone_val=[row, {**row, 'status': 'approved'}])
        with patch.object(decisions_db, 'connection', return_value=db):
            updated = decisions_db.update_governance_status('d1', 'approved', author='alice')
            self.assertEqual(updated['status'], 'approved')

        # Test suite CRUD
        suite_row = {'decision_version': 1, 'revision': 2, 'cases': '[]'}
        db_get_suite = MockDbCursor(fetchone_val=suite_row)
        suite = decisions_db.test_suite('d1', db_get_suite)
        self.assertEqual(suite['suiteRevision'], 2)

        db_save_suite = MockDbCursor(fetchone_val=[row, suite_row, suite_row])
        with patch.object(decisions_db, 'connection', return_value=db_save_suite):
            saved_suite = decisions_db.save_test_suite(
                'd1', [{'input': {}, 'expected': {}}],
                expected_version=1, expected_suite_revision=2, actor='alice'
            )
            self.assertEqual(saved_suite['suiteRevision'], 2)

    def test_audit_logging_and_heatmap(self):
        # Anonymous evaluation rejected
        with self.assertRaises(PermissionError):
            decisions_db.log_evaluation('d1', {}, {}, 10.0, 1, [], user_id='anonymous')

        db = MockDbCursor()
        with patch.object(decisions_db, 'connection', return_value=db):
            decisions_db.log_evaluation('d1', {'x': 1}, {'y': 2}, 1500.0, 3, [], user_id='alice')
            self.assertTrue(any('INSERT INTO decisions.audit_logs' in sql for sql, _ in db.executed))

        # Heatmap calculation
        log_rows = [
            {'duration_micros': 1000.0, 'trace_data': [{'ruleTrace': [{'ruleId': 'r1', 'passed': True}]}]},
            {'duration_micros': 2000.0, 'trace_data': [{'ruleTrace': [{'ruleId': 'r1', 'passed': False}]}]},
        ]
        db_heatmap = MockDbCursor(fetchall_val=[log_rows])
        with patch.object(decisions_db, 'connection', return_value=db_heatmap):
            heatmap = decisions_db.compute_rule_heatmap('d1')
            self.assertEqual(heatmap['totalRuns'], 2)
            self.assertEqual(heatmap['ruleHeatmap']['r1']['hitCount'], 1)
            self.assertEqual(heatmap['ruleHeatmap']['r1']['hitPercentage'], 50.0)

    def test_version_snapshots_and_releases(self):
        # get_decision_versions
        version_row = {'id': 1, 'decision_id': 'd1', 'version': 1, 'change_summary': 'Init', 'created_at': datetime(2026, 1, 1, tzinfo=timezone.utc), 'created_by': 'alice'}
        db_vers = MockDbCursor(fetchall_val=[[version_row]])
        with patch.object(decisions_db, 'connection', return_value=db_vers):
            vers = decisions_db.get_decision_versions('d1')
            self.assertEqual(len(vers), 1)
            self.assertEqual(vers[0]['version'], 1)

        # get_version_snapshot
        db_snap = MockDbCursor(fetchone_val={'graph': '{"nodes": []}'})
        with patch.object(decisions_db, 'connection', return_value=db_snap):
            snap = decisions_db.get_version_snapshot('d1', 1)
            self.assertEqual(snap, {'nodes': []})

        # get_release
        release_row = {'decision_id': 'd1', 'version': 1, 'graph_digest': 'abc', 'published_by': 'alice'}
        db_rel = MockDbCursor(fetchone_val=release_row)
        with patch.object(decisions_db, 'connection', return_value=db_rel):
            rel = decisions_db.get_release('d1', 1)
            self.assertEqual(rel['graph_digest'], 'abc')

        # require_passing_tests
        mock_conn = MockDbCursor(fetchone_val=[
            {'decision_version': 1, 'revision': 1, 'cases': [{'input': {}}]},  # test_suite
            {'passed': True},  # test_runs
        ])
        decisions_db.require_passing_tests(mock_conn, {'id': 'd1', 'version': 1, 'graph': {}}, {})

        # record_release
        mock_conn_rel = MockDbCursor(fetchone_val=None)
        decisions_db.record_release(mock_conn_rel, {'id': 'd1', 'version': 1, 'graph': {}}, {}, 'alice')
        self.assertTrue(any('INSERT INTO decisions.releases' in sql for sql, _ in mock_conn_rel.executed))

        # rollback_decision
        current_row = {'id': 'd1', 'name': 'D1', 'description': 'desc', 'version': 2, 'owner': 'alice', 'access_policy': 'private', 'default_input': '{}'}
        snap_row = {'name': 'D1', 'description': 'desc', 'version': 1, 'graph': '{}', 'default_input': '{}'}
        db_rb = MockDbCursor(fetchone_val=[current_row, snap_row, current_row, snap_row])
        with patch.object(decisions_db, 'connection', return_value=db_rb), \
             patch.object(decisions_db, '_save', return_value={'id': 'd1', 'version': 3}):
            rb = decisions_db.rollback_decision('d1', 1, author='alice')
            self.assertEqual(rb['version'], 3)


class DecisionsMigrateSqliteTests(unittest.TestCase):
    """Deep coverage for app/decisions_buddy/migrate_sqlite.py."""

    def test_json_and_timestamp_helpers(self):
        self.assertEqual(migrate_sqlite._json(None, {}), {})
        self.assertEqual(migrate_sqlite._json('{"k": 1}', {}), {'k': 1})
        with self.assertRaises(ValueError):
            migrate_sqlite._json('["list"]', {})  # expected dict, got list

        # Timestamp helper
        with self.assertRaises(ValueError):
            migrate_sqlite._timestamp(12345)
        # Missing timezone
        with self.assertRaises(ValueError):
            migrate_sqlite._timestamp('2026-01-01T12:00:00')
        valid_ts = migrate_sqlite._timestamp('2026-01-01T12:00:00+00:00')
        self.assertEqual(valid_ts, '2026-01-01T12:00:00+00:00')

    def test_read_legacy_valid_and_invalid(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / 'legacy.db'

            # Missing decisions table raises ValueError
            with sqlite3.connect(db_path) as conn:
                conn.execute('CREATE TABLE dummy (id INT)')
            with self.assertRaises(ValueError) as ctx:
                migrate_sqlite.read_legacy(db_path)
            self.assertIn('contains no decisions table', str(ctx.exception))

            # Valid sqlite database
            with sqlite3.connect(db_path) as conn:
                conn.execute('DROP TABLE dummy')
                conn.execute('''CREATE TABLE decisions (
                    id TEXT PRIMARY KEY, name TEXT, description TEXT, graph TEXT, default_input TEXT,
                    version INT, status TEXT, environment TEXT, access_policy TEXT,
                    created_at TEXT, updated_at TEXT, owner TEXT, updated_by TEXT
                )''')
                conn.execute('''INSERT INTO decisions VALUES (
                    'd1', 'Test Decision', 'Desc', '{}', '{}', 1, 'draft', 'development', 'private',
                    '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 'alice', 'alice'
                )''')
            name, fingerprint, rows = migrate_sqlite.read_legacy(db_path)
            self.assertEqual(name, 'legacy.db')
            self.assertIsNotNone(fingerprint)
            self.assertEqual(len(rows['decisions']), 1)
            self.assertEqual(rows['decisions'][0]['id'], 'd1')


class HooksDeepCoverageTests(unittest.TestCase):
    """Deep coverage for app/hooks.py."""

    def test_hook_validation_and_safe_paths(self):
        self.assertEqual(hooks.validate_hook_id("valid-hook_123"), "valid-hook_123")
        with self.assertRaises(ValueError):
            hooks.validate_hook_id("bad hook with spaces")
        with self.assertRaises(ValueError):
            hooks.validate_hook_id("")
        with self.assertRaises(ValueError):
            hooks.validate_hook_id("../path-escape")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            hook_file = hooks._safe_script_path(root, "hook-1")
            self.assertEqual(hook_file.name, "hook-1.sh")

            # Symlink detection
            symlink_dir = root / "symlink_dir"
            os.symlink(root, symlink_dir)
            with self.assertRaises(ValueError):
                hooks._safe_script_path(symlink_dir, "hook-1")

    def test_record_hook_audit(self):
        db = MockDbCursor()
        with patch.object(hooks, '_connect_db') as mock_conn:
            mock_conn.return_value.__enter__.return_value = db
            hooks.record_hook_audit({"username": "admin"}, "delete-hook", "hook-123")
            self.assertTrue(any("INSERT INTO bob_access_audit" in sql for sql, _ in db.executed))

    def test_hooks_crud_lifecycle_on_disk(self):
        with tempfile.TemporaryDirectory() as tmpdir, \
             patch.object(hooks, '_get_global_settings_path', return_value=None), \
             patch.object(hooks, '_get_global_hooks_dir', return_value=None), \
             patch.object(hooks, '_connect_db') as mock_db:
            mock_db.return_value.__enter__.return_value = None
            root = Path(tmpdir)
            hook_data = {
                "id": "my-hook-1",
                "name": "Audit Hook",
                "event": "PreToolUse",
                "matcher": ".*",
                "command": "echo test",
                "script_code": "echo 'running hook'",
                "timeout": 3000,
                "enabled": True,
                "is_blocking": True,
            }
            # Save hook
            saved = hooks.save_hook(hook_data, workspace_root=root)
            self.assertEqual(saved["id"], "my-hook-1")

            # Script file written
            script_path = root / ".bob" / "hooks" / "my-hook-1.sh"
            self.assertTrue(script_path.is_file())

            # List hooks
            listed = hooks.list_hooks(workspace_root=root)
            self.assertTrue(any(h["id"] == "my-hook-1" for h in listed))

            # Toggle hook
            toggled = hooks.toggle_hook("my-hook-1", enabled=False, workspace_root=root)
            self.assertTrue(toggled)
            config = hooks.get_hooks_config(workspace_root=root)
            self.assertFalse(config["hooks"]["PreToolUse"][0]["enabled"])

            # Delete hook
            deleted = hooks.delete_hook("my-hook-1", workspace_root=root)
            self.assertTrue(deleted)
            self.assertFalse(script_path.is_file())

    def test_run_single_hook_and_event_execution(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            # Run simple echo hook
            code, out, err = asyncio.run(
                hooks.run_single_hook("echo 'hello from hook'", {}, cwd=root, timeout_ms=5000)
            )
            self.assertEqual(code, 0)
            self.assertEqual(out, "hello from hook")

            # Run blocking hook returning code 2
            block_hook = {
                "id": "block-hook",
                "name": "Blocker",
                "event": "PreToolUse",
                "matcher": "forbidden_tool",
                "command": "exit 2",
                "enabled": True,
                "is_blocking": True,
            }
            hooks.save_hook(block_hook, workspace_root=root)

            allowed, out_ctx, err_msg = asyncio.run(
                hooks.execute_event_hooks("PreToolUse", {}, match_target="forbidden_tool", workspace_root=root)
            )
            self.assertFalse(allowed)
            self.assertIn("Blocked by hook", err_msg)

            # Match target not matching matcher passes through
            allowed_pass, _, _ = asyncio.run(
                hooks.execute_event_hooks("PreToolUse", {}, match_target="safe_tool", workspace_root=root)
            )
            self.assertTrue(allowed_pass)

    def test_run_single_hook_timeout_and_buffer_overflow(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            # Timeout
            code, out, err = asyncio.run(
                hooks.run_single_hook("sleep 5", {}, cwd=root, timeout_ms=100)
            )
            self.assertEqual(code, -1)
            self.assertIn("timed out", err)

            # Output overflow (> 64 KiB)
            code, out, err = asyncio.run(
                hooks.run_single_hook('python3 -c "import sys; sys.stdout.write(\'A\' * 70000)"', {}, cwd=root, timeout_ms=3000)
            )
            self.assertEqual(code, -1)
            self.assertIn("exceeded 64 KiB", err)

    def test_execute_event_hooks_non_blocking_and_invalid_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            # Invalid hook ID
            bad_hook = [{"id": "bad/id!", "event": "PreToolUse", "enabled": True}]
            with patch.object(hooks, 'list_hooks', return_value=bad_hook):
                allowed, _, err = asyncio.run(hooks.execute_event_hooks("PreToolUse", {}, workspace_root=root))
                self.assertFalse(allowed)
                self.assertIn("Invalid persisted hook ID", err)

            # Non-blocking hook failure does NOT block
            non_blocking_hook = {
                "id": "non-block", "name": "Warn", "event": "PostToolUse",
                "command": "exit 1", "enabled": True, "is_blocking": False,
            }
            hooks.save_hook(non_blocking_hook, workspace_root=root)
            allowed, _, _ = asyncio.run(hooks.execute_event_hooks("PostToolUse", {}, workspace_root=root))
            self.assertTrue(allowed)

    def test_hooks_database_operations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db = MockDbCursor(rowcount=1)
            with patch.object(hooks, '_connect_db') as mock_conn, \
                 patch.object(hooks, '_get_global_settings_path', return_value=None), \
                 patch.object(hooks, '_get_global_hooks_dir', return_value=None):
                mock_conn.return_value.__enter__.return_value = db

                # save_hook to DB
                hook_data = {
                    "id": "db-hook", "name": "DB Hook", "event": "PreToolUse",
                    "command": "echo 1", "enabled": True, "is_blocking": True,
                }
                hooks.save_hook(hook_data, workspace_root=root)
                self.assertTrue(any("INSERT INTO bob_lifecycle_hooks" in sql for sql, _ in db.executed))

                # _sync_hooks_to_disk
                hooks._sync_hooks_to_disk([hook_data], workspace_root=root)

                # toggle_hook in DB
                db.executed.clear()
                hooks.toggle_hook("db-hook", enabled=False, workspace_root=root)
                self.assertTrue(any("UPDATE bob_lifecycle_hooks" in sql for sql, _ in db.executed))

                # delete_hook in DB
                db.executed.clear()
                hooks.delete_hook("db-hook", workspace_root=root)
                self.assertTrue(any("DELETE FROM bob_lifecycle_hooks" in sql for sql, _ in db.executed))


if __name__ == '__main__':
    unittest.main()
