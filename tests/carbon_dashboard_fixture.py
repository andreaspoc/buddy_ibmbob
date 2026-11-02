"""Synthetic dashboard fixture using the real generation scaffold and export packaging."""
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.html_artifact_policy import create_html_scaffold
from app.carbon_chart_assets import CARBON_JS_TAG, embed_carbon_assets
VISUAL_RUNTIME = (Path(__file__).parent.parent / 'app' / 'visual_artifact_runtime.js').read_text(encoding='utf-8')


def carbon_scaffold(title='Interactive dashboard'):
    """An older Carbon dashboard: new scaffolds use Chart.js only, but saved Carbon files must keep exporting."""
    source = create_html_scaffold(title).replace('</head>', CARBON_JS_TAG + '</head>', 1)
    return source.replace('</body>', f'<script id="bob-visual-runtime">{VISUAL_RUNTIME}</script></body>', 1)


BODY = '<nav aria-label="Synthetic views"><button id="tab-one" type="button">Chart view</button><button id="tab-two" type="button">Other view</button><button id="filter" type="button">Filter supplied values</button><button id="replay" type="button">Replay charts</button></nav><section id="chart-panel" data-bob-reveal><div id="carbon-bar" style="height:360px" aria-label="Synthetic grouped values"></div><div id="carbon-line" style="height:360px" aria-label="Synthetic line values"></div><div id="carbon-pie" style="height:360px" aria-label="Synthetic share values"></div><p>Explicit synthetic test data only.</p><table><caption>Synthetic source values</caption><tr><th>Group</th><th>Value</th></tr><tr><td>First</td><td>12</td></tr><tr><td>Second</td><td>18</td></tr></table></section><section id="other-panel" hidden>Another view</section>'
SCRIPT = "<script>\nwindow.carbonReplays=0; document.addEventListener('buddy:chart-replayed',()=>window.carbonReplays++);\nwindow.carbonReady=(async()=>{\nconst axes={left:{mapsTo:'value'},bottom:{mapsTo:'key',scaleType:'labels'}};\nwindow.barHandle=await BobVisuals.carbon(document.getElementById('carbon-bar'),{type:'grouped-bar',data:[{group:'First',key:'A',value:12},{group:'Second',key:'A',value:18}],options:{title:'Synthetic grouped values',axes}});\nwindow.lineHandle=await BobVisuals.carbon(document.getElementById('carbon-line'),{type:'line',data:[{group:'First',key:'A',value:12},{group:'First',key:'B',value:18}],options:{title:'Synthetic line values',axes}});\nwindow.pieHandle=await BobVisuals.carbon(document.getElementById('carbon-pie'),{type:'pie',data:[{group:'First',value:12},{group:'Second',value:18}],options:{title:'Synthetic share values'}});\n})();\nconst panel=document.getElementById('chart-panel'),other=document.getElementById('other-panel');\ndocument.getElementById('tab-one').onclick=()=>{other.hidden=true;panel.hidden=false;document.dispatchEvent(new CustomEvent('bob:chart-activate',{detail:{element:panel}}));};\ndocument.getElementById('tab-two').onclick=()=>{panel.hidden=true;other.hidden=false;};\ndocument.getElementById('filter').onclick=()=>barHandle.update({data:[{group:'First',key:'A',value:9},{group:'Second',key:'A',value:21}]});\ndocument.getElementById('replay').onclick=()=>BobVisuals.replayVisible();\n</script>"
def dashboard(offline=True):
    source = carbon_scaffold('Synthetic Carbon dashboard integration')
    source = source.replace('<main>', '<main>' + BODY).replace('</body>', SCRIPT + '</body>')
    return embed_carbon_assets(source) if offline else source
if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--source', action='store_true')
    args = parser.parse_args()
    Path(args.output).write_text(dashboard(not args.source), encoding='utf-8')
