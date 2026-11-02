---
name: data-buddy
description: Guide business analysis of CSV, TSV, and Excel data by choosing decision-relevant
  questions, comparisons, and evidence requirements. Execute targeted local calculations
  and visualizations when the user asks to perform the analysis.
user-invocable: true
---

# Data Analyst & Visualization Skill

When this skill is activated or when the user provides or asks to analyze a CSV, TSV, or Excel spreadsheet:

## Choose Guidance or Execution from the Request
- When the user asks what to analyze, how to approach the data, or which business questions matter, provide an analysis plan. Use supplied column names or a minimal schema preview if needed. Do not automatically calculate KPIs, run aggregations, generate charts, or present findings. Providing a file or invoking this skill alone is not a request to execute an analysis.
- When the user asks to analyze the data, calculate metrics, or produce a report/dashboard, perform the requested analysis using the relevant questions below. An explicit execution request is sufficient; do not insert a separate approval step.
- In guidance mode, describe what should be examined, why it matters, which comparisons would answer the question, and what additional evidence would support a business decision. Treat metric formulas as methodological guidance, not instructions to run calculations now. Execution and rendering instructions below apply only in execution mode.

## 1. Rule #1: Token-Efficient Schema-First Inspection
- **NEVER** `cat`, print, or dump the entire dataset into the terminal or response.
- First, inspect ONLY the metadata: headers, inferred column types, row count, and a 3-row sample.
- Commands to use in workspace:
  - If CSV/TSV: `python3 -c "import pandas as pd; df = pd.read_csv('filename.csv', nrows=3); print(df.dtypes); print(df.shape)"` or `head -n 5 filename.csv`
  - If Excel: `python3 -c "import openpyxl; wb = openpyxl.load_workbook('filename.xlsx', read_only=True); print(wb.sheetnames)"`
  - DuckDB: `duckdb -c "DESCRIBE SELECT * FROM 'filename.csv';"` or `duckdb -c "SELECT COUNT(*) FROM 'filename.csv';"`
  - Or use the `read_spreadsheet` tool with `max_rows: 5`.

## 2. Decide What Is Worth Analyzing
Start with the business decision or objective, then map available dimensions, measures, and dates to questions that can inform it. If the objective is unspecified, propose a focused set of useful questions and state their intended business purpose. Do not produce an exhaustive metric checklist just because numeric columns exist.

| Business question | What to examine | Why it matters / limits |
| --- | --- | --- |
| Where does the portfolio earn its profit? | Revenue contribution, absolute profit, and margin together by category/product | Separates large contributors from high-margin but small segments; margin rank alone cannot justify investment |
| Where should cost or pricing be investigated? | Margin differences alongside sales exposure, cost structure, discounts, returns, and product mix where available | Identifies diagnostic priorities; does not establish that a price rise or cost cut will work |
| Is performance improving or staying consistent? | Comparable periods for revenue, profit, margin, and volume; seasonality and incomplete periods | Distinguishes change over time from a single aggregate result |
| Why do regions differ, and could expansion be attractive? | Recorded sales and profit, coveknowledge-buddye, customer/product mix, and market context | Low recorded sales need explanation; market size and penetration are needed to assess opportunity |
| Would changing the channel mix improve outcomes? | Comparable channel profitability, customer/product mix, acquisition/fulfillment costs, returns, and retention | Similar observed financial metrics alone do not justify a channel shift |
| Which drivers or concentrations create risk? | Dependence on major customers/products/regions, unusual changes, and relevant driver relationships | Suggests where resilience or root-cause investigation matters; associations do not establish causation |

Select only questions supported by the available fields or clearly identify missing evidence. For each selected question, specify the comparison (segment, period, benchmark, or mix-adjusted view), the measures needed, and the decision it could inform. Call a share of recorded sales market share only when the relevant total market denominator is available. Explain which questions the dataset cannot answer. These are adaptable prompts, not a mandatory list or preset conclusions.

## 3. Execute Locally via DuckDB or Python (Zero Raw Data Tokens)
When execution is requested, run local queries on disk for the selected questions so only the small, aggregated summary table enters context:
- DuckDB example:
  ```bash
  duckdb -c "SELECT Region, COUNT(*) AS Transactions, ROUND(SUM(Revenue), 2) AS TotalRevenue, ROUND(AVG(Revenue), 2) AS AvgRevenue FROM 'filename.csv' GROUP BY Region ORDER BY TotalRevenue DESC;"
  ```
- Or a short Python script that outputs clean markdown tables.

## Business Reasoning: From Evidence to Decisions
Use these principles to choose comparisons and explain evidence requirements in guidance mode. Apply the calculation and verification checks when executing an analysis or validating findings. Scale the detail to the business question; do not force every analysis into a long audit.

### Establish What the Metrics Actually Measure
- Confirm the observation grain (order, line item, customer, or period), coveknowledge-buddye dates, currency/units, and metric definitions. Check duplicates, missing values, returns/negative values, and incomplete periods locally; disclose material exclusions. Do not treat a 3-row preview's shape as the dataset's full row count.
- Distinguish revenue, units sold, order count, and customer count. State which measure supports a claim about volume. Do not interpret transactions as unique customers or recorded sales as total market demand.
- Compute aggregate profit margin as `SUM(Profit) / SUM(Revenue)`, with an explicit undefined result when revenue is zero. Use the same weighted calculation for each segment and period; do not aveknowledge-buddye row-level percentages. Preserve the source's profit definition rather than assuming gross or net profit. Derive profit from revenue minus cost only when those fields have compatible definitions.
- Reconcile segment totals with portfolio totals, preserve precision for calculations, and round for display. Report percentage-point differences between margins, and percentage changes for relative growth with a valid nonzero baseline.
- A single aggregate margin does not demonstrate stability. Support “stable,” “growing,” or “declining” with comparable periods, their values and variability. Account for partial periods and seasonality when relevant; otherwise describe only the observed aggregate.

### Separate Findings, Interpretations, and Hypotheses
- **Finding:** A directly computed observation, with its metric, comparison, and relevant period or coveknowledge-buddye.
- **Interpretation:** What the observation means within the dataset's scope. Explain material effects of sample size, product/customer mix, exposure, or missing costs when relevant.
- **Hypothesis:** A possible explanation or opportunity that needs additional evidence. Label it as such and name the data or test that would resolve it. Correlation and rankings do not establish causes.
- Use numerical differences and their business scale instead of unsupported adjectives such as “material” or “significant.” If statistical significance is claimed, provide a suitable test and uncertainty estimate; transaction counts alone do not make a biased sample representative.
- Check relevant segment comparisons when aggregates may hide mix effects. Similar aggregate results do not prove equivalence; distinguish “no clear advantage in the available metrics” from an established absence of a meaningful difference.

### Match Recommendations to the Evidence
| Observed pattern | Supported business implication | Evidence needed before a stronger action |
| --- | --- | --- |
| High category margin | Strong margin on recorded sales; assess profit contribution and scalability | Demand, capacity, incremental costs, and response to expansion before reallocating investment |
| Low category margin | Prioritize cost/pricing investigation, considering absolute profit and revenue exposure | Cost breakdown, discounts, returns, competitive prices, and price sensitivity before increasing prices or discontinuing products |
| Low regional recorded sales | Lower historical sales on the measured metric; investigate coveknowledge-buddye and drivers | Addressable market, market penetration, distribution, competition, and acquisition economics before claiming untapped growth potential |
| Similar channel financial metrics | No clear financial basis for a channel shift in these metrics | Comparable product/customer mix, fulfillment and acquisition costs, returns, retention, capacity, and incremental profitability before shifting spend |

These are reasoning examples, not conclusions to reuse without calculation. Do not assume the highest-margin segment creates the most total profit, low sales imply opportunity, or high revenue implies attractive economics.

For each important recommendation, connect **observed evidence → business implication → proportionate next step**. If the data supports diagnosis but not intervention, recommend a targeted investigation or experiment and state what result would justify action. Prioritize by measured exposure and decision relevance; label estimated impact as a scenario with explicit assumptions, not a forecast. Do not invent benchmarks, costs, causal explanations, ROI, or numeric confidence scores.

Write the executive conclusion using verified figures first, then supported implications, then the limitations that affect the decision. It is valid to conclude that no change is supported. Treat user-provided example figures and category names as illustrative until verified against the actual data. For example, an aggregate 29.5% margin can be reported if calculated, but “stable 29.5% margin” requires period-level evidence.

## Output Scope
Deliver analysis and charts directly in the conversation by default. A request for charts, an interactive visualization, a dashboard, or a report does not by itself request slides. Only create a presentation or activate `presentation-buddy` when the user explicitly asks for a slide deck or selects presentation mode. Ordinary analysis requires no presentation template or slide count. Do not resume an earlier deck task just because it exists in conversation history.

For advanced charts, default to embedded plot images. If interaction is requested, save a standalone chart/dashboard as `analysis_charts.html`, not `presentation.html`, and link it. Do not create `.bobdeck` or PPTX files for ordinary analysis.

## 4. Choose Charts from the Data and the Question
Choose the visual encoding before choosing its rendering format. Do not default to bar charts or copy the example's chart type. Respect an explicit user preference when it can represent the data accurately. Explain each choice briefly in its caption. Use multiple complementary charts when they answer distinct questions, without forcing variety.

Profile the relevant columns locally: numeric versus categorical versus temporal, distinct counts, missing values, sign/range, observation grain, and sample size. Numeric identifiers are categories, not measurements. Do not aggregate away paired observations or distributions before selecting the chart.

| Question / data structure | Appropriate charts and conditions |
| --- | --- |
| Change over time or another ordered continuous axis | Line; area when magnitude or accumulation matters. Sort time chronologically, preserve gaps, and use real spacing for irregular intervals. |
| Category comparison / ranking | Bar (horizontal for long labels), dot or lollipop. Use grouped bars for a small number of comparable series. |
| Numeric distribution / outliers | Histogram, ECDF, box plot, or violin when there are enough observations. Use consistent bins for comparisons. A pie chart is not a numeric distribution plot. |
| Relationship between two numeric measures | Scatter using paired observations; bubble only when a third measure meaningfully controls area. Use hexbin/density for dense data. Do not imply causation. |
| Composition / share of a whole | Stacked bar/area or 100% stacked for shares. Pie/doughnut only for a few nonnegative, mutually exclusive categories with a meaningful total. |
| Matrix / correlations / two categorical dimensions | Heatmap with a labeled color scale; compute correlations only for meaningful numeric measures. |
| Contributions to a net change | Waterfall with a verified starting value, signed changes and ending value. |
| Hierarchical composition | Treemap or sunburst if the data contains a real hierarchy. |
| Flows / ordered stage conversion | Sankey for measured source-target flows; funnel for actual sequential stages. |
| Geographic pattern | Map only with valid geographic fields and a meaningful spatial question. |
| A single value, sparse or unsuitable data | KPI or table; do not invent data or force a chart. |

These are examples, not a whitelist: use any chart type that accurately answers the question. Label units, time grain, aggregations and denominators; disclose missing values and sampling. Keep bar baselines at zero, preserve negative values, and avoid misleading scales or excessive categories.

### Render the Selected Chart (Interactive)
- **CRITICAL: NEVER mention the library, framework, or design system name** (such as Carbon, IBM Carbon, Matplotlib, Seaborn, or Chart.js) anywhere in your response or chart text. Present the data, insights, and charts directly and naturally without referencing the tools used to create them.
- **Always use the interactive ```chart block directly in chat** for `bar`, `line`, `pie`, and `doughnut` charts. The chat interface automatically renders these as fully interactive charts with live hover tooltips, value indicators, slice popouts, and clickable legend series filters.
- **Categorical Color Palette to specify or align with**:
  - Do not reuse one blue color or the same pair of bar charts for every analysis. First select distinct analytical questions and complementary views; explain the finding each reveals in a short caption. Choose chart types for the data, not variety alone.
  - Single-series category comparisons: use multiple distinguishable colors. Set top-level `colors` to a list of hex colors matching labels. For multiple series, top-level colors map to series; a dataset's `color` overrides its series color. Pie/doughnut colors map to slices.
  - Choose a suitable palette for each view. Keep category colors consistent across related charts with explicit colors arrays. For ordered histogram bins use sequential shades, not unrelated categorical colors. Set `colorMode: "series"` for uniform single-series bars when color has no categorical meaning. Keep each time-series line one consistent color.
  - Never infer currency from a field named price; label currency only when the source specifies it.
  - Multi-series / categories: `['#0f62fe', '#6929c4', '#1192e8', '#005d5d', '#9f1853', '#fa4d56', '#198038', '#002d9c', '#ee538b', '#b28600', '#009d9a']`

Example for an evenly spaced time series (replace example values with computed results):
```chart
{
  "type": "line",
  "title": "Monthly Revenue ($k)",
  "subtitle": "A line shows the month-to-month trend",
  "labels": ["Jan", "Feb", "Mar", "Apr"],
  "data": [120, 145, 132, 170]
}
```
For multiple series use `datasets: [{"label": "Actual", "data": [120, 145, 132, 170]}, {"label": "Target", "data": [110, 130, 150, 160]}]` instead of `data`. Every series must align with `labels`.

For **advanced chart types unsupported by the native interactive block** (e.g. heatmaps, 2D scatter plots, complex distributions) or native limitations (e.g. signed values, irregular continuous scales):
- Generate the chart locally using Python without mentioning the plotting library:
  - Background: Pure white (`#ffffff`).
  - Spines: Despine top and right (`ax.spines['top'].set_visible(False)`, `ax.spines['right'].set_visible(False)`). Left and bottom spines in `#8d8d8d` or `#e0e0e0`.
  - Grid: Horizontal grid lines only (`color='#e0e0e0', linestyle='--'`).
  - Colors: Use the palette (`#0f62fe`, `#6929c4`, `#1192e8`, etc.).
  - Typography: Clean sans-serif, bold left-aligned title with subtle `#525252` subtitle.
  - Save a PNG in the conversation workspace and embed it using `![Descriptive chart caption](./analysis_chart.png)`.
  - Never say "Generated with Matplotlib"; simply present the chart.

Compute plots from real local data, not invented samples. Save and inspect the result for correct scales, legible labels, and clipping before delivery. Never claim an image was generated unless its file exists.

## 5. Output Structure
For guidance requests, present the prioritized business questions, what to examine for each, why it matters, and the evidence needed or limitations. Do not populate a results table or executive conclusion with uncomputed findings.

For execution requests, structure your response as follows:
1. **Executive Summary**: 2-3 bullet points highlighting the most important findings.
2. **Key Metric Cards / Summary Table**: Clean markdown table with aggregated numbers.
3. **Visuals**: The chart or complementary charts appropriate to the data, with a short explanation of each choice; use a table when a chart adds no value.
4. **Actionable Insights / Recommendations**: Evidence-linked business takeaways, proportionate next steps, and the assumptions or missing data that affect each decision. Clearly distinguish supported actions from hypotheses requiring validation.
