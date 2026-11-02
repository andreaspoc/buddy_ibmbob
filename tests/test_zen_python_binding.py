"""
Automated unit test for Python Zen-Engine Language Binding.
Verifies compatibility with official zen-engine PyPI specification.
"""
import unittest
import json
from zen_engine import ZenEngine, ZenDecision, ZenDecisionContent


class ZenPythonBindingTests(unittest.TestCase):
    def setUp(self):
        self.sample_graph = {
            "nodes": [
                {"id": "in", "type": "inputNode", "content": {}},
                {
                    "id": "tbl",
                    "type": "decisionTableNode",
                    "content": {
                        "hitPolicy": "ruleOrder",
                        "inputs": [{"id": "amount", "field": "cart.total"}],
                        "outputs": [{"id": "discount", "field": "discountRate"}],
                        "rules": [
                            {"_id": "r1", "amount": ">= 50", "discount": 0.05},
                            {"_id": "r2", "amount": ">= 100", "discount": 0.10},
                            {"_id": "r3", "amount": ">= 200", "discount": 0.20}
                        ]
                    }
                },
                {"id": "out", "type": "outputNode", "content": {}}
            ],
            "edges": [
                {"id": "e1", "sourceId": "in", "targetId": "tbl"},
                {"id": "e2", "sourceId": "tbl", "targetId": "out"}
            ]
        }

    def test_direct_decision_evaluation(self):
        engine = ZenEngine()
        decision = engine.create_decision(self.sample_graph)
        res = decision.evaluate({"cart": {"total": 150}}, options={"trace": True})

        self.assertIn("result", res)
        self.assertIn("performance", res)
        self.assertIn("trace", res)

        # ruleOrder should return r1 (>=50) and r2 (>=100)
        tbl_results = res["result"]["tbl"]
        self.assertEqual(len(tbl_results), 2)
        self.assertEqual(tbl_results[0]["discountRate"], 0.05)
        self.assertEqual(tbl_results[1]["discountRate"], 0.10)

    def test_bytes_and_string_loading(self):
        engine = ZenEngine()
        json_str = json.dumps(self.sample_graph)
        dec_from_str = engine.create_decision(json_str)
        dec_from_bytes = engine.create_decision(json_str.encode("utf-8"))

        res_str = dec_from_str.evaluate({"cart": {"total": 75}})
        res_bytes = dec_from_bytes.evaluate({"cart": {"total": 75}})

        self.assertEqual(len(res_str["result"]["tbl"]), 1)
        self.assertEqual(res_str["result"]["tbl"], res_bytes["result"]["tbl"])

    def test_custom_loader(self):
        store = {"pricing": self.sample_graph}
        engine = ZenEngine(options={"loader": lambda key: store.get(key)})

        res = engine.evaluate("pricing", {"cart": {"total": 250}})
        self.assertEqual(len(res["result"]["tbl"]), 3)


if __name__ == "__main__":
    unittest.main()
