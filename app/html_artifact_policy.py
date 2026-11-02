"""Progressive authoring guidance for ordinary interactive HTML artifacts."""
import html
import re
from pathlib import Path
from app.carbon_chart_assets import CARBON_CSS_TAG


CHARTJS_ASSET_TAG = '<script id="buddy-chartjs" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" integrity="sha384-NrKB+u6Ts6AtkIhwPixiKTzgSKNblyhlk0Sohlgar9UHUBzai/sgnNNWWd291xqt" crossorigin="anonymous"></script>'
MOTION_RUNTIME = Path(__file__).with_name('artifact_motion_runtime.js').read_text(encoding='utf-8')
DASHBOARD_CSS = Path(__file__).with_name('dashboard_standard.css').read_text(encoding='utf-8')
DASHBOARD_RUNTIME = Path(__file__).with_name('dashboard_standard.js').read_text(encoding='utf-8')
SCRIPT_CHECK_COMMAND = (
    r"""node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const v=require('vm');"""
    r"""for(const m of s.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*(?:json|module))[^>]*>([\s\S]*?)<\/script>/g))"""
    r"""new v.Script(m[1]);console.log('OK')" DASHBOARD_FILE"""
)
DASHBOARD_STANDARD = (
    'DASHBOARD STANDARD: Unless the user explicitly asks for a different style or layout, every new dashboard must reach this '
    'board-level standard. The scaffold already holds the bob-dashboard-standard stylesheet and the window.BobDashboard script: '
    'keep both unchanged, use their classes and helpers, and do not restyle or rewrite them. '
    'Structure: .header gradient banner with h1, a .subtitle naming the source, and .header-meta .badge items with key totals and the data date; '
    '.nav-bar with .nav-tab buttons (role=tab, data-panel=NAME) that switch section.panel elements with id panel-NAME; '
    'an Overview tab first, then a breakdown tab when the data has a meaningful category, and an all-records tab when it has row-level records. '
    'Overview: .kpi-grid with 4 to 6 .kpi-card items (.kpi-label, .kpi-value, .kpi-sub, and a --accent colour); .charts-grid of .chart-card items, each with '
    '.chart-title, a .chart-sub saying what it shows and how to interact, and a .chart-replay-btn with data-replay=CANVAS_ID; choose chart types by data shape: '
    'doughnut with .donut-wrap, .donut-center (.dc-num, .dc-lbl) and a .legend-wrap for parts of a whole, sorted horizontal bars for rankings, a filled line for time series; '
    'use .section-title to group sections and .prog-bar for proportions. Breakdown tab: .entity-grid of .entity-card with .entity-header, .stat-row items and .chip tags. '
    'Records tab: .toolbar with .search-box, .filter-select, .btn-reset and .filter-count above a .table-wrap table whose sortable headings have data-sort=KEY; use .status-badge with s-good, s-warn, s-bad, s-info or s-neutral. '
    'Helpers: BobDashboard.chart(canvasId, config) creates and registers each chart, BobDashboard.legend(elementId, chart, values) builds the legend, '
    'BobDashboard.table({rows, body, columns, search, filters, count, reset}) runs search, filters and sorting, BobDashboard.COLORS is the series palette, '
    'BobDashboard.update(canvasId) applies data changes at the 700ms update speed, '
    'and BobDashboard.escapeHtml must wrap every data value inserted as HTML. Do not write your own tab, replay, legend or table logic, and do not destroy charts to replay them. '
    'Accuracy: compute every figure from the embedded data. Show the date of the data rather than the viewer clock, and anchor windows such as "last 7 days" to that date, because the data is a snapshot. '
    'Omit a section the data cannot honestly support rather than filling it; label any proxy or estimate as such in its .chart-sub or .kpi-sub. '
    'Edit the scaffold section by section and never replace the whole file, because that removes the kit. '
    'Before finishing you must verify the scripts: one syntax error stops every chart from drawing. '
    'Run this from the workspace and fix every error it reports, then run it again until it prints OK: '
    + SCRIPT_CHECK_COMMAND + ' '
    'Common mistake: optional chaining cannot be assigned to, so write if(el) el.style.display="block" and never el?.style.display="block". '
)


def is_html_artifact_request(prompt: str, mode=None, presentation=None) -> bool:
    text = str(prompt or '').lower()
    if presentation or str(mode or '').lower() in {'presentation', 'slides', 'powerpoint', 'pptx'}:
        return False
    # Only inspect the requested output, not the subject it will explain.
    output = re.split(r'\b(?:about|on|for|explaining|covering|describing|based\s+on)\b', text, maxsplit=1)[0]
    if re.search(r"\b(?:do not|don.t|without|no)\s+(?:create\s+)?(?:an?\s+)?(?:interactive\s+)?(?:html\s+)?dashboard\b", output):
        return False
    if re.match(r'\s*(?:what|why|how|where|when|is|does|do|can|could)\b', output) and not re.match(r'\s*(?:can|could)\s+you\s+(?:please\s+)?(?:create|build|make|generate|design)\b', output):
        return False
    if re.search(r'\b(?:edit|update|modify|fix|change|improve|enhance|redesign)\b', output):
        return False
    if re.search(r'\b(?:presentation|slide\s*deck|slideshow|powerpoint|pptx|template)\b', output):
        return False
    artifact = r'(?:interactive\s+html(?:\s+(?:dashboard|artifact|app|page))?|html\s+(?:dashboard|artifact|app|page)|(?:interactive\s+)?dashboard)'
    # A direct noun request is accepted, as are normal creation requests.
    if re.fullmatch(r'\s*(?:an?\s+)?' + artifact + r'\s*[.!]?\s*', output):
        return True
    return bool(re.search(r'\b(?:create|build|make|generate|design|produce|need|want)\b', output) and re.search(r'\b' + artifact + r'\b', output))


def html_artifact_instruction(prompt: str = '', output_path: str | None = None) -> str:
    target = f' Edit the existing scaffold at {output_path} in place; keep this exact output file throughout generation.' if output_path else ''
    return (
        '\nHTML ARTIFACT AUTHORING: ' + DASHBOARD_STANDARD + 'For every interactive HTML dashboard, app, or artifact, '
        'use a purple theme by default (deep purple #5a2b85, vivid purple #7b00e0, pale lavender surfaces), '
        'unless the user explicitly requests another palette or theme. '
        'Preserve the existing theme, layout and functionality when editing an existing artifact unless a redesign is requested. '
        'Do not change the existing Carbon tables or bar/pie chart rendering in chat. '
        'Publish a valid self-contained HTML scaffold immediately, before lengthy research or composition: '
        'include a descriptive header, styles, navigation, and a first section. Then save small meaningful '
        'updates to that same file as each section becomes ready, so the preview can progress during streaming. '
        'Keep document markup valid and preserve scripts and existing user content during each update; '
        'use stable section IDs to support smooth preview updates. Include responsive layouts, keyboard-friendly '
        'interactions, and reduced-motion support. Read the requested source before explaining it. '
        'For uploaded CSV or spreadsheet data, inspect the headers and a small sample, then use workspace scripts to process the file and compute required aggregates; choose further analyses according to the question and results, and avoid reading successive blocks into the model. '
        'Use category IDs as labels when their names are not supplied or verified; never infer a lookup table from a familiar dataset. '
        'Embed the actual data needed for charts, tables and filters directly in the HTML as safely serialized JSON; '
        'escape HTML script closing sequences in embedded JSON. Do not fetch uploaded files by relative filename, '
        'workspace path or browser file URL: sandboxed previews and downloaded files cannot access them reliably. '
        'For large sources embed the verified aggregates needed for the requested views, and disclose any aggregation. '
        'Never invent missing data; if the source cannot be read, report the failure instead of creating an empty dashboard. '
        'Use purposeful motion by default: short slide/fade transitions for user-selected views, animated '
        'chart updates with stable series IDs, and responsive hover/pressed states. '
        'CHARTS: Chart.js is the only chart library allowed in a dashboard. Use interactive Chart.js via the existing buddy-chartjs script, and never use ECharts, Carbon charts, D3, Plotly, Highcharts, ApexCharts, Google Charts or chart images, even for an unusual chart type, unless the user explicitly names another library; '
        'create responsive canvas charts with tooltips and clickable legends, and update retained chart instances '
        'when filters change. Use only actual source data; never invent weights, values or statistics. '
        'Provide an accessible title and source-data table, keyboard-operable filters or selection controls, '
        'and a dedicated stable-height responsive chart container. Keep the Carbon UI with the buddy-carbon-css stylesheet, '
        'IBM Plex Sans typography, pale lavender surfaces and purple action/focus accents. '
        'Match the main UI chart motion: use 1400ms entrance and replay animations and 700ms data updates, '
        'with the same cubic-bezier(.2,0,.38,.9) easing as Carbon, implemented as a Chart.js custom easing '
        'by solving the Bezier x coordinate before evaluating y; do not substitute a named approximate easing. '
        'Match the corresponding Carbon chart entrance direction and data-update transition for each chart type. '
        'Retain Chart.js instances; for replay use '
        'chart.reset() followed by chart.update() with entrance timing, without destroying the chart. '
        'Replay visible charts when the Replay control is used and whenever a tab or screen becomes active, '
        'including previously visited views; handle bob:chart-activate for the activated panel. '
        'Respect prefers-reduced-motion by disabling chart animations. Preserve the buddy-chartjs script tag '
        'and buddy-carbon-css and bob-motion-runtime assets. '
        'Keep the buddy-chartjs tag: while generating it needs network access, and the saved file gets an embedded copy so its charts work without internet. '
        'If the library cannot load, show a visible error and retain the usable source table. Publish incremental valid HTML to the same file; never remove user '
        'content when updating a section. Label unfinished sections as being prepared.'  + target + '\n'
    )


def create_html_scaffold(title: str = 'Interactive dashboard') -> str:
    """A real initial artifact, without fabricated content or metrics."""
    title = html.escape(title)
    return '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="bob-artifact-role" content="artifact"><title>''' + title + '''</title>
''' + CARBON_CSS_TAG + CHARTJS_ASSET_TAG + '''<style id="bob-dashboard-standard">''' + DASHBOARD_CSS + '''</style></head>
<body><header class="header"><div class="header-inner"><div><h1>''' + title + '''</h1><div class="subtitle">Interactive exploration</div></div><div class="header-meta"></div></div></header>
<nav class="nav-bar" role="tablist" aria-label="Dashboard sections"><div class="nav-inner"><button type="button" class="nav-tab active" role="tab" aria-selected="true" data-panel="overview">Overview</button></div></nav>
<main class="main"><section id="panel-overview" class="panel active" data-bob-reveal aria-labelledby="overview-title"><span class="status" role="status">Building your dashboard</span><h2 id="overview-title" class="section-title">Overview</h2><p>Content is being prepared from the requested source. Sections will appear here as they are ready.</p></section></main>
<script id="bob-motion-runtime">''' + MOTION_RUNTIME + '''</script><script id="bob-dashboard-runtime">''' + DASHBOARD_RUNTIME + '''</script></body></html>'''
