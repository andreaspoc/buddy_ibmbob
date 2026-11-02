"""Package only Buddy-owned Carbon assets into portable HTML exports."""
import re
from pathlib import Path

STATIC_ROOT = Path(__file__).with_name('static')
CARBON_CSS_TAG = '<link id="buddy-carbon-css" rel="stylesheet" href="/static/carbon-charts.css">'
CARBON_JS_TAG = '<script id="buddy-carbon-js" src="/static/carbon-charts.bundle.js"></script>'
CARBON_ASSET_TAGS = CARBON_CSS_TAG + CARBON_JS_TAG


def embed_carbon_assets(source: str, static_root: Path | None = None) -> str:
    """Inline trusted, build-produced assets; never resolve document-provided URLs.

    Missing build assets fail explicitly so a download is not falsely called offline.
    Fully packaged documents and documents without the Carbon contract are untouched.
    """
    if not any(marker in source for marker in ('buddy-carbon-css', 'buddy-carbon-js', 'BobVisuals.carbon')):
        return source
    # A marker on an external link is not an embedded bundle. Generated files
    # sometimes use this attribute with nonexistent .min asset URLs.
    embedded_css = re.search(r'<style\b(?=[^>]*\bid=["\']buddy-carbon-css["\'])(?=[^>]*\bdata-buddy-carbon-embedded=)[^>]*>', source, re.I)
    embedded_js = re.search(r'<script\b(?=[^>]*\bid=["\']buddy-carbon-js["\'])(?=[^>]*\bdata-buddy-carbon-embedded=)(?![^>]*\bsrc=)[^>]*>', source, re.I)
    runtime = ''
    if 'BobVisuals.carbon' in source and not re.search(r'<script\b[^>]*\bid=["\']bob-visual-runtime["\']', source, re.I):
        runtime = '<script id="bob-visual-runtime">' + Path(__file__).with_name('visual_artifact_runtime.js').read_text(encoding='utf-8') + '</script>'
    # New dashboards use Carbon for their UI and Chart.js for charts: they carry the stylesheet only.
    needs_javascript = any(marker in source for marker in ('buddy-carbon-js', 'BobVisuals.carbon'))
    if embedded_css and not needs_javascript:
        return source
    if embedded_css and embedded_js:
        if not runtime:
            return source
        # Install the adapter before authored scripts, even in existing exports.
        head = re.search(r'<head\b[^>]*>(?:\s*<meta\b[^>]*charset=[^>]*>)?', source, re.I)
        index = head.end() if head else 0
        return source[:index] + runtime + source[index:]
    root = Path(static_root) if static_root else STATIC_ROOT
    css = (root / 'carbon-charts.css').read_text(encoding='utf-8')
    javascript = (root / 'carbon-charts.bundle.js').read_text(encoding='utf-8')
    # HTML parsers terminate raw-text elements even when a closing tag is in a JS string.
    css = re.sub(r'</style', r'<\\/style', css, flags=re.I)
    javascript = re.sub(r'</script', r'<\\/script', javascript, flags=re.I)
    package = f'<style id="buddy-carbon-css" data-buddy-carbon-embedded="true">{css}</style>'
    if needs_javascript:
        package += f'<script id="buddy-carbon-js" data-buddy-carbon-embedded="true">{javascript}</script>' + runtime
    # Replace only known local asset paths, including generated .min aliases.
    # Never fetch or rewrite document-provided third-party URLs.
    source = re.sub(r'<link\b(?=[^>]*\bhref=["\']/static/carbon-charts(?:\.min)?\.css["\'])[^>]*>', '', source, flags=re.I)
    source = re.sub(r'<script\b(?=[^>]*\bsrc=["\']/static/carbon-charts\.bundle(?:\.min)?\.js["\'])[^>]*>\s*</script\s*>', '', source, flags=re.I)
    # Keep the encoding declaration within HTML's first 1024 bytes. Inserting
    # a large Unicode JS bundle ahead of it breaks file:// offline parsing.
    head = re.search(r'<head\b[^>]*>(?:\s*<meta\b[^>]*charset=[^>]*>)?', source, flags=re.I)
    if head:
        encoding = '' if re.search(r'charset=', head.group(0), flags=re.I) else '<meta charset="utf-8">'
        return source[:head.end()] + encoding + package + source[head.end():]
    return '<meta charset="utf-8">' + package + source



def carbon_html_versions(workspace: Path) -> dict[str, bytes]:
    """Record candidate bytes before a run so unrelated files stay untouched."""
    root = Path(workspace).resolve()
    versions = {}
    for path in root.rglob('*'):
        if path.suffix.lower() not in {'.html', '.htm'} or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if any(part.startswith('.') or part in {'node_modules', 'vendor'} for part in relative.parts):
            continue
        if path.is_file() and path.resolve().is_relative_to(root):
            versions[str(relative)] = path.read_bytes()
    return versions


def package_changed_carbon_html(workspace: Path, before: dict[str, bytes]) -> None:
    root = Path(workspace).resolve()
    for relative, raw in carbon_html_versions(root).items():
        if before.get(relative) == raw:
            continue
        try:
            source = raw.decode('utf-8')
        except UnicodeDecodeError:
            continue
        # Only complete opted-in documents may be finalized, never interrupted fragments.
        if not re.search(r'</html\s*>', source, re.I) or not any(marker in source for marker in ('buddy-carbon-css', 'buddy-carbon-js', 'BobVisuals.carbon')):
            continue
        packaged = embed_carbon_assets(source)
        if packaged != source:
            (root / relative).write_text(packaged, encoding='utf-8')
