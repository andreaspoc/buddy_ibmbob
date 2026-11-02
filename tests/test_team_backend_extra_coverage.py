"""High-density unit tests targeting core backend utilities and models for SonarQube coverage."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
for p in (str(ROOT), str(PLUGINS / "learning"), str(PLUGINS / "people"), str(PLUGINS / "office"), str(PLUGINS / "projects")):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.main import (
    _extract_a2a_text,
    _workspace_page,
    _public_base_url,
    _agent_card,
    StreamRequest,
)
from app import workspace_config as config
from app.decisions_buddy.watsonx_inference import (
    _validate_watsonx_url,
    _render_template,
    _simulate_ai_response,
    _simulate_ml_scoring,
    execute_watsonx_ai,
    execute_watsonx_ml,
)
from fastapi import HTTPException


class BackendExtraCoverageTests(unittest.TestCase):
    def test_extract_a2a_text_variations(self):
        # 1. Text part v0.3
        body_v03 = {
            "params": {
                "message": {
                    "parts": [{"kind": "text", "text": "Hello from A2A"}]
                }
            }
        }
        self.assertEqual(_extract_a2a_text(body_v03), "Hello from A2A")

        # 2. Unified part shape without kind
        body_unified = {
            "params": {
                "message": {
                    "parts": [{"text": "Unified text chunk"}]
                }
            }
        }
        self.assertEqual(_extract_a2a_text(body_unified), "Unified text chunk")

        # 3. Message text directly
        body_msg_text = {"params": {"message": {"text": "Direct message"}}}
        self.assertEqual(_extract_a2a_text(body_msg_text), "Direct message")

        # 4. Params prompt
        body_prompt = {"params": {"prompt": "Prompt parameter"}}
        self.assertEqual(_extract_a2a_text(body_prompt), "Prompt parameter")

        # 5. Params text
        body_param_text = {"params": {"text": "Text parameter"}}
        self.assertEqual(_extract_a2a_text(body_param_text), "Text parameter")

        # 6. Invalid / empty body raises ValueError
        with self.assertRaises(ValueError):
            _extract_a2a_text({})
        with self.assertRaises(ValueError):
            _extract_a2a_text({"params": {"message": {"parts": []}}})

    def test_workspace_page_resolution(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            html_file = root / "dashboard.html"
            html_file.write_text("<html><body>Dashboard</body></html>")

            # Valid html page
            res = _workspace_page("dashboard.html", root)
            self.assertEqual(res, html_file)

            # Non-html extension rejected with 400
            txt_file = root / "secret.txt"
            txt_file.write_text("secret")
            with self.assertRaises(HTTPException) as ctx:
                _workspace_page("secret.txt", root)
            self.assertEqual(ctx.exception.status_code, 400)

            # Missing html page rejected with 404
            with self.assertRaises(HTTPException) as ctx404:
                _workspace_page("nonexistent.html", root)
            self.assertEqual(ctx404.exception.status_code, 404)

    def test_public_base_url_and_agent_card(self):
        with patch.dict(os.environ, {"PUBLIC_BASE_URL": "https://example.com/api/"}):
            self.assertEqual(_public_base_url(), "https://example.com/api")
            card = _agent_card()
            self.assertEqual(card["protocolVersion"], "0.3.0")
            self.assertEqual(card["url"], "https://example.com/api/a2a")
            self.assertTrue(len(card["skills"]) >= 1)

    def test_stream_request_validation(self):
        # Valid minimal request
        req = StreamRequest(prompt="Analyze system logs")
        self.assertEqual(req.prompt, "Analyze system logs")
        self.assertEqual(req.client_timezone, "UTC")
        self.assertEqual(req.ui_language, "en")

        # Invalid timezone raises
        with self.assertRaises(ValueError):
            StreamRequest(prompt="Test", client_timezone="Invalid/Timezone_FooBar")

    def test_workspace_config_helpers(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with patch.dict(os.environ, {"BOB_WORKSPACE": str(root)}):
                # resolve_skill_name
                self.assertEqual(config.resolve_skill_name("code-review"), "code-review-buddy")
                self.assertEqual(config.resolve_skill_name("code-review-buddy"), "code-review-buddy")

                # _validate_skill
                self.assertIsNone(config._validate_skill("valid-skill", "Sample instructions"))
                with self.assertRaises(ValueError):
                    config._validate_skill("INVALID SKILL NAME")
                with self.assertRaises(ValueError):
                    config._validate_skill("tool-short", "   ")

                # ensure_brave_mcp with mocked migrate and builtin
                with patch("app.workspace_config.migrate_mcp_registry"), patch("app.mcp_access.ensure_builtin"):
                    mcp_file = root / ".agents" / "mcp.json"
                    config.ensure_brave_mcp(target_path=mcp_file)
                    self.assertTrue(mcp_file.exists())

                    # ensure_microsoft_mcp & remove_microsoft_mcp
                    config.ensure_microsoft_mcp()
                    config.remove_microsoft_mcp()

    def test_watsonx_inference_components(self):
        # URL validation
        with self.assertRaises(ValueError):
            _validate_watsonx_url("http://insecure.endpoint.local")

        # Template rendering
        tmpl = "Review account for {customer.name} with score {customer.score}"
        rendered = _render_template(tmpl, {"customer": {"name": "Alice", "score": 850}})
        self.assertEqual(rendered, "Review account for Alice with score 850")

        # AI simulation scenarios
        resp_churn, risk = _simulate_ai_response("ibm/granite-13b-chat", "Calculate churn risk", {"customer": {"openTickets": 2}})
        self.assertIn("churnRisk", resp_churn)
        self.assertIsInstance(risk, float)

        resp_fraud, f_score = _simulate_ai_response("ibm/granite-13b-chat", "Check fraud anomaly", {"transaction": {"amount": 5000, "isForeignCountry": True}})
        self.assertIn("fraudRiskScore", resp_fraud)

        resp_credit, p_score = _simulate_ai_response("ibm/granite-13b-chat", "Credit underwriting", {"applicant": {"creditScore": 750}})
        self.assertIn("PRIME", resp_credit)

        resp_gen, g_score = _simulate_ai_response("ibm/granite-13b-chat", "General topic", {})
        self.assertIn("ELIGIBLE", resp_gen)

        # ML simulation scenarios
        reg_score, r_prob = _simulate_ml_scoring("deploy-reg-01", {"age": 42, "vip": True}, "regression")
        self.assertIsInstance(reg_score, float)

        cls_res, c_prob = _simulate_ml_scoring("deploy-cls-01", {"tickets": 1, "priority": False}, "classification")
        self.assertIn(cls_res, ["POSITIVE", "NEGATIVE"])
        self.assertIsInstance(c_prob, float)

    def test_execute_watsonx_ai_and_ml_simulated(self):
        ai_content = {
            "modelId": "ibm/granite-13b-chat",
            "promptTemplate": "Evaluate churn probability for {customer.name}",
            "outputField": "churn_evaluation"
        }
        ctx = {"customer": {"name": "Bob", "accountAgeMonths": 24, "openTickets": 1}}
        ai_out = execute_watsonx_ai(ai_content, ctx)
        self.assertIn("churn_evaluation", ai_out)

        ml_content = {
            "deploymentId": "deploy-churn-pred",
            "scoringType": "classification",
            "featureMapping": {"accountAge": "customer.accountAgeMonths"},
            "outputField": "ml_prediction"
        }
        ml_out = execute_watsonx_ml(ml_content, ctx)
        self.assertIn("ml_prediction", ml_out)

    def test_note_exports_utilities(self):
        from app import note_exports
        # metadata
        self.assertEqual(note_exports.metadata({"tags": ["a", "b"]}, "tags"), ["a", "b"])
        self.assertEqual(note_exports.metadata({"tags": '["c", "d"]'}, "tags"), ["c", "d"])
        self.assertEqual(note_exports.metadata({"tags": "invalid-json"}, "tags"), [])
        self.assertEqual(note_exports.metadata({"tags": 123}, "tags"), [])

        # safe_url
        self.assertTrue(note_exports.safe_url("https://example.com/doc"))
        self.assertTrue(note_exports.safe_url("http://example.org"))
        self.assertFalse(note_exports.safe_url("ftp://example.com"))
        self.assertFalse(note_exports.safe_url("javascript:alert(1)"))
        self.assertFalse(note_exports.safe_url("https://example.com/\x00evil"))
        self.assertFalse(note_exports.safe_url(None))

        # source_links
        row = {"sources": [{"url": "https://valid.com/a"}, {"url": "ftp://bad.com"}, "not-dict"]}
        links = note_exports.source_links(row)
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["url"], "https://valid.com/a")

        # printable_body
        body = "See [Google](https://google.com) and [Bad](javascript:alert(1)) <script>alert('xss')</script>"
        res = note_exports.printable_body(body)
        self.assertIn('<a href="https://google.com">Google</a>', res)
        self.assertIn('&lt;script&gt;', res)

        # markdown_document across languages
        rows = [
            {"id": 1, "title": "Note 1", "body": "Body 1", "collection": "Work", "tags": ["w1"], "sources": [{"url": "https://example.com"}]},
            {"id": 2, "title": "Note 2", "body": "Body 2", "collection": None, "tags": [], "sources": []}
        ]
        doc_en = note_exports.markdown_document(rows, "en")
        self.assertIn("# Saved notes", doc_en)
        self.assertIn("## Work", doc_en)
        self.assertIn("## Inbox", doc_en)

        doc_el = note_exports.markdown_document(rows, "el")
        self.assertIn("# Αποθηκευμένες σημειώσεις", doc_el)

    def test_research_sources_utilities(self):
        from app import research_sources
        # _key and _signature
        with patch.dict(os.environ, {"BOB_API_KEY": "test-secret-key-12345"}):
            key = research_sources._key()
            self.assertIsInstance(key, bytes)
            sig = research_sources._signature({"source": "https://example.com", "title": "Test Title"})
            self.assertIsInstance(sig, str)
            self.assertEqual(len(sig), 64)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                research_sources._key()

    def test_mcp_oauth_and_community_away(self):
        from app import mcp_oauth
        self.assertEqual(len(mcp_oauth.digest("test-val")), 64)
        err = mcp_oauth.OAuthError("Safe display message")
        self.assertEqual(str(err), "Safe display message")

        from buddy_people import community_away
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        valid_settings = community_away.Settings(
            enabled=True,
            instructions="Out of office until next week",
            starts_at=now,
            ends_at=now + timedelta(days=2)
        )
        self.assertTrue(valid_settings.enabled)

        # Naive datetime raises
        with self.assertRaises(ValueError):
            community_away.Settings(enabled=True, starts_at=datetime.now())

        # Empty instructions raises when enabled
        with self.assertRaises(ValueError):
            community_away.Settings(enabled=True, instructions="", starts_at=now, ends_at=now + timedelta(days=1))

    def test_course_completion_models(self):
        from buddy_learning import course_completion
        valid_approval = course_completion.Approval(
            expected_revision=1,
            evidence_digest="a" * 64,
            recipient_name="  Jane   Doe  ",
            note="Great work"
        )
        self.assertEqual(valid_approval.recipient_name, "Jane Doe")

        # Invalid digest regex
        with self.assertRaises(ValueError):
            course_completion.Approval(
                expected_revision=1,
                evidence_digest="invalid-digest",
                recipient_name="Jane Doe"
            )

        # Empty recipient name
        with self.assertRaises(ValueError):
            course_completion.Approval(
                expected_revision=1,
                evidence_digest="a" * 64,
                recipient_name="   "
            )

        claim = course_completion.ClaimCertificate(recipient_name="Alice Smith")
        self.assertEqual(claim.recipient_name, "Alice Smith")


if __name__ == "__main__":
    unittest.main()
