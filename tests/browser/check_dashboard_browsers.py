"""Check saved dashboards and the real preview in Chromium, Firefox and WebKit, with the internet blocked."""
import functools
import http.server
import sys
import threading

from playwright.sync_api import sync_playwright

SIZES = {'phone': (390, 844, True), 'tablet': (820, 1180, True), 'desktop': (1280, 900, False)}
PORT = 8791
SCROLL_TOLERANCE = 4  # Engines round scroll offsets differently.
BASE = f'http://127.0.0.1:{PORT}/'
PAINTED = """()=>[...document.querySelectorAll('canvas')].filter(c=>c.getClientRects().length).map(c=>{if(!c.width||!c.height)return false;
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=3;i<d.length;i+=4)if(d[i])return true;return false})"""
OVERFLOW = """()=>{const w=document.documentElement.clientWidth;const bad=[];
  if(document.documentElement.scrollWidth>w+1)bad.push('page '+document.documentElement.scrollWidth+'>'+w);
  for(const e of document.querySelectorAll('.panel.active *,.header *')){const r=e.getBoundingClientRect();if(!r.width||r.right<=w+1)continue;
    let p=e,clipped=false;while(p=p.parentElement){if(['auto','scroll','hidden'].includes(getComputedStyle(p).overflowX)){clipped=true;break}}
    if(!clipped)bad.push(e.tagName+'.'+e.className)}return bad.slice(0,4)}"""
failures = []


def check(label, passed, detail=''):
    print(('ok   ' if passed else 'FAIL ') + label + (f' [{detail}]' if detail != '' and not passed else ''))
    if not passed:
        failures.append(label)


def charts_ok(frame):
    painted = frame.evaluate(PAINTED)
    return bool(painted) and all(painted), painted


def wait_charts(frame, page):
    for _ in range(20):
        passed, painted = charts_ok(frame)
        if passed:
            return passed, painted
        page.wait_for_timeout(150)
    return charts_ok(frame)


def new_page(browser, kind, size):
    width, height, mobile = SIZES[size]
    options = {'viewport': {'width': width, 'height': height}, 'has_touch': mobile}
    if mobile and kind != 'firefox':
        options['is_mobile'] = True
    context = browser.new_context(**options)
    errors, blocked = [], []
    def route(request):
        if request.request.url.startswith(BASE) or not request.request.url.startswith('http'):
            request.continue_()
        else:
            blocked.append(request.request.url)
            request.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)[:160]))
    return context, page, errors, blocked


def check_saved(browser, kind, size):
    name = f'{kind}/{size}/saved'
    context, page, errors, blocked = new_page(browser, kind, size)
    page.goto(BASE + 'saved.html')
    passed, detail = wait_charts(page, page)
    check(f'{name}: overview charts draw offline', passed, detail)
    check(f'{name}: nothing needed from the internet', not blocked, blocked[:3])
    check(f'{name}: no warning, script repaired', not page.evaluate("!!document.getElementById('bob-script-error')"))
    overflow = page.evaluate(OVERFLOW)
    check(f'{name}: overview fits the screen', not overflow, overflow)
    check(f'{name}: Carbon font embedded', page.evaluate("document.fonts.ready.then(()=>document.fonts.check('16px \"IBM Plex Sans\"'))"))
    page.evaluate("BobDashboard.replay('bars')")
    page.wait_for_timeout(100)
    check(f'{name}: replay animates', page.evaluate("Chart.animator.running(Chart.getChart('bars'))"))
    page.click('[data-panel=teams]')
    passed, detail = wait_charts(page, page)
    check(f'{name}: chart in a hidden tab draws when opened', passed, detail)
    page.click('[data-panel=records]')
    page.wait_for_selector('#rows tr')
    check(f'{name}: data shown as text, not code', page.evaluate("!document.querySelector('#rows b')&&document.querySelector('#rows').textContent.includes('<b>')"))
    page.fill('#search', 'audit')
    check(f'{name}: search', page.inner_text('#count') == 'Showing 1 of 5', page.inner_text('#count'))
    page.click('#reset')
    page.click('th[data-sort=name]')
    check(f'{name}: sort', page.get_attribute('th[data-sort=name]', 'aria-sort') == 'ascending')
    overflow = page.evaluate(OVERFLOW)
    check(f'{name}: records fit the screen', not overflow, overflow)
    check(f'{name}: no script errors', not errors, errors[:3])
    context.close()


def active_frame(page):
    for element in page.query_selector_all('iframe'):
        if element.get_attribute('aria-hidden') == 'false':
            return element.content_frame()
    return None


def wait_active(page, predicate):
    for _ in range(40):
        frame = active_frame(page)
        try:
            if frame and predicate(frame):
                return frame
        except Exception:  # A frame can be replaced while it is being inspected.
            pass
        page.wait_for_timeout(150)
    return active_frame(page)


def check_preview(browser, kind, size, broken):
    name = f'{kind}/{size}/preview'
    context, page, _, _ = new_page(browser, kind, size)
    page.goto(BASE + 'preview.html')
    page.wait_for_function('typeof window.setPreview === "function"')
    page.evaluate('html=>setPreview(html)', broken)
    frame = wait_active(page, lambda item: item.evaluate("!!document.querySelector('canvas')"))
    passed, detail = wait_charts(frame, page)
    check(f'{name}: broken file repaired on display, charts draw', passed, detail)
    check(f'{name}: sandbox blocks the app', frame.evaluate("(()=>{try{parent.document;return false}catch(e){return true}})()"))
    check(f'{name}: opaque origin', frame.evaluate('self.origin') == 'null', frame.evaluate('self.origin'))
    frame.evaluate('scrollTo(0,120)')
    page.wait_for_timeout(300)
    page.evaluate("html=>setPreview(html)", broken.replace('</body>', '<!--next--></body>'))
    swapped = wait_active(page, lambda item: 'next' in item.evaluate('document.documentElement.outerHTML') and abs(item.evaluate('scrollY') - 120) <= SCROLL_TOLERANCE)
    check(f'{name}: update keeps scroll position', abs(swapped.evaluate('scrollY') - 120) <= SCROLL_TOLERANCE, swapped.evaluate('scrollY'))
    page.evaluate("setPreview('<!doctype html><html><body><p>Page</p><script>const = broken(;</script></body></html>')")
    warned = wait_active(page, lambda item: item.evaluate("!!document.getElementById('bob-script-error')"))
    check(f'{name}: unrepairable script shows a warning', warned.evaluate("!!document.getElementById('bob-script-error')"))
    page.evaluate("setPreview('<!doctype html><html><body><p>draft</p><script>unfinished(',true)")
    draft = wait_active(page, lambda item: 'draft' in item.evaluate('document.body.innerText'))
    check(f'{name}: unfinished draft shows without a false warning', not draft.evaluate("!!document.getElementById('bob-script-error')"))
    context.close()


def check_office_runtime(browser, kind, saved):
    name = f'{kind}/desktop/office'
    context, page, errors, blocked = new_page(browser, kind, 'desktop')
    page.goto(BASE + 'office.html')
    page.wait_for_function('typeof window.setOffice === "function"')
    page.evaluate('html=>setOffice(html)', saved)
    page.wait_for_function('window.officeReady === true')
    # Locate the actual child Frame to inspect canvas pixels and sandbox origin.
    frame = page.query_selector('iframe').content_frame()
    passed, detail = wait_charts(frame, page)
    check(f'{name}: dashboard charts draw', passed, detail)
    check(f'{name}: no external resources', not blocked, blocked[:3])
    check(f'{name}: sandbox has opaque origin', frame.evaluate('self.origin') == 'null')
    frame.evaluate("BobDashboard.replay('bars')")
    frame.click('[data-panel=teams]')
    passed, detail = wait_charts(frame, page)
    check(f'{name}: replay and hidden tab charts work', passed, detail)
    check(f'{name}: no JavaScript errors', not errors, errors[:3])
    check(f'{name}: no Office runtime warnings', not page.evaluate('window.officeWarnings'), page.evaluate('window.officeWarnings'))
    broken = '<!doctype html><html><head><title>Fixture</title></head><body><script>throw new Error("Synthetic Office failure")</script></body></html>'
    page.evaluate('html=>setOffice(html)', broken)
    # Opaque iframe error details can be redacted by the browser (notably WebKit).
    page.wait_for_function('officeWarnings.length > 0')
    check(f'{name}: reports a real script exception', True)
    context.close()


def main(directory, engines):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *_: None
    http.server.SimpleHTTPRequestHandler.log_message = lambda *_: None
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with open(f'{directory}/broken-source.html', encoding='utf-8') as source:
        broken = source.read()
    with open(f'{directory}/saved.html', encoding='utf-8') as source:
        saved = source.read()
    with sync_playwright() as runtime:
        for kind in engines:
            browser = getattr(runtime, kind).launch()
            print(f'--- {kind} {browser.version}')
            for size in SIZES:
                check_saved(browser, kind, size)
                check_preview(browser, kind, size, broken)
            check_office_runtime(browser, kind, saved)
            browser.close()
    server.shutdown()
    print(f'{len(failures)} failed' if failures else 'All browser checks passed')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2:] or ['chromium', 'firefox', 'webkit']))
