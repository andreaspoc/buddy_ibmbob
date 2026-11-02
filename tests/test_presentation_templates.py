import unittest
from unittest.mock import patch
from pydantic import ValidationError
from fastapi import HTTPException
from app.presentation import (PresentationTemplateCreate, create_presentation_template,
                              get_presentation_template, list_presentation_templates,
                              build_presentation_prompt, build_html_presentation_prompt)

class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.files = {}
        self.config = dict(title='My studio', brand='My brand',
                           colors=dict(primary='#123456', secondary='#234567', accent='#345678', background='#FFFFFF', text='#111111'),
                           fonts=dict(heading='Arial', body='Calibri'),
                           design=dict(shape='ellipse', decoration='topbar', cardBorderWidth=3))
        self.patches = [patch('app.postgres_storage.put_file', side_effect=lambda user, scope, path, content: self.files.__setitem__((user,scope,path), {'content': content})),
                        patch('app.postgres_storage.get_file', side_effect=lambda user, scope, path: self.files.get((user,scope,path))),
                        patch('app.postgres_storage.list_files', side_effect=lambda user, scope: [{'path': path} for owner, bucket, path in self.files if owner == user and bucket == scope])]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_roundtrip_owner_isolation_and_generation(self):
        item = create_presentation_template('alice', PresentationTemplateCreate(**self.config))
        deck = get_presentation_template(item['id'], 'alice')
        self.assertEqual(deck['metadata']['studioConfig'], PresentationTemplateCreate(**self.config).model_dump())
        self.assertEqual([s['layout'] for s in deck['slides']], ['hero', 'content', 'closing'])
        self.assertEqual(deck['slides'][0]['elements'][2]['shape'], 'ellipse')
        self.assertEqual(deck['slides'][0]['elements'][0]['h'], .22)
        cards = [el for el in deck['slides'][1]['elements'] if el['type'] == 'shape' and el['shape'] == 'ellipse']
        self.assertEqual(len(cards), 3)
        self.assertEqual(cards[0]['fill'], '#234567')
        self.assertEqual(cards[0]['stroke'], '#345678')
        self.assertEqual(cards[0]['lineWidth'], 3)
        self.assertEqual((cards[0]['x'], cards[0]['y'], cards[0]['w'], cards[0]['h']), (.85, 2.65, 3.65, 2.6))
        self.assertEqual(deck['slides'][0]['elements'][1]['text'], 'My brand')
        self.assertEqual(deck['theme']['chartPalette'], ['#123456', '#345678', '#234567'])
        self.assertIn(item, list_presentation_templates('alice'))
        self.assertNotIn(item, list_presentation_templates('bob'))
        with self.assertRaises(HTTPException) as denied:
            get_presentation_template(item['id'], 'bob')
        self.assertEqual(denied.exception.status_code, 404)
        for prompt in [build_presentation_prompt(item['id'], 'Actual topic', username='alice'),
                       build_html_presentation_prompt('Actual topic', template_id=item['id'], username='alice')]:
            self.assertIn('ellipse', prompt)
            self.assertIn('cardBorderWidth', prompt)
            self.assertIn('topbar', prompt)
            self.assertIn('Actual topic', prompt)

    def test_catalog_preview_uses_actual_title_slide_colors(self):
        import json
        from app.presentation import TEMPLATES_DIR
        catalog = {item['id']: item for item in list_presentation_templates()}
        for path in TEMPLATES_DIR.glob('*.bobdeck'):
            deck = json.loads(path.read_text())
            slide = deck['slides'][0]
            title = next(element for element in slide['elements'] if element.get('id') == 'title')
            self.assertEqual(catalog[path.stem]['titleSlideColors'], {
                'background': '#' + slide['background']['color'].lstrip('#'),
                'text': '#' + title['style']['color'].lstrip('#'),
            })
        self.assertEqual(catalog['navy-starter']['colors']['background'], '#FFFFFF')
        self.assertEqual(catalog['navy-starter']['titleSlideColors']['background'], '#0B1D45')
        custom = create_presentation_template('alice', PresentationTemplateCreate(**self.config))
        self.assertEqual(custom['titleSlideColors'], {'background': '#FFFFFF', 'text': '#111111'})

    def test_invalid_designs(self):
        for key, value in [('cardBorderWidth', -1), ('cardBorderWidth', 5), ('cardBorderWidth', True), ('shape', 'script'), ('decoration', 'arbitrary'), ('contentLayout', 'unknown'), ('chartType', 'scatter'), ('htmlNavigation', 'true'), ('htmlTransition', 'zoom')]:
            config = {**self.config, 'design': {**self.config['design'], key: value}}
            with self.assertRaises(ValidationError):
                PresentationTemplateCreate(**config)
        with self.assertRaises(ValidationError):
            PresentationTemplateCreate(**{**self.config, 'colors': {**self.config['colors'], 'primary': 'red'}})

    def test_layouts_and_native_chart_roundtrip(self):
        for layout in ['comparison', 'timeline']:
            config = {**self.config, 'design': {**self.config['design'], 'contentLayout': layout, 'chartType': 'doughnut', 'htmlNavigation': False}}
            item = create_presentation_template('alice', PresentationTemplateCreate(**config))
            deck = get_presentation_template(item['id'], 'alice')
            self.assertEqual([s['layout'] for s in deck['slides']], ['hero', 'content', 'chart', 'closing'])
            cards = [e for e in deck['slides'][1]['elements'] if e['type'] == 'shape' and e['shape'] == 'ellipse']
            self.assertEqual(len(cards), 2 if layout == 'comparison' else 3)
            self.assertEqual(cards[0]['w'], 5.45 if layout == 'comparison' else 3.65)
            chart = next(e for e in deck['slides'][2]['elements'] if e['type'] == 'chart')
            self.assertEqual(chart['chartType'], 'doughnut')
            self.assertEqual(chart['categories'], ['A', 'B', 'C'])
            self.assertEqual(chart['series'][0]['values'], [25, 40, 35])
            self.assertEqual(chart['title'], 'Illustrative sample values')
            html = build_html_presentation_prompt('Real topic', template_id=item['id'], username='alice')
            self.assertIn('vertically scrollable sections', html)
            self.assertNotIn('Use an agenda with clickable slide targets', html)
            self.assertIn('supplied or verified data', html)

    def test_legacy_config_keeps_three_slides(self):
        config = PresentationTemplateCreate(**self.config)
        self.assertEqual(config.design.chartType, 'none')
        self.assertEqual(config.design.contentLayout, 'cards')
        self.assertTrue(config.design.htmlNavigation)
        self.assertEqual(config.design.htmlTransition, 'fade')

    def test_html_transition_preferences(self):
        for transition in ['none', 'fade', 'slide']:
            config = {**self.config, 'design': {**self.config['design'], 'htmlTransition': transition}}
            item = create_presentation_template('alice', PresentationTemplateCreate(**config))
            deck = get_presentation_template(item['id'], 'alice')
            self.assertEqual(deck['theme']['design']['htmlTransition'], transition)
            prompt = build_html_presentation_prompt('Real topic', template_id=item['id'], username='alice')
            self.assertIn(f'entry transition is {transition}', prompt)
            if transition != 'none':
                self.assertIn('disable it entirely for prefers-reduced-motion', prompt)

if __name__ == '__main__':
    unittest.main()
