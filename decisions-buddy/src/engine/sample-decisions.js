export const SAMPLE_DECISION_MODELS = {
  'ecommerce-pricing': {
    id: 'ecommerce-pricing',
    name: 'E-Commerce Pricing & Promotion Engine',
    description: 'Calculates tier-based discounts, free shipping eligibility, and final checkout price with tax.',
    defaultInput: {
      cart: {
        total: 240.0,
        itemCount: 4
      },
      customer: {
        tier: 'VIP',
        country: 'US',
        loyaltyYears: 3
      }
    },
    graph: {
      nodes: [
        {
          id: 'node_input',
          name: 'Request Input',
          type: 'inputNode',
          content: {}
        },
        {
          id: 'node_table_discount',
          name: 'Discount Matrix',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'first',
            inputs: [
              { id: 'c_tier', field: 'customer.tier', name: 'Customer Tier' },
              { id: 'c_total', field: 'cart.total', name: 'Cart Total' },
              { id: 'c_country', field: 'customer.country', name: 'Country' }
            ],
            outputs: [
              { id: 'out_discount', field: 'discountPercent', name: 'Discount %' },
              { id: 'out_shipping', field: 'freeShipping', name: 'Free Shipping' },
              { id: 'out_bonus', field: 'bonusPoints', name: 'Bonus Points' }
            ],
            rules: [
              {
                _id: 'r1',
                _description: 'VIP Customers with orders over $150 get 25% off + free shipping + 500 bonus points',
                c_tier: 'VIP',
                c_total: '>= 150',
                c_country: '-',
                out_discount: 25,
                out_shipping: true,
                out_bonus: 500
              },
              {
                _id: 'r2',
                _description: 'VIP Customers under $150 get 15% off + free shipping',
                c_tier: 'VIP',
                c_total: '< 150',
                c_country: '-',
                out_discount: 15,
                out_shipping: true,
                out_bonus: 200
              },
              {
                _id: 'r3',
                _description: 'Gold Tier with orders >= $100 gets 15% off + free shipping (US/CA only)',
                c_tier: 'Gold',
                c_total: '>= 100',
                c_country: "in ['US', 'CA']",
                out_discount: 15,
                out_shipping: true,
                out_bonus: 250
              },
              {
                _id: 'r4',
                _description: 'Gold Tier international >= $100 gets 10% off',
                c_tier: 'Gold',
                c_total: '>= 100',
                c_country: '-',
                out_discount: 10,
                out_shipping: false,
                out_bonus: 100
              },
              {
                _id: 'r5',
                _description: 'Regular customers with high cart total (>= 200) get 10% off + free shipping',
                c_tier: '-',
                c_total: '>= 200',
                c_country: "in ['US', 'CA']",
                out_discount: 10,
                out_shipping: true,
                out_bonus: 50
              },
              {
                _id: 'r6',
                _description: 'Default base policy (no discount, standard shipping)',
                c_tier: '-',
                c_total: '-',
                c_country: '-',
                out_discount: 0,
                out_shipping: false,
                out_bonus: 0
              }
            ]
          }
        },
        {
          id: 'node_expr_calc',
          name: 'Price Calculation',
          type: 'expressionNode',
          content: {
            expressions: [
              { key: 'discountAmount', value: "round(cart.total * (discountPercent / 100), 2)" },
              { key: 'shippingFee', value: "freeShipping ? 0.0 : 14.99" },
              { key: 'taxAmount', value: "round((cart.total - (cart.total * (discountPercent / 100))) * 0.08, 2)" },
              { key: 'finalTotal', value: "round(cart.total - (cart.total * (discountPercent / 100)) + (freeShipping ? 0.0 : 14.99) + ((cart.total - (cart.total * (discountPercent / 100))) * 0.08), 2)" }
            ]
          }
        },
        {
          id: 'node_output',
          name: 'Pricing Result',
          type: 'outputNode',
          content: {
            schema: ['discountPercent', 'discountAmount', 'freeShipping', 'shippingFee', 'taxAmount', 'finalTotal', 'bonusPoints']
          }
        }
      ],
      edges: [
        { id: 'e1', sourceId: 'node_input', targetId: 'node_table_discount' },
        { id: 'e2', sourceId: 'node_table_discount', targetId: 'node_expr_calc' },
        { id: 'e3', sourceId: 'node_expr_calc', targetId: 'node_output' }
      ]
    }
  },

  'credit-underwriting': {
    id: 'credit-underwriting',
    name: 'Automated Loan Underwriting Matrix',
    description: 'Evaluates credit score brackets and debt-to-income ratio to approve, review, or decline loans.',
    defaultInput: {
      applicant: {
        creditScore: 760,
        monthlyIncome: 8500,
        debtToIncomeRatio: 0.28,
        requestedAmount: 25000,
        employmentYears: 4
      }
    },
    graph: {
      nodes: [
        {
          id: 'node_input',
          name: 'Applicant Data',
          type: 'inputNode',
          content: {}
        },
        {
          id: 'node_table_underwriting',
          name: 'Risk Matrix Table',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'first',
            inputs: [
              { id: 'c_score', field: 'applicant.creditScore', name: 'Credit Score' },
              { id: 'c_dti', field: 'applicant.debtToIncomeRatio', name: 'DTI Ratio' },
              { id: 'c_amount', field: 'applicant.requestedAmount', name: 'Requested Amount' }
            ],
            outputs: [
              { id: 'out_decision', field: 'decision', name: 'Decision' },
              { id: 'out_rate', field: 'annualInterestRate', name: 'APR %' },
              { id: 'out_max', field: 'maxApprovedAmount', name: 'Max Approved ($)' },
              { id: 'out_tier', field: 'riskTier', name: 'Risk Tier' }
            ],
            rules: [
              {
                _id: 'r1',
                _description: 'Prime Tier: High score (>= 750) and low DTI (<= 0.30)',
                c_score: '>= 750',
                c_dti: '<= 0.30',
                c_amount: '-',
                out_decision: 'APPROVED',
                out_rate: 5.49,
                out_max: 50000,
                out_tier: 'PRIME'
              },
              {
                _id: 'r2',
                _description: 'Near Prime: High score (>= 750) but moderate DTI (0.30..0.45)',
                c_score: '>= 750',
                c_dti: '[0.31..0.45]',
                c_amount: '-',
                out_decision: 'APPROVED',
                out_rate: 7.25,
                out_max: 35000,
                out_tier: 'NEAR_PRIME'
              },
              {
                _id: 'r3',
                _description: 'Good credit score (680..749) with healthy DTI (<= 0.35)',
                c_score: '[680..749]',
                c_dti: '<= 0.35',
                c_amount: '<= 30000',
                out_decision: 'APPROVED',
                out_rate: 8.99,
                out_max: 30000,
                out_tier: 'GOOD'
              },
              {
                _id: 'r4',
                _description: 'Fair credit or elevated DTI requires manual underwriting',
                c_score: '[620..679]',
                c_dti: '<= 0.45',
                c_amount: '-',
                out_decision: 'MANUAL_REVIEW',
                out_rate: 11.5,
                out_max: 15000,
                out_tier: 'SUBPRIME'
              },
              {
                _id: 'r5',
                _description: 'Excessive DTI (> 0.45) declined',
                c_score: '-',
                c_dti: '> 0.45',
                c_amount: '-',
                out_decision: 'DECLINED',
                out_rate: 0.0,
                out_max: 0,
                out_tier: 'HIGH_RISK'
              },
              {
                _id: 'r6',
                _description: 'Low credit score (< 620) declined',
                c_score: '< 620',
                c_dti: '-',
                c_amount: '-',
                out_decision: 'DECLINED',
                out_rate: 0.0,
                out_max: 0,
                out_tier: 'HIGH_RISK'
              }
            ]
          }
        },
        {
          id: 'node_expr_payment',
          name: 'Payment Calculator',
          type: 'expressionNode',
          content: {
            expressions: [
              {
                key: 'estimatedMonthlyPayment',
                value: "annualInterestRate > 0 ? round((applicant.requestedAmount * (annualInterestRate / 100 / 12)) / (1 - Math.pow(1 + (annualInterestRate / 100 / 12), -36)), 2) : 0.0"
              }
            ]
          }
        },
        {
          id: 'node_output',
          name: 'Underwriting Response',
          type: 'outputNode',
          content: {
            schema: ['decision', 'riskTier', 'annualInterestRate', 'maxApprovedAmount', 'estimatedMonthlyPayment']
          }
        }
      ],
      edges: [
        { id: 'e1', sourceId: 'node_input', targetId: 'node_table_underwriting' },
        { id: 'e2', sourceId: 'node_table_underwriting', targetId: 'node_expr_payment' },
        { id: 'e3', sourceId: 'node_expr_payment', targetId: 'node_output' }
      ]
    }
  },

  'fraud-risk-scoring': {
    id: 'fraud-risk-scoring',
    name: 'Real-time Fraud & Anomaly Detector',
    description: 'Uses collect-policy decision tables to aggregate multiple risk triggers into a composite score.',
    defaultInput: {
      transaction: {
        amount: 3200.0,
        isForeignCountry: true,
        velocityLastHour: 6,
        deviceMatchesProfile: false
      },
      user: {
        accountAgeDays: 12,
        priorFraudReport: false
      }
    },
    graph: {
      nodes: [
        {
          id: 'node_input',
          name: 'Transaction Event',
          type: 'inputNode',
          content: {}
        },
        {
          id: 'node_table_rules',
          name: 'Risk Trigger Matrix (Collect)',
          type: 'decisionTableNode',
          content: {
            hitPolicy: 'collect',
            inputs: [
              { id: 'c_amt', field: 'transaction.amount', name: 'Tx Amount' },
              { id: 'c_foreign', field: 'transaction.isForeignCountry', name: 'Foreign Country' },
              { id: 'c_vel', field: 'transaction.velocityLastHour', name: 'Hourly Velocity' },
              { id: 'c_age', field: 'user.accountAgeDays', name: 'Account Age (Days)' }
            ],
            outputs: [
              { id: 'out_flag', field: 'flagName', name: 'Triggered Flag' },
              { id: 'out_pts', field: 'riskPoints', name: 'Risk Points' }
            ],
            rules: [
              {
                _id: 'f1',
                _description: 'Very high transaction amount (>= $2,500)',
                c_amt: '>= 2500',
                c_foreign: '-',
                c_vel: '-',
                c_age: '-',
                out_flag: 'HIGH_VALUE_TX',
                out_pts: 35
              },
              {
                _id: 'f2',
                _description: 'Foreign country on new account (<= 30 days)',
                c_amt: '-',
                c_foreign: 'true',
                c_vel: '-',
                c_age: '<= 30',
                out_flag: 'FOREIGN_NEW_ACCOUNT',
                out_pts: 40
              },
              {
                _id: 'f3',
                _description: 'High velocity (> 5 transactions in last hour)',
                c_amt: '-',
                c_foreign: '-',
                c_vel: '> 5',
                c_age: '-',
                out_flag: 'VELOCITY_BURST',
                out_pts: 30
              },
              {
                _id: 'f4',
                _description: 'Moderate amount on foreign card',
                c_amt: '[500..2499]',
                c_foreign: 'true',
                c_vel: '-',
                c_age: '-',
                out_flag: 'FOREIGN_CARD_ACTIVITY',
                out_pts: 15
              }
            ]
          }
        },
        {
          id: 'node_function_score',
          name: 'Score Aggregator',
          type: 'functionNode',
          content: {
            source: `
              const flags = input['Risk Trigger Matrix (Collect)'] || [];
              const totalScore = flags.reduce((acc, f) => acc + (f.riskPoints || 0), 0);
              const flagNames = flags.map(f => f.flagName);

              let action = 'ALLOW';
              let recommendation = 'Low risk transaction: approve automatically.';

              if (totalScore >= 70) {
                action = 'BLOCK';
                recommendation = 'Decline immediately: Multiple high-severity fraud indicators detected.';
              } else if (totalScore >= 35) {
                action = 'CHALLENGE_2FA';
                recommendation = 'Step-up verification required via biometric or SMS OTP.';
              }

              output = {
                totalRiskScore: totalScore,
                action: action,
                recommendation: recommendation,
                triggeredFlags: flagNames,
                flagCount: flagNames.length
              };
            `
          }
        },
        {
          id: 'node_output',
          name: 'Fraud Assessment',
          type: 'outputNode',
          content: {
            schema: ['totalRiskScore', 'action', 'recommendation', 'triggeredFlags', 'flagCount']
          }
        }
      ],
      edges: [
        { id: 'e1', sourceId: 'node_input', targetId: 'node_table_rules' },
        { id: 'e2', sourceId: 'node_table_rules', targetId: 'node_function_score' },
        { id: 'e3', sourceId: 'node_function_score', targetId: 'node_output' }
      ]
    }
  }
};
