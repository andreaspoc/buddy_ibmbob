import json
import unittest
from pydantic import ValidationError
from app import office_assistant as oa

class WordColorsTests(unittest.TestCase):
    def test_custom_colors_are_supported_for_word_blocks_and_headers(self):
        plan=oa.parse_plan(json.dumps({'version':1,'kind':'word','reply':'Colors ready for review','actions':[
            {'type':'set_header','text':'Company','font_color':'#123456','fill':'#F6F2FF'},
            {'type':'insert_blocks','position':'end','blocks':[
                {'type':'heading','text':'Invoice','font_color':'#8a3ffc','fill':'#F6F2FF'},
                {'type':'table','rows':[['Description','Total'],['[Item]','[Amount]']],'header_fill':'#123456','header_font_color':'#FFFFFF','alternate_fill':'#E0F2F1'}]}]}),'docx')
        self.assertEqual(plan.actions[1].blocks[0].font_color,'#8a3ffc')
        self.assertEqual(plan.actions[1].blocks[1].header_fill,'#123456')
    def test_invalid_colors_are_rejected(self):
        for color in ['purple','#abc','#12345678','url(example)',123]:
            with self.subTest(color=color),self.assertRaises(ValidationError):
                oa.Paragraph(type='paragraph',text='Text',font_color=color)
    def test_custom_colors_are_in_generation_schema(self):
        prompt=oa.completion_for(oa.Draft(prompt='Use purple headings',context={'kind':'word'}),'docx').messages[0].content
        self.assertIn('Honor supplied hex/brand colors exactly',prompt)
        self.assertIn('header_fill',prompt)

if __name__=='__main__': unittest.main()
