"""Build synthetic dashboards with the real scaffold, kit, repair and packaging code."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app.carbon_chart_assets import embed_carbon_assets  # noqa: E402
from app.html_artifact_check import embed_chart_library, flag_script_errors  # noqa: E402
from app.html_artifact_policy import create_html_scaffold  # noqa: E402

ROWS = [{'name': name, 'team': team, 'state': state, 'opened': opened} for name, team, state, opened in (
    ('Renew <b>certificate</b> with a deliberately long synthetic title that must wrap on small screens', 'Network', 'Open', '2026-09-02'),
    ('Rotate keys', 'Security', 'Done', '2026-09-14'), ('Patch gateway', 'Network', 'Open', '2026-10-01'),
    ('Audit logs', 'Security', 'Stuck', '2026-10-05'), ('Resize cluster', 'Platform', 'Done', '2026-10-12'))]
BROKEN_LINE = "document.getElementById('never')?.style.display='block';"


def replay(chart):
    return f'<button type="button" class="chart-replay-btn" data-replay="{chart}">Replay</button>'


def kpi(label, value, note):
    return f'<div class="kpi-card"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div><div class="kpi-sub">{note}</div></div>'


OVERVIEW = ('<div class="kpi-grid">' + kpi('Open', 2, 'of 5') + kpi('Done', 2, '40% closed') + kpi('Stuck', 1, 'needs attention') + kpi('Teams', 3, 'responsible') + '</div>'
            '<div class="charts-grid"><div class="chart-card"><div class="chart-title">By team</div><div class="chart-sub">Parts of the whole</div>'
            '<div class="donut-wrap"><canvas id="donut"></canvas><div class="donut-center"><div class="dc-num">5</div><div class="dc-lbl">total</div></div></div>'
            '<div class="legend-wrap" id="donut-legend"></div>' + replay('donut') + '</div>'
            '<div class="chart-card"><div class="chart-title">By state</div><div class="chart-sub">Ranking</div><div class="chart-canvas-wrap"><canvas id="bars"></canvas></div>' + replay('bars') + '</div></div>'
            '<div class="chart-card wide"><div class="chart-title">Opened</div><div class="chart-sub">Per month</div><div class="chart-canvas-wrap"><canvas id="line"></canvas></div>' + replay('line') + '</div>'
            '<div class="chart-card wide"><div class="prog-bar-wrap"><div class="prog-bar-label"><span>Closed</span><span>40%</span></div><div class="prog-bar"><div class="prog-bar-fill" style="--value:40%"></div></div></div></div>')
TEAMS = ('<h2 class="section-title">Teams</h2><div class="entity-grid"><div class="entity-card"><div class="entity-header"><span class="entity-dot"></span><div class="entity-name">Network</div></div>'
         '<div class="stat-row">Open <strong>2</strong></div><div class="chip-list"><span class="chip">Fixture</span></div></div></div><div class="chart-card wide"><div class="chart-canvas-wrap"><canvas id="teams-chart"></canvas></div></div>')
RECORDS = ('<div class="toolbar"><input type="search" class="search-box" id="search" aria-label="Search"><select class="filter-select" id="team" aria-label="Team"><option value="">All</option><option>Network</option><option>Security</option></select>'
           '<button type="button" class="btn-reset" id="reset">Reset</button><span class="filter-count" id="count"></span></div>'
           '<div class="table-wrap"><table><thead><tr><th data-sort="name">Name</th><th data-sort="team">Team</th><th data-sort="state">State</th><th data-sort="opened">Opened</th></tr></thead><tbody id="rows"></tbody></table></div>')
SCRIPT = """const D=BobDashboard,R=__ROWS__;
const donut=D.chart('donut',{type:'doughnut',data:{labels:['Network','Security','Platform'],datasets:[{data:[2,2,1],backgroundColor:D.COLORS.slice(0,3)}]},options:{cutout:'55%',plugins:{legend:{display:false}}}});
D.legend('donut-legend',donut,[2,2,1]);
D.chart('bars',{type:'bar',data:{labels:['Open','Done','Stuck'],datasets:[{data:[2,2,1],backgroundColor:D.COLORS.slice(0,3)}]},options:{indexAxis:'y',maintainAspectRatio:false,plugins:{legend:{display:false}}}});
D.chart('line',{type:'line',data:{labels:['Sep','Oct'],datasets:[{data:[2,3],borderColor:'#7b00e0',fill:true}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false}}}});
D.chart('teams-chart',{type:'bar',data:{labels:['A','B'],datasets:[{data:[1,2],backgroundColor:D.COLORS.slice(0,2)}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false}}}});
D.table({rows:R,body:'rows',search:'search',count:'count',reset:'reset',filters:[{id:'team',key:'team'}],columns:[{key:'name'},{key:'team'},{key:'state'},{key:'opened'}]});"""


def tab(name, label):
    return f'<button type="button" class="nav-tab" role="tab" aria-selected="false" tabindex="-1" data-panel="{name}">{label}</button>'


def dashboard(extra_script=''):
    source = create_html_scaffold('Synthetic board')
    source = source.replace('data-panel="overview">Overview</button>', 'data-panel="overview">Overview</button>' + tab('teams', 'Teams') + tab('records', 'All records'))
    panels = (f'<section id="panel-overview" class="panel active" data-bob-reveal>{OVERVIEW}</section>'
              f'<section id="panel-teams" class="panel">{TEAMS}</section><section id="panel-records" class="panel">{RECORDS}</section>')
    source = re.sub(r'<section id="panel-overview".*?</section>', lambda _: panels, source, flags=re.S)
    script = SCRIPT.replace('__ROWS__', json.dumps(ROWS).replace('</', '<\\/'))
    return source.replace('</body>', f'<script>{extra_script}{script}</script></body>')


def write(directory):
    target = Path(directory)
    saved, errors = flag_script_errors(dashboard(BROKEN_LINE))
    if errors:
        raise SystemExit(f'Fixture was not repaired: {errors}')
    (target / 'saved.html').write_text(embed_chart_library(embed_carbon_assets(saved)), encoding='utf-8')
    # Exactly what the preview receives for an already saved, still broken file.
    (target / 'broken-source.html').write_text(embed_chart_library(dashboard(BROKEN_LINE)), encoding='utf-8')
    (target / 'preview.html').write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%}iframe{display:block;width:100%;height:760px;border:0}</style></head><body><div id="root"></div><script src="preview.js"></script></body></html>', encoding='utf-8')
    (target / 'office.html').write_text('<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}iframe{display:block;width:100%;height:760px;border:0}</style></head><body><div id="root"></div><script src="office-runtime.js"></script></body></html>', encoding='utf-8')


if __name__ == '__main__':
    write(sys.argv[1])
