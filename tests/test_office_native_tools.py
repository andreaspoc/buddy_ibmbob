import json
import unittest
from pydantic import ValidationError
from app import office_assistant as oa

class NativeToolsTests(unittest.TestCase):
    def plan(self,kind,actions):
        return oa.Plan.model_validate({'version':1,'kind':kind,'reply':'Synthetic tool review','actions':actions})
    def test_excel_native_controls_and_operations(self):
        actions=[
            {'type':'sort_range','range':'A1:D10','keys':[{'column':2,'order':'descending'}]},
            {'type':'filter_range','range':'A1:D10','field':2,'criteria':['Open','Closed']},
            {'type':'set_validation','range':'B2:B10','rule':'list','options':['Open','Closed']},
            {'type':'conditional_format','range':'C2:C10','formula1':'100','fill':'#F1C21B'},
            {'type':'freeze_panes','rows':1,'columns':1},
            {'type':'create_table','range':'A1:D10'},
            {'type':'range_dimensions','range':'A1:D10','row_height':24,'column_width':20},
            {'type':'sheet_options','gridlines':False,'orientation':'landscape'},
        ]
        self.assertEqual(len(self.plan('cell',actions).actions),8)
        for bad in [dict(actions[0],keys=[{'column':5}]),dict(actions[2],options=['a,b']),dict(actions[5],range='A1'),dict(actions[6],row_height=float('nan'))]:
            with self.subTest(bad=bad),self.assertRaises(ValidationError):self.plan('cell',[bad])
    def test_slides_target_recorded_objects_and_preserve_selection_scope(self):
        context=oa.Context(kind='slide',current_slide=2,slide_count=3,slide_shapes=[{'slide_index':2,'shape_index':1,'text':'Existing label','selected':True}])
        action={'type':'replace_slide_text','slide_index':2,'shape_index':1,'old_text':'Existing label','text':'New label'}
        plan=self.plan('slide',[action]);oa.validate_context_plan(plan,context)
        req=oa.Draft(prompt='Change this label',context_mode='selection',context=context)
        oa.validate_selection_scope(plan,req)
        for bad in [dict(action,old_text='Invented text'),dict(action,shape_index=2)]:
            with self.assertRaises(ValueError):oa.validate_context_plan(self.plan('slide',[bad]),context)
        with self.assertRaises(ValueError):oa.validate_selection_scope(self.plan('slide',[{'type':'slide_operation','slide_index':2,'operation':'delete'}]),req)
    def test_selected_cells_are_a_hard_boundary(self):
        req=oa.Draft(prompt='Add choices',context_mode='selection',context={'kind':'cell','sheet':'Data','range':'B2:B5'})
        oa.validate_selection_scope(self.plan('cell',[{'type':'set_validation','range':'B2:B5','rule':'list','options':['Yes','No']}]),req)
        with self.assertRaises(ValueError):oa.validate_selection_scope(self.plan('cell',[{'type':'set_validation','range':'B2:B6','rule':'list','options':['Yes','No']}]),req)
    def test_context_privacy_and_editor_capability(self):
        req=oa.Draft(prompt='Explain',context_mode='none',context={'kind':'slide','slide_shapes':[{'slide_index':1,'shape_index':1,'text':'Private'}]})
        self.assertEqual(req.context.slide_shapes,[])
        plan=self.plan('cell',[{'type':'create_table','range':'A1:B3'}])
        with self.assertRaises(ValueError):oa.validate_context_plan(plan,oa.Context(kind='cell',editor_capabilities=['sort_range']))
    def test_word_and_slide_native_charts_validate_real_dimensions(self):
        chart={'chart_type':'bar','categories':['A','B'],'series_names':['Values'],'data':[[2,3]],'title':'Synthetic values'}
        self.assertEqual(self.plan('word',[{'type':'add_word_chart',**chart}]).actions[0].type,'add_word_chart')
        self.assertEqual(self.plan('slide',[{'type':'add_slide_chart','slide_index':1,**chart}]).actions[0].data,[[2,3]])
        with self.assertRaises(ValidationError):self.plan('slide',[{'type':'add_slide_chart','slide_index':1,**chart,'data':[[2]]}])
    def test_chart_edits_target_known_chart_and_keep_selection_private(self):
        plan=self.plan('cell',[{'type':'edit_chart','chart_index':1,'sheet':'Data','legend':'right'}])
        context=oa.Context(kind='cell',sheet='Data',range='A1',charts=[{'chart_index':1,'sheet':'Data','selected':True}])
        oa.validate_context_plan(plan,context)
        oa.validate_selection_scope(plan,oa.Draft(prompt='Move legend',context_mode='selection',context=context))
        with self.assertRaises(ValueError):oa.validate_context_plan(plan,oa.Context(kind='cell',charts=[]))

    def test_generation_schema_is_scoped_and_chart_destination_is_explicit(self):
        word=json.dumps(oa.plan_schema_for('docx'));cell=json.dumps(oa.plan_schema_for('xlsx'))
        self.assertIn('add_word_chart',word);self.assertNotIn('sort_range',word)
        self.assertIn('set_validation',cell);self.assertNotIn('add_slide_chart',cell)
        for kind,ext in [('word','docx'),('cell','xlsx'),('slide','pptx')]:
            content=oa.completion_for(oa.Draft(prompt='Help with the selection',context={'kind':kind}),ext).messages[0].content
            self.assertLessEqual(len(content),oa.office_ai.MAX_INPUT)
            self.assertIn('default the chart destination to context.sheet',content)

if __name__=='__main__':unittest.main()
