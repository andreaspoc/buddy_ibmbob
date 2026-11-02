"""
Pre-defined Decision Models following GoRules JSON Decision Model (JDM) specification.
Includes built-in business models and loads official GoRules test decision graphs.
"""

import json
import os
from pathlib import Path

# Built-in models
SAMPLE_DECISIONS = {
    "ecommerce-pricing": {
        "id": "ecommerce-pricing",
        "name": "E-Commerce Pricing & Promotion Engine",
        "description": "Calculates tier-based discounts, free shipping eligibility, and final checkout price.",
        "defaultInput": {
            "cart": {
                "total": 240.0,
                "itemCount": 4
            },
            "customer": {
                "tier": "VIP",
                "country": "US",
                "loyaltyYears": 3
            }
        },
        "graph": {
            "nodes": [
                {
                    "id": "node_input",
                    "name": "Request Input",
                    "type": "inputNode",
                    "content": {}
                },
                {
                    "id": "node_table_discount",
                    "name": "Discount Matrix",
                    "type": "decisionTableNode",
                    "content": {
                        "hitPolicy": "first",
                        "inputs": [
                            {"id": "c_tier", "field": "customer.tier", "name": "Customer Tier"},
                            {"id": "c_total", "field": "cart.total", "name": "Cart Total"},
                            {"id": "c_country", "field": "customer.country", "name": "Country"}
                        ],
                        "outputs": [
                            {"id": "out_discount", "field": "discountPercent", "name": "Discount %"},
                            {"id": "out_shipping", "field": "freeShipping", "name": "Free Shipping"},
                            {"id": "out_bonus", "field": "bonusPoints", "name": "Bonus Points"}
                        ],
                        "rules": [
                            {
                                "_id": "r1",
                                "_description": "VIP Customers with orders over $150 get 25% off + free shipping + 500 bonus points",
                                "c_tier": "VIP",
                                "c_total": ">= 150",
                                "c_country": "-",
                                "out_discount": 25,
                                "out_shipping": True,
                                "out_bonus": 500
                            },
                            {
                                "_id": "r2",
                                "_description": "VIP Customers under $150 get 15% off + free shipping",
                                "c_tier": "VIP",
                                "c_total": "< 150",
                                "c_country": "-",
                                "out_discount": 15,
                                "out_shipping": True,
                                "out_bonus": 200
                            },
                            {
                                "_id": "r3",
                                "_description": "Gold Tier with orders >= $100 gets 15% off + free shipping (US/CA only)",
                                "c_tier": "Gold",
                                "c_total": ">= 100",
                                "c_country": "in ['US', 'CA']",
                                "out_discount": 15,
                                "out_shipping": True,
                                "out_bonus": 250
                            },
                            {
                                "_id": "r4",
                                "_description": "Gold Tier international >= $100 gets 10% off",
                                "c_tier": "Gold",
                                "c_total": ">= 100",
                                "c_country": "-",
                                "out_discount": 10,
                                "out_shipping": False,
                                "out_bonus": 100
                            },
                            {
                                "_id": "r5",
                                "_description": "Regular customers with high cart total (>= 200) get 10% off + free shipping",
                                "c_tier": "-",
                                "c_total": ">= 200",
                                "c_country": "in ['US', 'CA']",
                                "out_discount": 10,
                                "out_shipping": True,
                                "out_bonus": 50
                            },
                            {
                                "_id": "r6",
                                "_description": "Default base policy (no discount, standard shipping)",
                                "c_tier": "-",
                                "c_total": "-",
                                "c_country": "-",
                                "out_discount": 0,
                                "out_shipping": False,
                                "out_bonus": 0
                            }
                        ]
                    }
                },
                {
                    "id": "node_expr_calc",
                    "name": "Price Calculation",
                    "type": "expressionNode",
                    "content": {
                        "expressions": [
                            {"key": "discountAmount", "value": "round(cart['total'] * (discountPercent / 100.0), 2)"},
                            {"key": "shippingFee", "value": "0.0 if freeShipping else 14.99"},
                            {"key": "taxAmount", "value": "round((cart['total'] - (cart['total'] * (discountPercent / 100.0))) * 0.08, 2)"},
                            {"key": "finalTotal", "value": "round(cart['total'] - (cart['total'] * (discountPercent / 100.0)) + (0.0 if freeShipping else 14.99) + ((cart['total'] - (cart['total'] * (discountPercent / 100.0))) * 0.08), 2)"}
                        ]
                    }
                },
                {
                    "id": "node_output",
                    "name": "Pricing Result",
                    "type": "outputNode",
                    "content": {
                        "schema": ["discountPercent", "discountAmount", "freeShipping", "shippingFee", "taxAmount", "finalTotal", "bonusPoints"]
                    }
                }
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_table_discount"},
                {"id": "e2", "sourceId": "node_table_discount", "targetId": "node_expr_calc"},
                {"id": "e3", "sourceId": "node_expr_calc", "targetId": "node_output"}
            ]
        }
    },

    "fraud-risk-scoring": {
        "id": "fraud-risk-scoring",
        "name": "Real-time Fraud & Anomaly Detector",
        "description": "Uses collect-policy decision tables to aggregate multiple risk triggers into a composite score.",
        "defaultInput": {
            "transaction": {
                "amount": 3200.0,
                "isForeignCountry": True,
                "velocityLastHour": 6,
                "deviceMatchesProfile": False
            },
            "user": {
                "accountAgeDays": 12,
                "priorFraudReport": False
            }
        },
        "graph": {
            "nodes": [
                {
                    "id": "node_input",
                    "name": "Transaction Event",
                    "type": "inputNode",
                    "content": {}
                },
                {
                    "id": "node_table_rules",
                    "name": "Risk Trigger Matrix (Collect)",
                    "type": "decisionTableNode",
                    "content": {
                        "hitPolicy": "collect",
                        "inputs": [
                            {"id": "c_amt", "field": "transaction.amount", "name": "Tx Amount"},
                            {"id": "c_foreign", "field": "transaction.isForeignCountry", "name": "Foreign Country"},
                            {"id": "c_vel", "field": "transaction.velocityLastHour", "name": "Hourly Velocity"},
                            {"id": "c_age", "field": "user.accountAgeDays", "name": "Account Age (Days)"}
                        ],
                        "outputs": [
                            {"id": "out_flag", "field": "flagName", "name": "Triggered Flag"},
                            {"id": "out_pts", "field": "riskPoints", "name": "Risk Points"}
                        ],
                        "rules": [
                            {
                                "_id": "f1",
                                "_description": "Very high transaction amount (>= $2,500)",
                                "c_amt": ">= 2500",
                                "c_foreign": "-",
                                "c_vel": "-",
                                "c_age": "-",
                                "out_flag": "HIGH_VALUE_TX",
                                "out_pts": 35
                            },
                            {
                                "_id": "f2",
                                "_description": "Foreign country on new account (<= 30 days)",
                                "c_amt": "-",
                                "c_foreign": "true",
                                "c_vel": "-",
                                "c_age": "<= 30",
                                "out_flag": "FOREIGN_NEW_ACCOUNT",
                                "out_pts": 40
                            },
                            {
                                "_id": "f3",
                                "_description": "High velocity (> 5 transactions in last hour)",
                                "c_amt": "-",
                                "c_foreign": "-",
                                "c_vel": "> 5",
                                "c_age": "-",
                                "out_flag": "VELOCITY_BURST",
                                "out_pts": 30
                            },
                            {
                                "_id": "f4",
                                "_description": "Moderate amount on foreign card",
                                "c_amt": "[500..2499]",
                                "c_foreign": "true",
                                "c_vel": "-",
                                "c_age": "-",
                                "out_flag": "FOREIGN_CARD_ACTIVITY",
                                "out_pts": 15
                            }
                        ]
                    }
                },
                {
                    "id": "node_function_score",
                    "name": "Score Aggregator",
                    "type": "functionNode",
                    "content": {
                        "source": """
flags = input.get("Risk Trigger Matrix (Collect)", [])
total_score = sum(f.get("riskPoints", 0) for f in flags)
flag_names = [f.get("flagName") for f in flags]

if total_score >= 70:
    action = "BLOCK"
    recommendation = "Decline immediately: Multiple high-severity fraud indicators detected."
elif total_score >= 35:
    action = "CHALLENGE_2FA"
    recommendation = "Step-up verification required via biometric or SMS OTP."
else:
    action = "ALLOW"
    recommendation = "Low risk transaction: approve automatically."

output = {
    "totalRiskScore": total_score,
    "action": action,
    "recommendation": recommendation,
    "triggeredFlags": flag_names,
    "flagCount": len(flag_names)
}
"""
                    }
                },
                {
                    "id": "node_output",
                    "name": "Fraud Assessment",
                    "type": "outputNode",
                    "content": {
                        "schema": ["totalRiskScore", "action", "recommendation", "triggeredFlags", "flagCount"]
                    }
                }
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_table_rules"},
                {"id": "e2", "sourceId": "node_table_rules", "targetId": "node_function_score"},
                {"id": "e3", "sourceId": "node_function_score", "targetId": "node_output"}
            ]
        }
    }
}

# Load official GoRules test decision graphs if available
test_data_location = os.environ.get("DECISION_TEST_DATA_DIR")
test_data_dir = Path(test_data_location) if test_data_location else None
if test_data_dir and test_data_dir.exists():
    # 1. Credit analysis
    ca_path = test_data_dir / "credit-analysis.json"
    if ca_path.exists():
        try:
            with open(ca_path) as f:
                ca_graph = json.load(f)
            SAMPLE_DECISIONS["credit-analysis"] = {
                "id": "credit-analysis",
                "name": "Official GoRules: Corporate Credit Analysis",
                "description": "Multi-table business evaluation with Company Type, Turnover, Country flags, and Overall mapping function.",
                "defaultInput": {
                    "company": {
                        "country": "US",
                        "isEu": False,
                        "type": "LLC",
                        "turnover": 1500000
                    }
                },
                "graph": ca_graph
            }
        except Exception as e:
            print("Failed loading credit-analysis.json:", e)

    # 2. Switch node
    sn_path = test_data_dir / "switch-node.json"
    if sn_path.exists():
        try:
            with open(sn_path) as f:
                sn_graph = json.load(f)
            SAMPLE_DECISIONS["switch-node"] = {
                "id": "switch-node",
                "name": "Official GoRules: Conditional Switch Router",
                "description": "Conditional branch routing based on input color ('yellow', 'red', etc.)",
                "defaultInput": {
                    "color": "yellow"
                },
                "graph": sn_graph
            }
        except Exception as e:
            print("Failed loading switch-node.json:", e)

    # 3. Decision table basic
    dt_path = test_data_dir / "table.json"
    if dt_path.exists():
        try:
            with open(dt_path) as f:
                dt_graph = json.load(f)
            SAMPLE_DECISIONS["table-basic"] = {
                "id": "table-basic",
                "name": "Official GoRules: Basic Decision Table",
                "description": "Simple boundary check (> 10 -> 10, else 0)",
                "defaultInput": {
                    "input": 15
                },
                "graph": dt_graph
            }
        except Exception as e:
            print("Failed loading table.json:", e)
