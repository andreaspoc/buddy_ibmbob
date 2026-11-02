"""BobDeck Presentation Studio templates and mode helper."""

from __future__ import annotations

from app.branding import brand_text
import json
import re
import uuid
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pathlib import Path
from typing import Any

from fastapi import HTTPException

TEMPLATES_DIR = Path(__file__).parent / "presentation_templates"
_ID_RE = re.compile(r"^[a-z0-9-]+$")


class TemplateColors(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    primary: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    secondary: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    accent: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    background: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    text: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")

class TemplateFonts(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    heading: str = Field(min_length=1, max_length=80, pattern=r"^[\w ,.-]+$")
    body: str = Field(min_length=1, max_length=80, pattern=r"^[\w ,.-]+$")

class TemplateDesign(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    shape: Literal["rectangle", "roundedRectangle", "ellipse"] = "roundedRectangle"
    decoration: Literal["none", "sidebar", "topbar"] = "sidebar"
    cardBorderWidth: int = Field(default=0, ge=0, le=4, strict=True)
    contentLayout: Literal['cards', 'comparison', 'timeline'] = 'cards'
    chartType: Literal['none', 'bar', 'line', 'doughnut'] = 'none'
    htmlNavigation: bool = True
    htmlTransition: Literal['none', 'fade', 'slide'] = 'fade'

class PresentationTemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(min_length=1, max_length=100, pattern=r"^\S(?:[^\r\n]*\S)?$")
    brand: str = Field(min_length=1, max_length=100, pattern=r"^\S(?:[^\r\n]*\S)?$")
    colors: TemplateColors
    fonts: TemplateFonts
    design: TemplateDesign

_TEMPLATE_SCOPE = "presentation-templates"

def _title_slide_colors(deck: dict) -> dict[str, str]:
    """Preview the cover's overrides rather than the general content theme."""
    theme = deck.get("theme", {}).get("colors", {})
    slides = deck.get("slides", [])
    slide = slides[0] if slides else {}
    background = slide.get("background") or theme.get("background", "FFFFFF")
    if isinstance(background, dict):
        background = background.get("color", theme.get("background", "FFFFFF"))
    texts = [element for element in slide.get("elements", []) if element.get("type") == "text"]
    title = next((element for element in texts if element.get("id") == "title"), None)
    if title is None and texts:
        title = max(texts, key=lambda element: float(element.get("style", {}).get("fontSize", element.get("fontSize", 0)) or 0))
    title = title or {}
    text = title.get("style", {}).get("color") or title.get("color") or theme.get("text", "161616")
    return {"background": "#" + str(background).lstrip("#"), "text": "#" + str(text).lstrip("#")}


def _custom_catalog(template_id: str, deck: dict) -> dict:
    config = deck["metadata"]["studioConfig"]
    return {"titleSlideColors": _title_slide_colors(deck), "id": template_id, "title": config["title"], "brand": config["brand"],
            "themeId": template_id, "fonts": config["fonts"], "colors": {**config["colors"], "chartPalette": ["#" + color.lstrip("#") for color in deck["theme"]["chartPalette"]]},
            "design": config["design"], "custom": True, "studioConfig": config,
            "slidesCount": len(deck["slides"]), "slidePreviews": [
                {"id": slide["id"], "layout": slide["layout"], "title": slide["layout"].title()}
                for slide in deck["slides"]]}

def build_template_design_deck(config: PresentationTemplateCreate, template_id: str) -> dict:
    """Keep layout coordinates and styles aligned with createTemplatePreviewDeck in the UI."""
    values = config.model_dump()
    c, f, d = values["colors"], values["fonts"], values["design"]

    def text(content, x, y, w, h, font_size=22, heading=False):
        return {"type": "text", "text": content, "x": x, "y": y, "w": w, "h": h,
                "fontSize": font_size, "color": c["text"], "bold": heading,
                "style": {"fontFamily": f["heading"] if heading else f["body"]}}

    def shape(x, y, w, h, fill, shape_name=None):
        return {"type": "shape", "shape": shape_name or d["shape"], "x": x, "y": y,
                "w": w, "h": h, "fill": fill, "stroke": c["accent"], "lineWidth": d["cardBorderWidth"]}

    def base():
        elements = []
        if d["decoration"] == "sidebar":
            elements.append(shape(0, 0, .22, 7.5, c["primary"], "rectangle"))
        elif d["decoration"] == "topbar":
            elements.append(shape(0, 0, 13.333, .22, c["primary"], "rectangle"))
        elements.append(text(config.brand or "Your brand", .65, .45, 11, .4, 15))
        return elements

    hero = base() + [shape(9.2, 2.1, 2.7, 2.7, c["secondary"]),
                     text("Presentation title", .85, 2.1, 8, 1.2, 40, True),
                     text("A clear introduction to your story", .85, 3.55, 8, .7),
                     text("Subtitle · Presenter", .85, 5.5, 9, .5, 18)]
    content = base() + [text("Your key ideas", .85, 1.25, 11, .8, 34, True)]
    labels = ['Option A', 'Option B'] if d['contentLayout'] == 'comparison' else ['Stage 1', 'Stage 2', 'Stage 3'] if d['contentLayout'] == 'timeline' else ['First idea', 'Second idea', 'Third idea']
    if d['contentLayout'] == 'timeline':
        content.append(shape(2.65, 3.65, 8, .08, c['accent'], 'rectangle'))
    for i, label in enumerate(labels):
        x = .85 + i * (6.15 if d['contentLayout'] == 'comparison' else 4.05)
        width = 5.45 if d['contentLayout'] == 'comparison' else 3.65
        content.extend([shape(x, 2.65, width, 2.6, c['secondary']),
                        text(label, x + .35, 3.05, width - .75, .6, 23, True),
                        text('Add your supporting message here.', x + .35, 3.9, width - .75, .85, 19)])
    closing = base() + [shape(9.2, 2.1, 2.7, 2.7, c["primary"]),
                        text("Next steps", .85, 2.1, 8, 1.2, 40, True),
                        text("Your closing message and call to action", .85, 3.7, 8, 1),
                        text("Thank you", .85, 5.5, 8, .5, 20)]
    slides = []
    layouts = [('hero', 'Presentation title', hero), ('content', 'Your key ideas', content)]
    if d['chartType'] != 'none':
        chart = base() + [text('Sample chart', .85, 1.25, 11, .8, 34, True),
                         {'type': 'chart', 'chartType': d['chartType'], 'x': .85, 'y': 2.3,
                          'width': 11.65, 'height': 3.8, 'title': 'Illustrative sample values',
                          'categories': ['A', 'B', 'C'], 'series': [{'name': 'Sample', 'values': [25, 40, 35], 'color': c['primary']}]},
                         text('Illustrative sample values', .85, 6.4, 11, .4, 16)]
        layouts.append(('chart', 'Sample chart', chart))
    layouts.append(('closing', 'Next steps', closing))
    for layout, title, elements in layouts:
        for i, element in enumerate(elements):
            element["id"] = f"{layout}-element-{i}"
        slides.append({"id": layout, "layout": layout, "title": title,
                       "background": c["background"], "elements": elements})
    palette = [c["primary"], c["accent"], c["secondary"]]
    return {"version": 1, "title": config.title,
            "metadata": {"brand": config.brand, "themeId": template_id, "studioConfig": values},
            "theme": {"fonts": f, "colors": {**c, "chartPalette": palette},
                      "chartPalette": palette, "design": d}, "slides": slides}


def create_presentation_template(username: str, config: PresentationTemplateCreate) -> dict:
    from app import postgres_storage as storage
    template_id = "custom-" + uuid.uuid4().hex
    deck = build_template_design_deck(config, template_id)
    storage.put_file(username, _TEMPLATE_SCOPE, template_id + ".bobdeck", json.dumps(deck).encode())
    return _custom_catalog(template_id, deck)


def list_presentation_templates(username: str | None = None) -> list[dict[str, Any]]:
    """Return catalog of available starter templates with metadata and theme swatches."""
    templates: list[dict[str, Any]] = []
    for path in sorted(TEMPLATES_DIR.glob("*.bobdeck")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            theme = data.get("theme", {})
            colors = theme.get("colors", {})
            fonts = theme.get("fonts", {})
            slides = data.get("slides", [])

            # Extract layout names and slide titles
            slide_previews = []
            for s in slides:
                first_text = ""
                for el in s.get("elements", []):
                    if el.get("type") == "text":
                        txt = str(el.get("text") or el.get("content") or "").strip()
                        if txt:
                            first_text = txt.split("\n")[0][:40]
                            break
                slide_previews.append({
                    "id": s.get("id"),
                    "layout": s.get("layout", "content"),
                    "title": first_text or s.get("layout", "Slide"),
                })

            templates.append({
                "titleSlideColors": _title_slide_colors(data),
                "id": path.stem,
                "title": data.get("title", path.stem),
                "brand": data.get("metadata", {}).get("brand", brand_text("Buddy Presentation")),
                "themeId": data.get("metadata", {}).get("themeId", path.stem),
                "fonts": {
                    "heading": fonts.get("heading", "IBM Plex Sans"),
                    "body": fonts.get("body", "IBM Plex Sans"),
                },
                "colors": {
                    "primary": "#" + str(colors.get("primary", "5B1F8A")).lstrip("#"),
                    "secondary": "#" + str(colors.get("secondary", "8B2FC9")).lstrip("#"),
                    "accent": "#" + str(colors.get("accent", colors.get("lavender", "C084FC"))).lstrip("#"),
                    "background": "#" + str(colors.get("background", "FFFFFF")).lstrip("#"),
                    "text": "#" + str(colors.get("text", "1A0A2E")).lstrip("#"),
                    "chartPalette": ["#" + str(c).lstrip("#") for c in (data.get("theme", {}).get("chartPalette") or colors.get("chartPalette") or ["5B1F8A", "8B2FC9", "3D1060", "C084FC"])],
                },
                "slidesCount": len(slides),
                "slidePreviews": slide_previews,
            })
        except Exception:
            continue

    if username:
        from app import postgres_storage as storage
        for row in storage.list_files(username, _TEMPLATE_SCOPE):
            template_id = Path(row["path"]).stem
            if template_id.startswith("custom-"):
                templates.append(_custom_catalog(template_id, get_presentation_template(template_id, username)))
    return templates


def get_presentation_template(template_id: str, username: str | None = None) -> dict[str, Any]:
    """Retrieve full template deck JSON by ID."""
    if not _ID_RE.fullmatch(template_id):
        raise HTTPException(status_code=400, detail="Invalid template ID")
    if template_id.startswith("custom-"):
        from app import postgres_storage as storage
        row = storage.get_file(username, _TEMPLATE_SCOPE, template_id + ".bobdeck") if username else None
        if not row:
            raise HTTPException(status_code=404, detail="Template not found")
        return json.loads(row["content"])
    path = TEMPLATES_DIR / f"{template_id}.bobdeck"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Template not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read template: {exc}")


def slide_count_instruction(slide_count: int | None) -> str:
    if slide_count is None:
        return "Choose a suitable number of slides for the requested content."
    if type(slide_count) is not int or not 1 <= slide_count <= 50:
        raise ValueError("Slide count must be an integer from 1 to 50")
    return (f"Generate exactly {slide_count} slides in total, including any title, agenda, and closing slides. "
            "This selected count takes precedence over template examples or suggested outlines. "
            "Combine or expand topics to fit; for a single slide, combine the title and key takeaways. "
            "Before finishing, count the actual slides in the saved file and correct any mismatch.")


def build_presentation_prompt(template_id: str, user_topic: str, *, username: str | None = None, slide_count: int | None = None, output_path: str = "presentation.bobdeck") -> str:
    """Build detailed presentation prompt instructing Buddy to generate valid .bobdeck."""
    template = get_presentation_template(template_id, username)
    title = template.get("title", template_id)
    brand = template.get("metadata", {}).get("brand", "Custom")
    theme = template.get("theme", {})

    count_instruction = slide_count_instruction(slide_count)
    return f"""You are the Bob Presentation Studio Architect.
The user wants you to create a presentation on:
"{user_topic}"

Use the "{title}" ({brand}) design system.
Use the exact selected shapes, card border width, decoration placement, contentLayout and chartType from theme.design. Reuse the supplied slide geometry below. Sample chart values are illustrative placeholders; replace them only with supplied or verified data, or ask the user for data. Never present sample values as real facts. The htmlNavigation and htmlTransition settings apply only to HTML exports.\nLayout examples:\n{json.dumps(template.get("slides", []) if theme.get("design") else [], ensure_ascii=False)}\nTemplate theme configuration to use:
{json.dumps(theme, indent=2)}

INSTRUCTIONS:
1. Generate a complete, polished presentation following the .bobdeck format; keep the saved deck a valid JSON object throughout incremental construction.
2. The coordinate system is 16:9 widescreen: width is 13.333 inches, height is 7.5 inches.
3. Every slide must have:
   - "id": unique string (e.g. "slide-1-hero", "slide-2-cards", "slide-3-kpi-chart", "slide-4-closing")
   - "layout": "hero" | "content"
   - "background": {{"color": "HEX"}}
   - "elements": array of shape, text, chart, or table objects.
4. Support element types:
   - text: {{"id": "...", "type": "text", "x": num, "y": num, "width": num, "height": num, "content": "text string", "style": {{"fontSize": num, "color": "HEX", "fontWeight": "bold"|"normal", "align": "left"|"center"|"right"}}}}
   - shape: {{"id": "...", "type": "shape", "shape": "roundedRectangle"|"rectangle"|"ellipse", "x": num, "y": num, "width": num, "height": num, "fill": "HEX", "border": {{"color": "HEX", "width": 1}}}}
   - chart: {{"id": "...", "type": "chart", "chartType": "bar"|"line"|"pie"|"doughnut", "x": num, "y": num, "width": num, "height": num, "title": "Chart Title", "categories": ["Q1","Q2","Q3","Q4"], "series": [{{"name": "Series Name", "values": [10, 20, 30, 40], "color": "HEX"}}]}}
   - icons / badges: For card headers or feature highlights, use an ellipse shape badge containing a text element with a single universal icon/emoji (e.g., 🔒, ⏱, 📊, ⚡, 🎯, 🚀, 💡, 🛡, 👥, 📈). The presentation studio automatically rasterizes and embeds these as crisp images so they render identically without missing-font glitches in ONLYOFFICE and PowerPoint.
5. {count_instruction}
   Derive the outline, content types and order from the user's topic, audience and requested slide count. The catalog selects visual styling; it does not prescribe a business scenario or content outline. Use only user-provided or verified factual values, clearly labeling missing data.
6. Provide a concise, professional 1-2 sentence overview first introducing the deck to the user.
7. Write a valid initial .bobdeck JSON scaffold to {json.dumps(output_path)} immediately after the short outline, before preparing the entire deck. Include the required schema, selected theme, deck title and a first draft slide so Studio can open it. Then build and save completed slides incrementally to the same file, keeping the JSON valid and existing slides available after every save. Do not wait until all slides are finished before the first write. Each saved update must use the normal .bobdeck structure, not an alternate streaming format.
8. Verify the final JSON and exact selected slide count. In the final reply, mention the saved file and any missing data. Do not paste the full deck into chat; Studio renders the saved file.
"""


def build_html_presentation_prompt(user_topic: str, *, username: str | None = None, existing: bool = False, template_id: str | None = None, slide_count: int | None = None, output_path: str = "presentation.html") -> str:
    """Build detailed presentation prompt instructing Buddy to generate a rich standalone interactive HTML presentation."""
    navigation = True
    transition = 'fade'
    if template_id:
        template = get_presentation_template(template_id, username)
        navigation = template.get('theme', {}).get('design', {}).get('htmlNavigation', True)
        transition = template.get('theme', {}).get('design', {}).get('htmlTransition', 'fade')
        user_topic += "\n\nSelected visual template: " + template.get("title", template_id)
        user_topic += "\nMatch theme.design shape, card border width and sidebar/topbar/none decoration using CSS/SVG. Keep the supplied layout geometry and selected palette in the HTML slides. Layout examples: " + json.dumps(template.get("slides", []) if template.get("theme", {}).get("design") else [], ensure_ascii=False)
        user_topic += "\nApply this template's fonts, palette and visual styling to the HTML deck. This selected theme takes precedence over any default theme mentioned elsewhere.\n" + json.dumps(template.get("theme", {}), ensure_ascii=False)
        user_topic += '\nHonor contentLayout and chartType choices. Illustrative sample values are placeholders; replace them only with supplied or verified data, or request the missing data. Do not present them as real facts.'
    navigation_instruction = ('Use an agenda with clickable slide targets, arrow and Space navigation, and a visible slide count. Keyboard slide shortcuts must not intercept typing, sliders, selectors, or buttons.' if navigation else 'The selected template disables HTML slide navigation. Render all slides as vertically scrollable sections with no previous/next controls, agenda controls or global keyboard slide shortcuts. Keep useful content controls interactive.')
    transition_instruction = (f'The selected HTML entry transition is {transition}. Use a brief CSS {transition} entrance for newly visible slides; disable it entirely for prefers-reduced-motion.' if transition in ('fade', 'slide') else 'The selected HTML entry transition is none. Do not add slide entrance animations.')
    edit_instruction = f"""An existing {output_path} is present. Treat this as an EDIT of that file, not a request to recreate it.
Before editing, locate only the relevant slide, CSS rule, data entry, or JavaScript handler with targeted searches (for example rg -n) and read bounded line ranges. Do not read, paste, or rewrite the entire HTML into your context for a small change. Apply a narrow patch that preserves other slides and interactions. Inspect the diff and run focused checks. If the user explicitly requests a full redesign, you may rebuild it, but first outline the affected sections and report progress.
""" if existing else f"""Create a new {output_path}. Inspect the template's structure with bounded searches and line ranges; do not dump the entire template into context at once.
"""

    count_instruction = slide_count_instruction(slide_count)
    return f"""You are the Bob Interactive Presentation Studio Architect.
The user wants you to create an interactive web presentation on:
"{user_topic}"

{edit_instruction}
SLIDE COUNT: {count_instruction}
INSTRUCTIONS:
Use IBM Plex Sans consistently for all slide text. Use Carbon's shared typography scale: body-02 for body copy, body-01 for labels and controls, heading-05 for slide titles, heading-04 for section headings and heading-03 for subheadings. Do not shrink text with viewport-based font sizes; split crowded content across slides. Include <link id="buddy-carbon-css" rel="stylesheet" href="/static/carbon-charts.css"> and <script id="buddy-carbon-js" src="/static/carbon-charts.bundle.js"></script>, and mark <body data-buddy-presentation="true"> so the shared type tokens apply and the final HTML packages its fonts for offline use. Respect these tokens instead of alternate template fonts unless the user explicitly requests a different font.
Activate the presentation-buddy skill if it is available in this workspace.
1. For a new deck, first write a valid initial HTML scaffold to {output_path}, including the presentation metadata marker, selected template styling, the selected navigation behavior and a first draft slide. Save this before researching or preparing the remaining slides so Studio can open the work immediately. Build and save completed slides incrementally to the same file. Keep <html>, <body>, </body>, </html>, existing slides and selected navigation behavior intact after every saved update. Do not wait until all slides are finished before the first write. For a new deck, use /opt/bob-a2a/app/presentation_templates/interactive_deck_template.html as a visual and structural reference. For an edit, inspect the existing {output_path} and keep its design unless the user asks to change it. Replace external Chart.js and GSAP links with bundled local assets or native HTML, CSS, JavaScript and SVG when producing a single file for sharing.
2. Mark the document with <meta name="bob-artifact-role" content="presentation"> and use section elements with class="slide" for slides. Produce one complete HTML document at {output_path} with all essential styling, scripts, and data in the file. Do not output a static screenshot or a .bobdeck for this HTML request. Keep the selected PowerPoint template workflow available when the user chooses PowerPoint.
3. INTERACTIVE SLIDES ARE A PRIMARY REQUIREMENT. Make every substantive content slide meaningfully interactive wherever the subject permits; title and closing slides may stay simple. Before implementing, plan a useful interaction for each content slide: scenario sliders, editable assumptions, model or option selectors, comparison toggles, clickable architecture nodes with detail panels, expandable evidence, step-through workflows, or chart filters. Each control must change the information, calculation, chart, or explanation on that slide. Navigation, hover effects, entrance animations, and decorative motion do not count as content interactions. Maximize useful exploration without clutter: show clear labels, immediate feedback, current selections, and a reset-to-defaults action for simulations. Preserve an understandable initial view before any interaction.

   {navigation_instruction} {transition_instruction} Include useful tooltips or focus details. Show charts correctly after their slide becomes visible. Use 180–400 ms transitions for chart updates, comparison toggles, detail panels and workflow steps; animate opacity/transform without shifting the surrounding layout. Preserve the current slide, scroll position and selections while live content updates. Do not replay entrances for every generated snapshot or add flashing/perpetual decorative animation. Respect reduced-motion for all content interactions.
4. Put figures in one explicit JavaScript data object. Derive displayed percentages from the underlying counts. Use factual numbers supplied by the user or verified in source files or authoritative sources; interactive scenarios may use explicitly labeled editable assumptions. For missing metrics use clearly labeled placeholders instead of invented values. Preserve units, reporting periods, legends, and source notes.
5. Make controls and any enabled agenda entries real buttons with 44 by 44 CSS pixel touch targets and focus styles. When slide navigation is enabled, support horizontal swipe while keeping vertical slide scroll and chart gestures; otherwise keep normal vertical page scrolling. Honor prefers-reduced-motion, dynamic viewport height, and mobile safe area insets. Test the selected navigation behavior, every toggle, chart rendering, phone and tablet portrait and landscape, and desktop. Check real iOS Safari and Android Chrome when available. For Teams sharing, explain that a Teams file preview may block scripts; supply a self-contained file to open in a browser, or a hosted HTTPS Teams tab if interaction inside Teams is required.
6. Save the complete file to {output_path} in the current workspace. In the final response, mention {output_path} and state any missing data or unverified behavior. Do not paste the whole HTML into chat; the UI loads the saved file for preview.
"""


def build_html_edit_guidance(user_topic: str, path: str = 'presentation.html') -> str:
    """Guide Agent mode when a user edits a saved HTML presentation."""
    return f"""The user is working on the existing artifact {json.dumps(path)} in this workspace.
Request: {user_topic}

- Edit this saved file in place, using its current content as the source of truth.
- Inspect relevant content, styles, data and scripts with bounded searches and reads.
- Patch only affected sections. Preserve other content, layout, slide structure (if this is a presentation), navigation and interactions.
- Do not select a template or recreate the artifact unless explicitly requested.
- Keep the last complete file available during any necessary rewrite; use manageable writes.
- Verify the resulting document is complete and its relevant interactions still work. HTML must retain </body> and </html>; only presentations require slide sections. For a .bobdeck file retain valid JSON, schema version, theme and element IDs.
- Give brief progress updates and summarize the changes and verification.
"""


def presentation_intent(prompt: str, mode: str | None = None, skill_name: str | None = None, username: str | None = None) -> dict:
    """Resolve deck setup centrally; templates always come from the current catalog."""
    suppressed = prompt.startswith(("My answers to your follow-up questions:", "I have cancelled this clarification form"))
    subject = re.search(r"\b(presentations?|slides?|slide\s*deck|decks?|powerpoint|pptx|slideshow)\b", prompt, re.I)
    action = re.search(r"\b(create|generate|build|make|prepare|design|want|need|turn|convert|give|produce|draft|write|summarize|summarise|put)\b", prompt, re.I)
    noun_request = re.match(r"^\s*(?:(?:please|a|an|the)\s+)*(?:presentation|slide\s*deck|deck|slideshow)\s+(?:about|on|for)\b", prompt, re.I)
    explanatory = re.search(r"\b(?:how\s+(?:do|can|would|should|to)|what\s+(?:is|are)|explain\s+how)\b", prompt, re.I)
    editing = re.search(r"\b(?:edit|update|change|revise|fix|improve|redesign)\b", prompt, re.I)
    negated = re.search(r"\b(?:do not|don't|no|without)\s+(?:(?:create|make|generate|a|any)\s+)*(?:presentation|slides?|deck|powerpoint)\b", prompt, re.I)
    presentation = mode == 'presentation' or skill_name == 'presentation-buddy' or bool(subject and (action or noun_request) and not suppressed and not negated and not explanatory and not editing)
    from app.html_artifact_policy import is_html_artifact_request
    if is_html_artifact_request(prompt):
        presentation = False
    count = re.search(r"\b(\d{1,2})\s*(?:[-–]\s*)?slides?\b|\b(?:slide\s*count|number\s*of\s*slides|slides)\s*(?:[:=]\s*)?(\d{1,2})\b", prompt, re.I)
    slide_count = int(next(value for value in count.groups() if value)) if count else None
    if slide_count is not None and not 1 <= slide_count <= 50:
        slide_count = None
    fmt = 'pptx' if re.search(r"\b(powerpoint|pptx)\b", prompt, re.I) else 'html' if re.search(r"\b(html|interactive|web)\b", prompt, re.I) or skill_name == 'presentation-buddy' else None
    return {'presentation': presentation, 'format': fmt, 'slide_count': slide_count,
            'templates': list_presentation_templates(username) if presentation else []}


def artifact_role(path: str, content: str | bytes = '') -> dict:
    """Recognize HTML slide structure without mistaking report filenames for decks."""
    from html.parser import HTMLParser
    suffix = Path(path).suffix.lower()
    presentation = suffix in {'.bobdeck', '.ppt', '.pptx'}
    if suffix in {'.html', '.htm'}:
        class SlideParser(HTMLParser):
            found = False
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                classes = set(attrs.get('class', '').lower().split())
                if ('slide' in classes and tag in {'section', 'article', 'div'}) or 'data-slide' in attrs:
                    self.found = True
                if tag == 'meta' and attrs.get('name', '').lower() == 'bob-artifact-role' and attrs.get('content', '').lower() == 'presentation':
                    self.found = True
        parser = SlideParser()
        try:
            parser.feed(content.decode('utf-8', errors='replace') if isinstance(content, bytes) else content)
            presentation = parser.found
        except Exception:
            presentation = False
    return {'is_presentation': presentation, 'role': 'presentation' if presentation else 'artifact'}
