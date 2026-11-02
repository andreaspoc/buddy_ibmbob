"""Hermetic, high-density Python unit tests boosting SonarQube backend test coverage.

Covers:
- app.main
- plugins.learning.buddy_learning.service
- plugins.office.buddy_office.office_assistant
- app.decisions_buddy.decision_engine
- app.workspace_config
- app.decisions_buddy.watsonx_inference
- app.job_queue

100% in-memory: no live external network, no live Postgres/Keycloak, no subprocess hanging.
Adheres strictly to the Zero Fake Data Policy using synthetic test doubles.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from psycopg.errors import UniqueViolation

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / 'plugins'

for p in (
    str(ROOT),
    str(PLUGINS / 'learning'),
    str(PLUGINS / 'office'),
    str(PLUGINS / 'projects'),
    str(PLUGINS / 'people'),
    str(PLUGINS / 'decisions'),
    str(PLUGINS / 'tetragon'),
):
    if p not in sys.path:
        sys.path.insert(0, p)

from app import main, workspace_config, job_queue
from app.decisions_buddy import decision_engine, watsonx_inference
import buddy_office.office_assistant as office_assistant
import buddy_learning.service as learning_service


# ---------------------------------------------------------------------------
# In-memory Test Doubles & Fixtures
# ---------------------------------------------------------------------------

class MockCursor:
    def __init__(self, db, rowcount=1):
        self._db = db
        self.rowcount = rowcount

    def fetchone(self):
        if isinstance(self._db._fetchone_val, list):
            return self._db._fetchone_val.pop(0) if self._db._fetchone_val else None
        elif callable(self._db._fetchone_val):
            return self._db._fetchone_val()
        return self._db._fetchone_val

    def fetchall(self):
        if isinstance(self._db._fetchall_val, list) and self._db._fetchall_val and isinstance(self._db._fetchall_val[0], list):
            return self._db._fetchall_val.pop(0)
        elif callable(self._db._fetchall_val):
            return self._db._fetchall_val()
        return self._db._fetchall_val if self._db._fetchall_val is not None else []


class MockDB:
    def __init__(self, fetchone_val=None, fetchall_val=None, rowcount=1):
        self._fetchone_val = fetchone_val
        self._fetchall_val = fetchall_val
        self.rowcount = rowcount
        self.executed = []
        self.info = Mock()

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return MockCursor(self, rowcount=self.rowcount)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


# ===========================================================================
# 1. watsonx_inference.py Coverage Tests
# ===========================================================================

class WatsonxInferenceCoverageTests(unittest.TestCase):
    """Deep unit test suite for decisions_buddy/watsonx_inference.py."""

    def test_validate_watsonx_url_and_post(self):
        # Non-https must raise ValueError
        with self.assertRaises(ValueError) as ctx:
            watsonx_inference._validate_watsonx_url("http://example.com/api")
        self.assertIn("must use HTTPS", str(ctx.exception))

        # Valid HTTPS calls validate_url
        with patch("app.decisions_buddy.watsonx_inference.validate_url") as mock_val:
            watsonx_inference._validate_watsonx_url("https://watsonx.example.com/api")
            mock_val.assert_called_once_with("https://watsonx.example.com/api")

        # _post_watsonx with mocked httpx.Client
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"results": [{"generated_text": "Approved"}]}
        mock_resp.raise_for_status.return_value = None

        with patch("app.decisions_buddy.watsonx_inference.validate_url"), \
             patch("httpx.Client") as mock_client_cls:
            mock_client = MagicMock()
            mock_client.__enter__.return_value = mock_client
            mock_client.post.return_value = mock_resp
            mock_client_cls.return_value = mock_client

            res = watsonx_inference._post_watsonx("https://watsonx.test/ml/v1", {"input": "test"}, "Bearer tok")
            self.assertEqual(res, {"results": [{"generated_text": "Approved"}]})

    def test_provider_config_and_render_template(self):
        # _get_provider_config handles import failure gracefully
        with patch.dict("sys.modules", {"app.decisions_buddy.cp4d_settings": None}):
            cfg = watsonx_inference._get_provider_config("watsonx_ai")
            self.assertEqual(cfg, {})

        # _render_template with empty / None
        self.assertEqual(watsonx_inference._render_template("", {}), "")
        self.assertEqual(watsonx_inference._render_template(None, {}), "")

        # _render_template path substitution
        ctx = {"customer": {"name": "Alice", "score": 750}}
        tmpl = "Hello {customer.name}, your score is {customer.score}. Missing: {customer.missing}."
        rendered = watsonx_inference._render_template(tmpl, ctx)
        self.assertEqual(rendered, "Hello Alice, your score is 750. Missing: .")

    def test_simulate_ai_response_branches(self):
        # 1. Churn branch
        res_churn, score_churn = watsonx_inference._simulate_ai_response(
            "model-1", "Predict churn likelihood", {"customer": {"accountAgeMonths": 24, "openTickets": 3}}
        )
        self.assertIn("churnRisk", res_churn)
        self.assertIsInstance(score_churn, float)

        # 2. Fraud branch
        res_fraud, score_fraud = watsonx_inference._simulate_ai_response(
            "model-1", "Evaluate transaction fraud risk", {"transaction": {"amount": 5000, "isForeignCountry": True}}
        )
        self.assertIn("fraudRiskScore", res_fraud)
        self.assertIsInstance(score_fraud, float)

        # 3. Credit / Loan branch
        res_credit, score_credit = watsonx_inference._simulate_ai_response(
            "model-1", "Evaluate underwriting for loan applicant", {"applicant": {"creditScore": 760}}
        )
        self.assertIn("approvalProbability", res_credit)
        self.assertIn("PRIME", res_credit)
        self.assertIsInstance(score_credit, float)

        # 4. Default intent branch
        res_default, score_default = watsonx_inference._simulate_ai_response(
            "model-1", "Classify sentiment", {}
        )
        self.assertIn("ELIGIBLE", res_default)
        self.assertEqual(score_default, 0.92)

    def test_simulate_ml_scoring_branches(self):
        # Regression
        val, prob = watsonx_inference._simulate_ml_scoring("dep-1", {"f1": 12, "f2": 3.5, "flag": True}, "regression")
        self.assertIsInstance(val, float)
        self.assertIsInstance(prob, float)

        # Classification - Churn
        label, prob = watsonx_inference._simulate_ml_scoring("dep-churn-v1", {"age": 5, "active": False}, "classification")
        self.assertIn(label, ("CHURN_RISK", "RETAINED"))

        # Classification - Fraud
        label, prob = watsonx_inference._simulate_ml_scoring("dep-fraud-detection", {"amount": 100}, "classification")
        self.assertIn(label, ("FRAUDULENT", "LEGITIMATE"))

        # Classification - Credit / Risk
        label, prob = watsonx_inference._simulate_ml_scoring("dep-credit-risk", {"score": 700}, "classification")
        self.assertIn(label, ("LOW_RISK", "HIGH_RISK"))

        # Classification - Default
        label, prob = watsonx_inference._simulate_ml_scoring("dep-other", {}, "classification")
        self.assertIn(label, ("POSITIVE", "NEGATIVE"))

    def test_execute_watsonx_ai_live_and_offline(self):
        # 1. Live invocation with JSON response
        mock_post = MagicMock(return_value={
            "results": [{"generated_text": '{"recommendation": "APPROVE_VIP", "score": 0.98}'}]
        })
        with patch.object(watsonx_inference, "_post_watsonx", mock_post), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            content = {
                "endpoint": "https://watsonx.test/ml/v1/text/generation",
                "projectId": "proj-123",
                "apiKey": "ZenApiKey secret123",
                "promptTemplate": "Evaluate {user.name}",
                "outputField": "decisionResult"
            }
            res = watsonx_inference.execute_watsonx_ai(content, {"user": {"name": "Bob"}})
            self.assertIn("decisionResult", res)
            self.assertEqual(res["decisionResult"]["recommendation"], "APPROVE_VIP")
            self.assertEqual(res["decisionResult"]["score"], 0.98)

        # 2. Live invocation network failure -> fallback to simulation
        with patch.object(watsonx_inference, "_post_watsonx", side_effect=RuntimeError("Network down")), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            content = {
                "baseUrl": "https://watsonx.test",
                "spaceId": "space-456",
                "token": "raw-token",
                "prompt": "Evaluate fraud risk",
                "outputField": "fraudEval"
            }
            res = watsonx_inference.execute_watsonx_ai(content, {"transaction": {"amount": 200}})
            self.assertIn("fraudEval", res)
            self.assertIn("fraudRiskScore", res["fraudEval"])

    def test_execute_watsonx_ml_mapping_and_execution(self):
        # 1. Dict mapping + live prediction
        mock_post = MagicMock(return_value={
            "predictions": [{
                "values": [["APPROVED"]],
                "probabilities": [[0.88]]
            }]
        })
        with patch.object(watsonx_inference, "_post_watsonx", mock_post), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            content = {
                "deploymentId": "dep-scoring-99",
                "endpoint": "https://watsonx.test/ml/v4/deployments/dep-scoring-99/predictions",
                "space_id": "spc-1",
                "api_key": "secret",
                "inputMapping": {"user_age": "customer.age", "user_status": "customer.status"},
                "outputField": "mlScore"
            }
            res = watsonx_inference.execute_watsonx_ml(content, {"customer": {"age": 30, "status": "active"}})
            self.assertIn("mlScore", res)
            self.assertEqual(res["mlScore"]["prediction"], "APPROVED")
            self.assertEqual(res["mlScore"]["probability"], 0.88)
            self.assertEqual(res["mlScore"]["status"], "scored")

        # 2. List mapping + offline simulation fallback
        with patch.object(watsonx_inference, "_post_watsonx", side_effect=Exception("Timeout")), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            content = {
                "deployment_id": "dep-churn-prediction",
                "baseUrl": "https://watsonx.test",
                "projectId": "proj-9",
                "apiKey": "Bearer key",
                "features": [
                    {"name": "tenure", "path": "tenure_months"},
                    {"field": "is_active", "source": "active_flag"}
                ],
                "scoringType": "classification"
            }
            res = watsonx_inference.execute_watsonx_ml(content, {"tenure_months": 15, "active_flag": True})
            self.assertIn("mlResult", res)
            self.assertIn(res["mlResult"]["prediction"], ("CHURN_RISK", "RETAINED"))

    def test_watsonx_uncovered_branches(self):
        # 1. Invalid JSON in model generated text
        mock_post = MagicMock(return_value={"results": [{"generated_text": "{invalid json"}]})
        with patch.object(watsonx_inference, "_post_watsonx", mock_post), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            res = watsonx_inference.execute_watsonx_ai(
                {"endpoint": "https://watsonx.test/ml/v1/text/generation", "projectId": "p1", "apiKey": "k1"},
                {}
            )
            self.assertEqual(res["aiResult"]["generatedText"], "{invalid json")

        # 2. execute_watsonx_ai with spaceId and Basic auth prefix
        mock_post2 = MagicMock(return_value={"results": [{"generated_text": '{"decision": "DENY"}'}]})
        with patch.object(watsonx_inference, "_post_watsonx", mock_post2), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            res2 = watsonx_inference.execute_watsonx_ai(
                {"endpoint": "https://watsonx.test/ml/v1/text/generation", "spaceId": "s1", "apiKey": "Basic b64token"},
                {}
            )
            self.assertEqual(res2["aiResult"]["recommendation"], "DENY")

        # 3. execute_watsonx_ml with spaceId and Basic auth prefix
        mock_post3 = MagicMock(return_value={"predictions": [{"values": ["OK"], "probabilities": [0.9]}]})
        with patch.object(watsonx_inference, "_post_watsonx", mock_post3), \
             patch.object(watsonx_inference, "_validate_watsonx_url"):
            res3 = watsonx_inference.execute_watsonx_ml(
                {"endpoint": "https://watsonx.test/ml/v4/deployments/d1/predictions", "spaceId": "s1", "apiKey": "Basic b64token"},
                {}
            )
            self.assertEqual(res3["mlResult"]["prediction"], "OK")


# ===========================================================================
# 2. workspace_config.py Coverage Tests
# ===========================================================================

class WorkspaceConfigCoverageTests(unittest.TestCase):
    """Deep unit test suite for app/workspace_config.py."""

    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory(prefix="test-ws-config-")
        self.addCleanup(self.tmp_dir.cleanup)
        self.root = Path(self.tmp_dir.name)
        token = workspace_config._selected_root.set(self.root)
        self.addCleanup(workspace_config._selected_root.reset, token)

    def test_root_and_selection(self):
        self.assertEqual(workspace_config._root(), self.root)
        workspace_config.select_root(Path("/tmp/other_root"))
        self.assertEqual(workspace_config._root(), Path("/tmp/other_root"))
        workspace_config.select_root(self.root)

    def test_validate_skill_rules(self):
        # Valid names
        workspace_config._validate_skill("valid-skill-1", "instructions")
        workspace_config._validate_skill("skill", None)

        # Invalid names
        for bad_name in ("1skill", "BAD_NAME", "skill/name", "-skill", "a" * 65):
            with self.subTest(name=bad_name), self.assertRaises(ValueError):
                workspace_config._validate_skill(bad_name, "instructions")

        # Empty instructions
        with self.assertRaises(ValueError):
            workspace_config._validate_skill("skill", "   \n\t  ")

    def test_mode_file_and_custom_modes(self):
        self.assertEqual(workspace_config._mode_file(), self.root / ".bob" / "custom_modes.yaml")

        # File does not exist returns []
        self.assertEqual(workspace_config._read_custom_modes(), [])

        # Invalid format
        mf = workspace_config._mode_file()
        mf.parent.mkdir(parents=True, exist_ok=True)
        mf.write_text("customModes: 'string-not-a-list'\n")
        with self.assertRaises(ValueError):
            workspace_config._read_custom_modes()

        # Valid listing combines builtin and custom
        mf.write_text("customModes:\n  - slug: analyst\n    name: Data Analyst\n    description: Analyzes data\n")
        modes = workspace_config.list_modes()
        slugs = [m["slug"] for m in modes]
        self.assertIn("agent", slugs)
        self.assertIn("analyst", slugs)

    def test_create_mode_validations(self):
        # Unsupported group
        with self.assertRaises(ValueError):
            workspace_config.create_mode("my-mode", "My Mode", "desc", "role", "inst", ["invalid_group"])

        # Duplicate builtin mode
        with self.assertRaises(FileExistsError):
            workspace_config.create_mode("agent", "Agent Duplicate", "desc", "role", "inst", ["read"])

        # Successful creation
        created = workspace_config.create_mode("researcher", "Researcher", "desc", "role", "inst", ["read", "browser"])
        self.assertEqual(created["slug"], "researcher")
        self.assertEqual(created["kind"], "custom")

        # Duplicate custom mode
        with self.assertRaises(FileExistsError):
            workspace_config.create_mode("researcher", "Duplicate", "desc", "role", "inst", ["read"])

    def test_read_and_write_json(self):
        test_file = self.root / ".bob" / "data.json"
        test_file.parent.mkdir(parents=True, exist_ok=True)

        # File does not exist -> returns {}
        self.assertEqual(workspace_config._read_json(test_file, "key"), {})

        # Invalid json format
        test_file.write_text("not json")
        with self.assertRaises(ValueError):
            workspace_config._read_json(test_file, "key")

        # Write and read valid after reset
        test_file.unlink()
        workspace_config._write_json(test_file, "myKey", {"a": 1, "b": 2})
        data = workspace_config._read_json(test_file, "myKey")
        self.assertEqual(data, {"a": 1, "b": 2})

    def test_build_mcp_config(self):
        # Unsupported transport
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config("ftp", "url", "cmd", [], {}, {}, {}, "", "", "")

        # Non-string parameters or headers
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config("http", "https://api.test", "", [], {"p": 123}, {}, {}, "", "", "")

        # Stdio without command
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config("stdio", "", "   ", [], {}, {}, {}, "", "", "")

        # Stdio with command splitting
        with patch("app.mcp_command_policy.validate_stdio_config"):
            cfg = workspace_config.build_mcp_config("stdio", "", "python3 -m server", [], {}, {}, {"ENV1": "val1"}, "key123", "MY_KEY", "")
            self.assertEqual(cfg["command"], "python3")
            self.assertEqual(cfg["args"], ["-m", "server"])
            self.assertEqual(cfg["env"]["MY_KEY"], "key123")
            self.assertEqual(cfg["env"]["ENV1"], "val1")

        # Stdio with invalid API key variable name
        with patch("app.mcp_command_policy.validate_stdio_config"):
            with self.assertRaises(ValueError):
                workspace_config.build_mcp_config("stdio", "", "cmd", [], {}, {}, {}, "key", "NOT-IDENTIFIER", "")

        # HTTP/SSE with invalid URL scheme or host
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config("http", "not_a_valid_url", "", [], {}, {}, {}, "", "", "")

        # HTTP with parameters, headers, and API key prefix
        cfg_http = workspace_config.build_mcp_config(
            "http", "https://api.example.com/mcp?foo=1", "", [],
            {"bar": "2"}, {"X-Custom": "header"}, {}, "tok99", "Authorization", "Bearer "
        )
        self.assertIn("https://api.example.com/mcp?", cfg_http["httpURL"])
        self.assertIn("bar=2", cfg_http["httpURL"])
        self.assertEqual(cfg_http["headers"]["Authorization"], "Bearer tok99")
        self.assertEqual(cfg_http["headers"]["X-Custom"], "header")

        # HTTP with invalid header name (containing colon or newline)
        with self.assertRaises(ValueError):
            workspace_config.build_mcp_config(
                "http", "https://api.test/mcp", "", [], {}, {}, {}, "tok", "Bad:Header\n", ""
            )

    def test_mcp_access_wrappers(self):
        with patch("app.workspace_config.migrate_mcp_registry"), \
             patch("app.workspace_config.mcp_actor", return_value="alice"), \
             patch("app.mcp_access.create", return_value={"name": "test-mcp"}) as mock_create, \
             patch("app.mcp_access.update", return_value={"name": "test-mcp"}) as mock_update, \
             patch("app.mcp_access.delete", return_value=True) as mock_delete, \
             patch("app.mcp_access.catalog", return_value=[{"name": "mcp1"}]) as mock_catalog, \
             patch("app.mcp_access.allowed_servers", return_value={"mcp1": {}}) as mock_allowed, \
             patch("app.workspace_config.ensure_brave_mcp"), \
             patch("app.mcp_command_policy.validate_stdio_config"):

            # create_mcp
            res = workspace_config.create_mcp("test-mcp", "stdio", "", "node index.js", [], {}, {}, {}, "", "", "")
            self.assertEqual(res, {"name": "test-mcp"})
            mock_create.assert_called_once()

            # update_mcp
            res = workspace_config.update_mcp("test-mcp", transport="stdio", url="", command="node", args=["index.js"],
                                              parameters={}, headers={}, env={}, api_key="", api_key_name="", api_key_prefix="", disabled=True)
            self.assertEqual(res, {"name": "test-mcp"})
            mock_update.assert_called_once()

            # delete_mcp
            self.assertTrue(workspace_config.delete_mcp("test-mcp"))
            mock_delete.assert_called_once_with("alice", "test-mcp")

            # list_mcps and get_mcp_config
            self.assertEqual(workspace_config.list_mcps(), [{"name": "mcp1"}])
            self.assertEqual(workspace_config.get_mcp_config("mcp1"), {})

    def test_ensure_brave_and_microsoft_mcp(self):
        with patch("app.workspace_config.migrate_mcp_registry"), \
             patch("app.mcp_access.ensure_builtin") as mock_builtin:
            workspace_config.ensure_microsoft_mcp()
            mock_builtin.assert_called_with("microsoft365", {
                "command": "python3", "args": ["-m", "app.mcp_microsoft"],
                "env": {"PYTHONPATH": "/opt/bob-a2a"}
            })

            target = self.root / ".bob" / "test_mcp.json"
            with patch("app.workspace_config.effective_mcp_servers", return_value={"srv1": {}}):
                workspace_config.ensure_brave_mcp(target_path=target)
                self.assertTrue(target.is_file())
                self.assertIn("srv1", json.loads(target.read_text())["mcpServers"])

            # remove_microsoft_mcp is a no-op safe call
            workspace_config.remove_microsoft_mcp()

    def test_agent_catalog_and_edge_cases(self):
        # Catalog prefix reserved
        with self.assertRaises(ValueError):
            workspace_config.create_agent("catalog-test", {})
        with self.assertRaises(ValueError):
            workspace_config.update_agent("catalog-test", {})

        # get_agent catalog-
        with patch("app.workspace_config.mcp_actor", return_value="bob"), \
             patch("app.agent_catalog.get_authorized_agent", return_value={"name": "Catalog Agent"}):
            self.assertEqual(workspace_config.get_agent("catalog-shared"), {"name": "Catalog Agent"})

        with patch("app.workspace_config.mcp_actor", return_value=None):
            self.assertIsNone(workspace_config.get_agent("catalog-shared"))

        # public_agent redacts credentials
        agent_data = {"name": "Ag1", "api_key": "sec", "auth_token": "tok", "headers": {}, "credentials": {}}
        public_view = workspace_config._public_agent(agent_data)
        self.assertEqual(public_view, {"name": "Ag1"})

    def test_migrate_mcp_registry_flow(self):
        with patch("app.mcp_access.ensure_schema"), \
             patch("app.auth._connect", return_value=MockDB(fetchone_val={"1": 1})):
            workspace_config.migrate_mcp_registry()

        with patch("app.mcp_access.ensure_schema"), \
             patch("app.auth._connect", return_value=MockDB(fetchone_val=None, fetchall_val=[("admin",)])), \
             patch("app.sessions.user_root", return_value=self.root), \
             patch("app.postgres_storage.read_user_file", return_value=json.dumps({"mcpServers": {"srv1": {}}, "deletedMcpServers": []}).encode()), \
             patch("app.mcp_access.seed") as mock_seed:
            workspace_config.migrate_mcp_registry()
            mock_seed.assert_called_once()

    def test_skill_management_flow(self):
        with patch("app.workspace_config.list_skills", return_value=[]):
            created = workspace_config.create_skill("helper-tool", "Helper Description", "Do task")
            self.assertEqual(created["name"], "helper-tool-buddy")

        sk_file = self.root / ".bob" / "skills" / "helper-tool-buddy" / "SKILL.md"
        sk_file.parent.mkdir(parents=True, exist_ok=True)
        sk_file.write_text("---\nname: helper-tool-buddy\ndescription: Helper Description\n---\n\nDo task\n")

        with patch("app.postgres_storage.user_file_identity", return_value=None), \
             patch("app.workspace_config.list_skills", return_value=[]):
            sk = workspace_config.get_skill("helper-tool-buddy")
            self.assertEqual(sk["name"], "helper-tool-buddy")
            self.assertEqual(sk["instructions"], "Do task")

            up = workspace_config.update_skill("helper-tool-buddy", "New Desc", "New Instructions")
            self.assertEqual(up["description"], "New Desc")


# ===========================================================================
# 3. job_queue.py Coverage Tests
# ===========================================================================

class JobQueueCoverageTests(unittest.TestCase):
    """Deep unit test suite for app/job_queue.py."""

    def test_clean_null_bytes_and_dumps_jsonb(self):
        # String with raw null and unicode null
        raw_str = "hello\x00world\u0000!"
        self.assertEqual(job_queue._clean_null_bytes(raw_str), "helloworld!")

        # Dict and nested list
        nested = {"k\x00ey": ["val\u0000ue", 123, True, {"sub": "\x00inner"}]}
        cleaned = job_queue._clean_null_bytes(nested)
        self.assertEqual(cleaned, {"key": ["value", 123, True, {"sub": "inner"}]})

        # Dumps jsonb removes null bytes and escaped null sequences
        encoded = job_queue._dumps_jsonb({"msg": "abc\\u0000def\x00ghi"})
        self.assertNotIn("\x00", encoded)
        self.assertNotIn("\\u0000", encoded)

    def test_deletion_helpers(self):
        # deletion_record and deletion_status
        db_mock = MockDB(fetchone_val={"status": "deleting", "project_id": "proj-1"})
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock):
            rec = job_queue.deletion_record("alice", "ws-1")
            self.assertEqual(rec["status"], "deleting")
            self.assertEqual(job_queue.deletion_status("alice", "ws-1"), "deleting")

        # deleted_session_ids
        db_mock2 = MockDB(fetchall_val=[{"workspace_id": "ws-1"}, {"workspace_id": "ws-2"}])
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock2):
            sids = job_queue.deleted_session_ids("alice")
            self.assertEqual(sids, {"ws-1", "ws-2"})

        # deletion_states
        db_mock3 = MockDB(fetchall_val=[{"workspace_id": "ws-1", "status": "deleted", "project_id": None}])
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock3):
            states = job_queue.deletion_states("alice")
            self.assertEqual(states["ws-1"]["status"], "deleted")

        # delete_session_jobs executes DELETE
        db_del = MockDB()
        with patch.object(job_queue, "_connect", return_value=db_del):
            job_queue.delete_session_jobs("alice", "ws-1")
            self.assertTrue(any("DELETE FROM bob_jobs" in sql for sql, _ in db_del.executed))

    def test_session_analysis_queries(self):
        # session_done_task_ids
        db_mock = MockDB(fetchall_val=[{"task_id": "task-1"}, {"task_id": "task-2"}])
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock):
            tids = job_queue.session_done_task_ids("alice", "ws-1")
            self.assertEqual(tids, {"task-1", "task-2"})

        # session_unique_bob_prompts
        db_mock2 = MockDB(fetchall_val=[
            {"workspace_id": "ws-1", "prompt": "prompt-unique-1"},
            {"workspace_id": "ws-1", "prompt": "prompt-shared"},
            {"workspace_id": "ws-2", "prompt": "prompt-shared"},
        ])
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock2):
            unique_prompts = job_queue.session_unique_bob_prompts("alice", "ws-1")
            self.assertEqual(unique_prompts, {"prompt-unique-1"})

    def test_job_querying_and_lifecycle(self):
        # get_job with and without username
        db_mock = MockDB(fetchone_val={"id": "job-1", "status": "running"})
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock):
            j1 = job_queue.get_job("job-1")
            self.assertEqual(j1["id"], "job-1")
            j2 = job_queue.get_job("job-1", "alice")
            self.assertEqual(j2["id"], "job-1")

        # has_active_workspace
        db_mock2 = MockDB(fetchone_val={"1": 1})
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock2):
            self.assertTrue(job_queue.has_active_workspace("ws-key"))

        # events_after
        db_mock3 = MockDB(fetchall_val=[{"id": 10, "event": {"type": "status"}}], fetchone_val={"status": "running"})
        with patch.object(job_queue, "_connect", return_value=db_mock3):
            events, st = job_queue.events_after("job-1", 5)
            self.assertEqual(len(events), 1)
            self.assertEqual(st, "running")

        # heartbeat
        db_mock4 = MockDB(rowcount=1)
        with patch.object(job_queue, "_connect", return_value=db_mock4):
            self.assertTrue(job_queue.heartbeat("job-1", "worker-1"))

        # append_event
        db_mock5 = MockDB(fetchone_val={"payload": {}, "workspace_id": "ws-1"})
        with patch.object(job_queue, "_connect", return_value=db_mock5):
            self.assertTrue(job_queue.append_event("job-1", "worker-1", {"type": "custom"}))

    def test_requeue_expired_jobs(self):
        rows = [
            {"id": "j1", "username": "u1", "attempts": 0, "max_attempts": 1, "payload": {}, "workspace_id": "w1"},
            {"id": "j2", "username": "u2", "attempts": 1, "max_attempts": 1, "payload": {}, "workspace_id": "w2"},
            {"id": "j3", "username": "u3", "attempts": 0, "max_attempts": 1, "payload": {"cancel_requested": True}, "workspace_id": "w3"},
        ]
        db_mock = MockDB(fetchall_val=rows)
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_mock):
            job_queue.requeue_expired()
            self.assertTrue(any("UPDATE bob_jobs SET status='queued'" in sql for sql, _ in db_mock.executed))
            self.assertTrue(any("UPDATE bob_jobs SET status='failed'" in sql for sql, _ in db_mock.executed))

    def test_claim_jobs(self):
        # 1. No job available
        db_none = MockDB(fetchone_val=None)
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_none):
            self.assertIsNone(job_queue.claim("worker-tok"))

        # 2. Job available
        job_row = {"id": "j100", "username": "alice", "workspace_id": "w1", "payload": {}}
        db_avail = MockDB(fetchone_val=job_row)
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_avail):
            claimed = job_queue.claim("worker-tok")
            self.assertEqual(claimed["id"], "j100")
            self.assertEqual(claimed["status"], "running")
            self.assertEqual(claimed["worker_token"], "worker-tok")

    def test_job_stream_recorder(self):
        async def run_recorder():
            recorder = job_queue.JobStreamRecorder(
                "job-test-1", "tok-1", "alice", "ws-1", durable=True, correlation={"turn_id": "t1"}
            )
            mock_conn = AsyncMock()
            recorder._conn = mock_conn

            with patch.object(job_queue.JobStreamRecorder, "_persist_event", return_value=123), \
                 patch.object(job_queue.JobStreamRecorder, "_persist_completion", return_value=None):

                # delta event
                res = await recorder.record_event({"type": "delta", "text": "Hello "})
                self.assertTrue(res)
                self.assertEqual(recorder.accumulated_text, ["Hello "])

                # replace delta
                await recorder.record_event({"type": "delta", "text": "Replaced", "replace": True})
                self.assertEqual(recorder.accumulated_text, ["Replaced"])

                # tool event with output truncation
                long_out = "X" * 4000
                await recorder.record_event({"type": "tool", "name": "shell", "output": long_out})

                # delivery_state saving checkpoint
                await recorder.record_event({"type": "delivery_state", "state": "saving"})

                # finish
                await recorder.finish({"type": "done", "status": "completed"})

        asyncio.run(run_recorder())

    def test_session_guard_and_submission(self):
        # session_guard active deletion
        db_del = MockDB(fetchone_val={"1": 1})
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_del):
            with self.assertRaises(ValueError):
                with job_queue.session_guard("alice", "ws-1"):
                    pass

        # session_guard clean
        db_clean = MockDB(fetchone_val=None)
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_clean):
            with job_queue.session_guard("alice", "ws-1"):
                pass

        # find_submission reused vs hash mismatch
        jid = uuid4()
        db_sub = MockDB(fetchone_val={"request_hash": "hash1", "id": jid, "payload": {"foo": "bar"}})
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_sub):
            res = job_queue.find_submission("alice", "ws-1", "key1", "hash1")
            self.assertTrue(res.reused)
            self.assertEqual(res, str(jid))

            with self.assertRaises(ValueError):
                job_queue.find_submission("alice", "ws-1", "key1", "diff_hash")

    def test_begin_and_complete_deletion(self):
        # active job prevents deletion
        db_active = MockDB(fetchone_val=[{"status": "deleting"}, {"1": 1}])
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_active):
            with self.assertRaises(ValueError):
                job_queue.begin_deletion("alice", "ws-1", "alice:ws-1")

        # clean begin deletion
        db_begin = MockDB(fetchone_val=None)
        with patch.object(job_queue, "ensure_schema"), \
             patch.object(job_queue, "_connect", return_value=db_begin):
            st = job_queue.begin_deletion("alice", "ws-1", "alice:ws-1")
            self.assertEqual(st, "deleting")

        # complete deletion
        db_complete = MockDB()
        with patch.object(job_queue, "_connect", return_value=db_complete):
            job_queue.complete_deletion("alice", "ws-1")
            self.assertTrue(any("UPDATE bob_deleted_conversations" in sql for sql, _ in db_complete.executed))


# ===========================================================================
# 4. decision_engine.py Coverage Tests
# ===========================================================================

class DecisionEngineCoverageTests(unittest.TestCase):
    """Deep unit test suite for decisions_buddy/decision_engine.py."""

    def test_clean_num_str_and_parse_literal(self):
        self.assertEqual(decision_engine.clean_num_str("1_000_000"), "1000000")
        self.assertEqual(decision_engine.clean_num_str("25_500.50"), "25500.50")

        # parse_literal types
        self.assertEqual(decision_engine.parse_literal('"quoted"'), "quoted")
        self.assertEqual(decision_engine.parse_literal("'single'"), "single")
        self.assertTrue(decision_engine.parse_literal("true"))
        self.assertFalse(decision_engine.parse_literal("false"))
        self.assertIsNone(decision_engine.parse_literal("null"))
        self.assertIsNone(decision_engine.parse_literal("none"))
        self.assertEqual(decision_engine.parse_literal("42"), 42)
        self.assertEqual(decision_engine.parse_literal("3.14"), 3.14)
        self.assertEqual(decision_engine.parse_literal("user.age", {"user": {"age": 28}}), 28)
        self.assertEqual(decision_engine.parse_literal("unknown_var"), "unknown_var")

    def test_loose_equals_cases(self):
        self.assertTrue(decision_engine.loose_equals("HELLO", "hello"))
        self.assertTrue(decision_engine.loose_equals(100, "100.0"))
        self.assertTrue(decision_engine.loose_equals(None, None))
        self.assertFalse(decision_engine.loose_equals(None, "val"))
        self.assertFalse(decision_engine.loose_equals("val", None))
        self.assertTrue(decision_engine.loose_equals("1_000", 1000))

    def test_split_unary_list(self):
        res = decision_engine._split_unary_list('"A, B", "C", D')
        self.assertEqual(res, ['"A, B"', '"C"', 'D'])

    def test_evaluate_unary_operators(self):
        # Wildcard / empty
        self.assertTrue(decision_engine.evaluate_unary("-", 123)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("", 123)["passed"])

        # Null / not null
        self.assertTrue(decision_engine.evaluate_unary("null", None)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("null", "data")["passed"])
        self.assertTrue(decision_engine.evaluate_unary("is not null", "data")["passed"])

        # in / not in
        self.assertTrue(decision_engine.evaluate_unary("in [1, 2, 3]", 2)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("in [1, 2, 3]", 5)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("not in [1, 2, 3]", 5)["passed"])

        # comma separated shorthand
        self.assertTrue(decision_engine.evaluate_unary('"US", "CA", "MX"', "ca")["passed"])

        # contains
        self.assertTrue(decision_engine.evaluate_unary("contains 'apple'", ["apple", "banana"])["passed"])
        self.assertTrue(decision_engine.evaluate_unary("contains 'world'", "hello world")["passed"])

        # some / all / none
        self.assertTrue(decision_engine.evaluate_unary("some > 10", [5, 12, 3])["passed"])
        self.assertTrue(decision_engine.evaluate_unary("all > 0", [1, 2, 3])["passed"])
        self.assertFalse(decision_engine.evaluate_unary("all > 0", [1, -2, 3])["passed"])
        self.assertTrue(decision_engine.evaluate_unary("none < 0", [1, 2, 3])["passed"])

        # range [min..max]
        self.assertTrue(decision_engine.evaluate_unary("[10..20]", 15)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("[10..20]", 10)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("(10..20]", 10)["passed"])
        self.assertFalse(decision_engine.evaluate_unary("[10..20]", "non-numeric")["passed"])

        # comparisons
        self.assertTrue(decision_engine.evaluate_unary(">= 100", 100)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("< 50", 25)["passed"])
        self.assertTrue(decision_engine.evaluate_unary("!= 'BAD'", 'GOOD')["passed"])
        self.assertFalse(decision_engine.evaluate_unary("> 10", None)["passed"])

    def test_builtins_functions(self):
        b = decision_engine.BUILTINS
        self.assertEqual(b["sum"]([1, 2, 3]), 6.0)
        self.assertEqual(b["avg"]([2, 4]), 3.0)
        self.assertEqual(b["min"](10, 5, 20), 5)
        self.assertEqual(b["max"]([10, 5, 20]), 20)
        self.assertEqual(b["coalesce"](None, "val"), "val")
        self.assertEqual(b["date"]("2023-01-01T12:00:00"), "2023-01-01T12:00:00")
        self.assertEqual(b["year"]("2023-05-01"), 2023)
        self.assertEqual(b["diffDays"]("2023-01-01", "2023-01-11"), 10)
        self.assertEqual(b["map"]([{"a": 1}, {"a": 2}], "a"), [1, 2])
        self.assertEqual(b["filter"]([{"a": 1}, {"a": 2}], "a", 2), [{"a": 2}])
        self.assertEqual(b["find"]([{"a": 1}, {"a": 2}], "a", 2), {"a": 2})
        self.assertEqual(b["flatten"]([[1, 2], [3]]), [1, 2, 3])
        self.assertEqual(b["unique"]([1, 2, 2, 3]), [1, 2, 3])
        self.assertEqual(b["join"]([1, 2, 3], "-"), "1-2-3")
        self.assertEqual(b["split"]("a,b,c", ","), ["a", "b", "c"])
        self.assertEqual(b["replace"]("hello world", "world", "buddy"), "hello buddy")
        self.assertEqual(b["slice"]([1, 2, 3, 4], 1, 3), [2, 3])

    def test_validate_json_schema(self):
        # Non-dict schema
        self.assertEqual(decision_engine.validate_json_schema(10, None), [])

        schema = {
            "type": "object",
            "required": ["name", "age"],
            "properties": {
                "name": {"type": "string", "enum": ["Alice", "Bob"]},
                "age": {"type": "integer", "minimum": 18, "maximum": 120}
            }
        }
        # Valid
        errs = decision_engine.validate_json_schema({"name": "Alice", "age": 25}, schema)
        self.assertEqual(errs, [])

        # Missing required & enum mismatch & range violation
        errs2 = decision_engine.validate_json_schema({"name": "Charlie", "age": 15}, schema)
        self.assertTrue(any("enum" in e for e in errs2))
        self.assertTrue(any("minimum" in e for e in errs2))

    def test_decision_table_hit_policies(self):
        table_def = {
            "hitPolicy": "collect",
            "inputs": [{"id": "col_age", "field": "age"}],
            "outputs": [
                {"id": "out_pts", "field": "points", "collect": "sum"},
                {"id": "out_cnt", "field": "matches", "collect": "count"}
            ],
            "rules": [
                {"col_age": "> 18", "out_pts": 10, "out_cnt": 1},
                {"col_age": "> 25", "out_pts": 20, "out_cnt": 1},
                {"col_age": "< 10", "out_pts": 5, "out_cnt": 1}
            ]
        }
        res, trace = decision_engine.evaluate_decision_table(table_def, {"age": 30})
        self.assertEqual(res["points"], 30.0)
        self.assertEqual(res["matches"], 2)

        # ruleOrder policy
        table_order = {
            "hitPolicy": "ruleOrder",
            "inputs": [{"id": "c1", "field": "x"}],
            "outputs": [{"id": "o1", "field": "y"}],
            "rules": [{"c1": "> 0", "o1": '"pos"'}]
        }
        res_order, _ = decision_engine.evaluate_decision_table(table_order, {"x": 5})
        self.assertEqual(res_order, [{"y": "pos"}])

        # Invalid hitPolicy raises ValueError
        with self.assertRaises(ValueError):
            decision_engine.evaluate_decision_table({"hitPolicy": "invalid"}, {})

    def test_parallel_regions_validation_and_merge(self):
        # 1. Invalid fork maxWorkers
        graph_bad_workers = {
            "nodes": [
                {"id": "f1", "type": "forkNode", "content": {"maxWorkers": 10}},
                {"id": "j1", "type": "joinNode"}
            ],
            "edges": [{"id": "e1", "sourceId": "f1", "targetId": "j1"}]
        }
        with self.assertRaises(ValueError):
            decision_engine.validate_parallel_regions(graph_bad_workers)

        # 2. Parallel merge conflicts
        baseline = {"status": "pending", "counter": 0}
        branch1 = {"status": "approved", "counter": 1}
        branch2 = {"status": "rejected", "counter": 2}

        # Policy error raises
        with self.assertRaises(ValueError):
            decision_engine._merge_parallel_results(baseline, [branch1, branch2], "error")

        # Policy first keeps branch1
        m_first = decision_engine._merge_parallel_results(baseline, [branch1, branch2], "first")
        self.assertEqual(m_first["status"], "approved")

        # Policy last keeps branch2
        m_last = decision_engine._merge_parallel_results(baseline, [branch1, branch2], "last")
        self.assertEqual(m_last["status"], "rejected")

    def test_decision_engine_evaluation_budget_and_switch(self):
        engine = decision_engine.DecisionEngine()
        graph = {
            "nodes": [
                {"id": "in1", "type": "inputNode", "content": {}},
                {"id": "sw1", "type": "switchNode", "content": {
                    "statements": [
                        {"id": "s1", "condition": "tier == 'VIP'"},
                        {"id": "s2", "condition": "tier == 'STANDARD'"}
                    ]
                }},
                {"id": "exp1", "type": "expressionNode", "content": {
                    "expressions": [{"key": "bonus", "value": "100"}]
                }},
                {"id": "out1", "type": "outputNode", "content": {}}
            ],
            "edges": [
                {"id": "e1", "sourceId": "in1", "targetId": "sw1"},
                {"id": "e2", "sourceId": "sw1", "targetId": "exp1", "sourceHandle": "s1"},
                {"id": "e3", "sourceId": "exp1", "targetId": "out1"}
            ]
        }
        # Branch s1 taken
        res = engine.evaluate(graph, {"tier": "VIP"})
        self.assertEqual(res["result"]["bonus"], 100)

        # Branch s1 not taken -> exp1 skipped
        res2 = engine.evaluate(graph, {"tier": "STANDARD"})
        self.assertNotIn("bonus", res2.get("result", {}))

        # Node evaluation budget exhaustion
        with self.assertRaises(ValueError) as ctx:
            engine.evaluate(graph, {"tier": "VIP"}, _budget={"remaining": 0, "_lock": MagicMock()})
        self.assertIn("node budget exceeded", str(ctx.exception))


# ===========================================================================
# 5. office_assistant.py Coverage Tests
# ===========================================================================

class OfficeAssistantCoverageTests(unittest.TestCase):
    """Deep unit test suite for plugins/office/buddy_office/office_assistant.py."""

    def test_office_helpers(self):
        # _col_letter
        self.assertEqual(office_assistant._col_letter(0), "A")
        self.assertEqual(office_assistant._col_letter(25), "Z")
        self.assertEqual(office_assistant._col_letter(26), "AA")
        self.assertEqual(office_assistant._col_letter(27), "AB")

        # _try_float
        self.assertEqual(office_assistant._try_float(42), 42.0)
        self.assertEqual(office_assistant._try_float("1,234.50"), 1234.50)
        self.assertEqual(office_assistant._try_float("$500.00"), 500.0)
        self.assertEqual(office_assistant._try_float("15.5%"), 15.5)
        self.assertIsNone(office_assistant._try_float("not_a_number"))

        # _try_year_month returns (year_str, year_month_str)
        self.assertEqual(office_assistant._try_year_month("2023-08-15"), ("2023", "2023-08"))
        self.assertEqual(office_assistant._try_year_month("12/05/2024"), ("2024", "2024-12"))
        self.assertIsNone(office_assistant._try_year_month("invalid_date"))

        # checked_range returns (row_count, col_count)
        self.assertEqual(office_assistant.checked_range("A1:C10"), (10, 3))
        with self.assertRaises(ValueError):
            office_assistant.checked_range("C10:A1")  # out of order

        # checked_chart_range returns (row_count, col_count)
        self.assertEqual(office_assistant.checked_chart_range("Sheet1!A1:B10"), (10, 2))
        with self.assertRaises(ValueError):
            office_assistant.checked_chart_range("invalid_range")

    def test_office_pydantic_models(self):
        # Table must be rectangular
        with self.assertRaises(ValidationError):
            office_assistant.Table(type="table", rows=[["A", "B"], ["C"]])

        # SetCells dimension validation
        with self.assertRaises(ValidationError):
            office_assistant.SetCells(type="set_cells", range="A1:B2", values=[[1, 2, 3]])

        # FormatRange valid bounds
        fmt = office_assistant.FormatRange(type="format_range", range="A1:B5", bold=True)
        self.assertEqual(fmt.range, "A1:B5")

        # Draft validation
        with self.assertRaises(ValidationError):
            office_assistant.Draft(prompt="   ")

    def test_analytics_pruning_and_row_analysis(self):
        # _analyze_row_iterator
        rows = [
            ["Item", "Price", "Date"],
            ["Widget", "$10.50", "2023-01-05"],
            ["Gadget", "$25.00", "2023-01-10"],
        ]
        res = office_assistant._analyze_row_iterator("Sales", iter(rows))
        self.assertEqual(res["sheet"], "Sales")
        self.assertEqual(res["total_data_rows"], 2)
        self.assertIn("columns", res)

        # _prune_analytics_for_prompt
        analytics = {
            "full_dataset_analytics": [
                {
                    "sheet": "Revenue",
                    "columns": [{"type": "categorical", "header": "Region", "top_values": {f"R{i}": i for i in range(15)}}],
                    "group_breakdowns": {"Region": {}, "Product": {}, "Channel": {}},
                    "time_series": {"Dates (by Year)": {}, "Dates (by Month)": {}}
                }
            ]
        }
        pruned = office_assistant._prune_analytics_for_prompt(analytics, "Show me Region")
        sheet_meta = pruned["full_dataset_analytics"][0]
        self.assertEqual(sheet_meta["sheet"], "Revenue")
        self.assertIn("Region", sheet_meta["group_breakdowns"])

    def test_plan_parsing_and_context_validation(self):
        # _extract_json_object
        raw_md = '```json\n{"version": 1, "kind": "cell", "reply": "Done", "actions": [{"type": "add_sheet", "name": "Summary"}]}\n```'
        extracted = office_assistant._extract_json_object(raw_md)
        self.assertIn('"add_sheet"', extracted)

        # parse_plan
        plan = office_assistant.parse_plan(raw_md, "xlsx")
        self.assertEqual(len(plan.actions), 1)

        # validate_context_plan unknown sheet
        ctx = office_assistant.Context(kind="cell", sheets=["Data"])
        plan_bad_sheet = office_assistant.Plan(
            version=1,
            kind="cell",
            reply="Updating cells",
            actions=[
                office_assistant.SetCells(type="set_cells", sheet="MissingSheet", range="A1:A1", values=[[1]])
            ]
        )
        plan_bad_sheet.kind = "word"
        with self.assertRaises(ValueError):
            office_assistant.validate_context_plan(plan_bad_sheet, ctx)

        # partial_reply
        self.assertEqual(office_assistant.partial_reply('{"reply": "Hello world'), 'Hello world')
        self.assertEqual(office_assistant.partial_reply('{"actions": ['), '')

        # event and error formats
        ev = office_assistant.event("status", message="Working")
        self.assertEqual(json.loads(ev)["type"], "status")
        err_msg = office_assistant.assistant_error(ValueError("Test error"))
        self.assertEqual(err_msg[0], "connection_error")
        err_msg2 = office_assistant.assistant_error(office_assistant.InvalidPlan("bad"))
        self.assertEqual(err_msg2[0], "invalid_plan")

    def test_plan_schemas_and_selection_scope(self):
        # plan_schema_for
        for ext in ("docx", "pptx", "pdf", "html", "xlsx"):
            schema = office_assistant.plan_schema_for(ext)
            self.assertEqual(schema["type"], "object")

        # validate_selection_scope
        req = SimpleNamespace(
            context_mode="selection",
            context=office_assistant.Context(kind="cell", range="B2:C5", sheet="Sheet1")
        )
        plan_in = office_assistant.Plan(
            version=1, kind="cell", reply="ok",
            actions=[office_assistant.SetCells(type="set_cells", sheet="Sheet1", range="B2:C3", values=[[1, 2], [3, 4]])]
        )
        office_assistant.validate_selection_scope(plan_in, req)

        plan_out = office_assistant.Plan(
            version=1, kind="cell", reply="out",
            actions=[office_assistant.SetCells(type="set_cells", sheet="Sheet1", range="A1:B2", values=[[1, 2], [3, 4]])]
        )
        with self.assertRaises(ValueError):
            office_assistant.validate_selection_scope(plan_out, req)


# ===========================================================================
# 6. buddy_learning/service.py Coverage Tests
# ===========================================================================

class LearningServiceCoverageTests(unittest.TestCase):
    """Deep unit test suite for plugins/learning/buddy_learning/service.py."""

    def test_learning_helpers(self):
        # _clean_tags
        self.assertEqual(learning_service._clean_tags(None), [])
        self.assertEqual(learning_service._clean_tags([" Math ", "math", "", "Science"]), ["math", "science"])

        # _derive_note_title
        self.assertEqual(learning_service._derive_note_title("Custom Title", "body text"), "Custom Title")
        self.assertEqual(learning_service._derive_note_title(None, "First line\nSecond line"), "First line")
        self.assertEqual(learning_service._derive_note_title(None, ""), "Class note")

        # _norm_lang supports en, el, hi
        self.assertEqual(learning_service._norm_lang(None), "en")
        self.assertEqual(learning_service._norm_lang("el-GR"), "el")
        self.assertEqual(learning_service._norm_lang("hi_IN"), "hi")
        self.assertEqual(learning_service._norm_lang("fr-FR"), "en")

        # chapter_plain strips HTML
        parsed_doc = {
            "chapters": [{"id": "c1", "path": "ch1.html", "title": "Intro"}],
            "assets": {"ch1.html": {"content": b"<html><body><p>Hello <b>World</b></p></body></html>"}}
        }
        plain = learning_service.chapter_plain(parsed_doc, "c1")
        self.assertIn("Hello", plain)
        self.assertIn("World", plain)

        # _is_real_db
        self.assertFalse(learning_service._is_real_db(MockDB()))
        real_db = SimpleNamespace(info=object())
        self.assertTrue(learning_service._is_real_db(real_db))

    def test_learning_models(self):
        # FolderInput
        f = learning_service.FolderInput(name="Math 101")
        self.assertEqual(f.name, "Math 101")
        with self.assertRaises(ValidationError):
            learning_service.FolderInput(name="")

        # ClassNoteInput and Patch
        n = learning_service.ClassNoteInput(body="Test body", tags=["tag1"])
        self.assertEqual(n.body, "Test body")
        p = learning_service.ClassNotePatch(title="New Title")
        self.assertEqual(p.title, "New Title")

        # Bookmark & Progress
        b = learning_service.Bookmark(chapter_id="ch-1", label="Key topic")
        self.assertEqual(b.chapter_id, "ch-1")
        self.assertEqual(b.label, "Key topic")
        pr = learning_service.Progress(chapter_id="ch-1", page=10)
        self.assertEqual(pr.page, 10)

    def test_learning_auth_guards(self):
        # admin guard
        admin_user = {"username": "admin", "is_admin": True}
        non_admin = {"username": "student", "is_admin": False}
        self.assertEqual(learning_service.admin(admin_user), admin_user)
        with self.assertRaises(HTTPException) as ctx:
            learning_service.admin(non_admin)
        self.assertEqual(ctx.exception.status_code, 403)

        # teacher guard
        db_teacher = MockDB(fetchone_val={"1": 1})
        with patch.object(job_queue, "_connect", return_value=db_teacher):
            self.assertEqual(learning_service.teacher(admin_user), admin_user)
            self.assertEqual(learning_service.teacher(non_admin), non_admin)

        db_not_teacher = MockDB(fetchone_val=None)
        with patch.object(job_queue, "_connect", return_value=db_not_teacher):
            with self.assertRaises(HTTPException) as ctx2:
                learning_service.teacher(non_admin)
            self.assertEqual(ctx2.exception.status_code, 403)

    def test_learning_folder_and_quiz_services(self):
        user_info = {"username": "alice", "is_admin": True}

        # me endpoint
        db_me = MockDB(fetchone_val={"username": "alice", "is_admin": True})
        with patch.object(job_queue, "_connect", return_value=db_me):
            self.assertEqual(learning_service.me(user_info)["username"], "alice")

        # users & groups
        db_users = MockDB(fetchall_val=[{"username": "u1", "display_name": "User One"}])
        with patch.object(job_queue, "_connect", return_value=db_users):
            u_list = learning_service.users(user_info)
            self.assertEqual(len(u_list["items"]), 1)

        db_groups = MockDB(fetchall_val=[{"path": "/GroupA"}])
        with patch.object(job_queue, "_connect", return_value=db_groups):
            g_list = learning_service.groups(user_info)
            self.assertEqual(len(g_list["items"]), 1)

        # create_folder and rename_folder
        db_folder = MockDB(fetchone_val={"id": uuid4(), "name": "Biology"})
        with patch.object(job_queue, "_connect", return_value=db_folder):
            created = learning_service.create_folder(learning_service.FolderInput(name="Biology"), user_info)
            self.assertIn("id", created)

            renamed = learning_service.rename_folder(created["id"], learning_service.FolderInput(name="Adv Biology"), user_info)
            self.assertIn("id", renamed)

        # publish and close quiz
        q_id = uuid4()
        with patch.object(job_queue, "_connect", return_value=MockDB()), \
             patch("buddy_learning.service.store.quiz", return_value={"id": q_id, "folder_id": uuid4(), "status": "published", "version": 1}), \
             patch("buddy_learning.service.store.creator", return_value=True):
            self.assertEqual(learning_service.publish(q_id, user_info), {"published": True, "version": 1})

    def test_class_notes_crud(self):
        fid = uuid4()
        user = {"username": "alice", "is_admin": True}

        # list_class_notes
        db_notes = MockDB(fetchall_val=[{"id": uuid4(), "title": "Note 1"}])
        with patch.object(job_queue, "_connect", return_value=db_notes), \
             patch("buddy_learning.service.store.folder"):
            res = learning_service.list_class_notes(fid, user=user)
            self.assertEqual(len(res["items"]), 1)

        # create_class_note empty body raises 422
        with self.assertRaises(HTTPException) as ctx:
            learning_service.create_class_note(fid, learning_service.ClassNoteInput(body="   "), user=user)
        self.assertEqual(ctx.exception.status_code, 422)

        # create_class_note valid
        db_create = MockDB(fetchone_val={"id": uuid4(), "title": "Title", "body": "Body", "color": "yellow", "tags": [], "favorite": False, "bob_note_id": None, "created_at": "now", "updated_at": "now"})
        with patch.object(job_queue, "_connect", return_value=db_create), \
             patch("buddy_learning.service.store.folder", return_value={"name": "Bio"}):
            created = learning_service.create_class_note(fid, learning_service.ClassNoteInput(body="Note body"), user=user)
            self.assertEqual(created["title"], "Title")


# ===========================================================================
# 7. app/main.py Coverage Tests
# ===========================================================================

class MainCoverageTests(unittest.TestCase):
    """Deep unit test suite for app/main.py."""

    def test_main_helpers(self):
        # _public_base_url
        with patch.dict(os.environ, {"PUBLIC_BASE_URL": "https://buddy.acp.internal/"}):
            self.assertEqual(main._public_base_url(), "https://buddy.acp.internal")

        # _agent_card
        card = main._agent_card()
        self.assertEqual(card["protocolVersion"], "0.3.0")
        self.assertEqual(card["name"], "Buddy")
        self.assertIn("skills", card)

        # _file_scope
        self.assertEqual(main._file_scope("alice", "legacy"), "session:legacy")
        with self.assertRaises(HTTPException) as ctx:
            main._file_scope("alice", "")
        self.assertEqual(ctx.exception.status_code, 404)
        with patch("app.main.storage_scope", return_value="alice:session1"):
            self.assertEqual(main._file_scope("alice", "0" * 32), "alice:session1")

        with self.assertRaises(HTTPException) as ctx2:
            main._file_scope("alice", "invalid_id_not_32_hex")
        self.assertEqual(ctx2.exception.status_code, 404)

    def test_extract_a2a_text(self):
        # 1. params.message.parts with kind == 'text'
        body1 = {
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": "Part text 1"}, {"kind": "text", "text": "Part text 2"}]
                }
            }
        }
        self.assertEqual(main._extract_a2a_text(body1), "Part text 1\nPart text 2")

        # 2. params.message.text
        body2 = {"params": {"message": {"text": "Message direct text"}}}
        self.assertEqual(main._extract_a2a_text(body2), "Message direct text")

        # 3. params.prompt
        body3 = {"params": {"prompt": "Prompt direct text"}}
        self.assertEqual(main._extract_a2a_text(body3), "Prompt direct text")

        # 4. params.text
        body4 = {"params": {"text": "Params direct text"}}
        self.assertEqual(main._extract_a2a_text(body4), "Params direct text")

        # 5. Missing / empty raises ValueError
        with self.assertRaises(ValueError):
            main._extract_a2a_text({"params": {}})

    def test_workspace_page_resolution(self):
        tmp_dir = tempfile.TemporaryDirectory(prefix="main-page-test-")
        self.addCleanup(tmp_dir.cleanup)
        root = Path(tmp_dir.name)

        # Non-html extension raises 400
        with self.assertRaises(HTTPException) as ctx:
            main._workspace_page("file.txt", root)
        self.assertEqual(ctx.exception.status_code, 400)

        # Non-existent html file raises 404
        with self.assertRaises(HTTPException) as ctx2:
            main._workspace_page("missing.html", root)
        self.assertEqual(ctx2.exception.status_code, 404)

        # Valid html file resolves cleanly
        valid_page = root / "dashboard.html"
        valid_page.write_text("<h1>Dashboard</h1>")
        res_path = main._workspace_page("dashboard.html", root)
        self.assertEqual(res_path, valid_page.resolve())

    def test_stream_request_model_validators(self):
        # Valid timezone
        req = main.StreamRequest(prompt="hello", client_timezone="America/New_York")
        self.assertEqual(req.client_timezone, "America/New_York")

        # Invalid timezone raises ValidationError
        with self.assertRaises(ValidationError):
            main.StreamRequest(prompt="hello", client_timezone="Invalid/Timezone_Name_X")

        # Invalid agent slugs
        with patch("app.agent_attachments.validate_slugs", side_effect=ValueError("Bad slug")):
            with self.assertRaises(ValidationError):
                main.StreamRequest(prompt="hello", agent_slugs=["bad_slug"])

    def test_main_endpoints_direct(self):
        async def run_endpoints():
            user = {"username": "alice", "is_admin": True}

            # plugin_capabilities
            caps = await main.plugin_capabilities(user)
            self.assertIn("plugins", caps)

            # skills endpoint
            with patch("app.main.list_skills", return_value=[{"name": "test-skill"}]):
                skill_list = await main.skills(user)
                self.assertEqual(skill_list, [{"name": "test-skill"}])

            # modes endpoint
            with patch("app.main.list_modes", return_value=[{"slug": "agent"}]):
                mode_list = await main.modes(user)
                self.assertEqual(mode_list, [{"slug": "agent"}])

            # auth_logout
            mock_req = MagicMock()
            mock_resp = MagicMock()
            with patch("app.main.end_session") as mock_end_session:
                res_logout = await main.auth_logout(mock_req, mock_resp)
                self.assertEqual(res_logout, {"ok": True})
                mock_end_session.assert_called_once_with(mock_req, mock_resp)

        asyncio.run(run_endpoints())

    def test_main_http_api_routes(self):
        user = {"username": "alice", "is_admin": True}

        async def identity(request=None):
            return user

        patcher = patch("app.auth.current_user", identity)
        patcher.start()
        self.addCleanup(patcher.stop)
        main.app.dependency_overrides[main.current_user] = identity
        main.app.middleware_stack = None
        self.addCleanup(setattr, main.app, "middleware_stack", None)
        self.addCleanup(main.app.dependency_overrides.clear)

        client = TestClient(main.app)
        self.addCleanup(client.close)

        # GET /health
        resp = client.get("/health")
        self.assertEqual(resp.status_code, 200)

        # GET /.well-known/agent-card.json
        resp_card = client.get("/.well-known/agent-card.json")
        self.assertEqual(resp_card.status_code, 200)

        # GET /.well-known/agent.json
        resp_agent = client.get("/.well-known/agent.json")
        self.assertEqual(resp_agent.status_code, 200)

        # GET /api/plugins
        resp_plug = client.get("/api/plugins")
        self.assertEqual(resp_plug.status_code, 200)

        # POST /a2a invalid jsonrpc version
        resp_a2a = client.post("/a2a", headers={"origin": "http://testserver"}, json={"jsonrpc": "1.0", "id": "1"})
        self.assertEqual(resp_a2a.status_code, 200)
        self.assertIn("error", resp_a2a.json())


if __name__ == "__main__":
    unittest.main()
