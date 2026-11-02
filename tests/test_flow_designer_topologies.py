import unittest
from app.decisions_buddy.flow_designer import generate_decision_flow
from app.decisions_buddy.safe_expression import validate_graph
from app.decisions_buddy.decision_engine import DecisionEngine


class FlowDesignerTopologyTests(unittest.TestCase):

    def test_routing_switch_flow_topology(self):
        prompt = "Create a customer loyalty flow with a switch router: VIP members route to VIP perks and standard members route to standard perks"
        flow = generate_decision_flow(prompt)
        self.assertIn("switchNode", [n["type"] for n in flow["graph"]["nodes"]])
        self.assertIn("node_switch", [n["id"] for n in flow["graph"]["nodes"]])
        validate_graph(flow["graph"])

        # Execute with VIP input
        engine = DecisionEngine()
        res_vip = engine.evaluate(flow["graph"], {"customer": {"tier": "VIP", "totalSpend": 1500}})
        out_vip = res_vip.get("result", {})
        self.assertIn("discountPercent", out_vip)
        self.assertEqual(out_vip["discountPercent"], 25)
        self.assertEqual(out_vip["loyaltyPerk"], "CONCIERGE_ACCESS")

        # Execute with standard input (fallback)
        res_std = engine.evaluate(flow["graph"], {"customer": {"tier": "STANDARD", "totalSpend": 200}})
        out_std = res_std.get("result", {})
        self.assertIn("discountPercent", out_std)
        self.assertEqual(out_std["discountPercent"], 0)

    def test_calculation_expression_flow_topology(self):
        prompt = "Design an e-commerce order flow with a promotional discount table followed by an expression calculation computing tax and final total"
        flow = generate_decision_flow(prompt)
        node_types = [n["type"] for n in flow["graph"]["nodes"]]
        self.assertIn("expressionNode", node_types)
        self.assertIn("decisionTableNode", node_types)
        validate_graph(flow["graph"])

        # Execute through decision engine
        engine = DecisionEngine()
        res = engine.evaluate(flow["graph"], {"cart": {"total": 100, "couponCode": "PROMO20"}})
        out = res.get("result", {})
        self.assertIn("discountPercent", out)
        self.assertIn("finalTotal", out)
        self.assertEqual(out["discountPercent"], 20)
        self.assertEqual(out["finalTotal"], 95.2)

    def test_multistage_flow_topology(self):
        prompt = "Build a two-step multi-stage screening and offer matrix flow for applicant loan"
        flow = generate_decision_flow(prompt)
        node_types = [n["type"] for n in flow["graph"]["nodes"]]
        table_count = sum(1 for t in node_types if t == "decisionTableNode")
        self.assertGreaterEqual(table_count, 2)
        validate_graph(flow["graph"])

        # Execute through decision engine using default input
        engine = DecisionEngine()
        res = engine.evaluate(flow["graph"], flow["defaultInput"])
        out = res.get("result", {})
        self.assertEqual(out.get("isEligible"), "YES")

    def test_watsonx_retention_flow_topology(self):
        prompt = "Design a customer churn retention flow using watsonx ML predictive scoring deployment"
        flow = generate_decision_flow(prompt)
        node_types = [n["type"] for n in flow["graph"]["nodes"]]
        self.assertIn("watsonxMlNode", node_types)
        self.assertIn("decisionTableNode", node_types)
        validate_graph(flow["graph"])


if __name__ == "__main__":
    unittest.main()
