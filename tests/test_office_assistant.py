"""Validated plans, authenticated ownership, streaming, and cancellation."""
import asyncio
import json
from unittest import TestCase, main
from unittest.mock import AsyncMock, patch
from uuid import uuid4
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import office_assistant as oa

PLAN={'version':1,'kind':'word','reply':'Prepared for review','actions':[{'type':'set_header','text':'Company','alignment':'left'},{'type':'insert_blocks','position':'end','blocks':[{'type':'heading','text':'Overview','level':1}]}]}
class AssistantTests(TestCase):
    def setUp(self):
        self.app=FastAPI(); self.app.include_router(oa.router)
        self.url=f'/api/office/assistant/files/{uuid4()}/draft'
        self.body={'prompt':'Write a report','context':{'kind':'word'}}
        oa.office_ai._active.clear()
    def login(self): self.app.dependency_overrides[oa.current_user]=lambda:{'username':'alice'}
    def test_context_modes_enforce_content_scope(self):
        for kind in ('word', 'cell', 'slide', 'pdf', 'html'):
            for mode in ('selection', 'none'):
                req = oa.Draft(prompt='Explain this', context_mode=mode,
                    context={'kind': kind, 'text': 'Private body', 'selection': 'Selected passage',
                             'header': 'Private header', 'footer': 'Private footer', 'values': [[42]],
                             'html_nodes': [{'index': 1, 'text': 'Private node', 'tag': 'p'}],
                             'pages': [{'page': 1, 'objects': [{'object_index': 1, 'text': 'Private object'}]}]},
                    history=[{'prompt': 'Earlier', 'reply': 'Private earlier excerpt', 'state': 'applied'}])
                self.assertEqual(req.context.text, '')
                self.assertIsNone(req.context.header)
                self.assertIsNone(req.context.footer)
                self.assertEqual(req.context.html_nodes, [])
                self.assertEqual(req.context.pages, [])
                self.assertEqual(req.history, [])
                self.assertEqual(req.context.selection, 'Selected passage' if mode == 'selection' else '')
                self.assertEqual(req.context.values, [[42]] if mode == 'selection' else [])

    def test_selection_mode_never_reads_full_saved_workbook(self):
        self.login()
        body = {'prompt': 'Explain selection', 'context_mode': 'selection',
                'context': {'kind': 'cell', 'sheet': 'Data', 'range': 'A1', 'values': [[42]]}}
        async def events(*args, **kwargs):
            yield json.dumps({'type': 'plan', 'plan': {'version': 1, 'kind': 'cell', 'reply': '42', 'actions': []}}) + '\n'
        with patch.dict('os.environ', {'BOB_API_KEY': 'test'}), patch.object(oa, 'owned_extension', return_value='xlsx'), \
                patch.object(oa, 'compute_spreadsheet_analytics') as analytics, patch.object(oa, 'draft_events', events):
            with TestClient(self.app) as client:
                self.assertEqual(client.post(self.url, json=body).status_code, 200)
            analytics.assert_not_called()

    def test_follow_up_history_has_explicit_edit_state(self):
        req = oa.Draft(prompt='Explain your previous changes', context={'kind': 'word'},
            history=[{'prompt': 'Rewrite', 'reply': 'Proposed text', 'state': 'discarded'}])
        content = oa.completion_for(req, 'docx').messages[0].content
        self.assertIn('"state": "discarded"', content)
        self.assertIn('fresh context is authoritative', content)

    def test_plan_strict_and_applicable(self):
        self.assertEqual(oa.parse_plan(json.dumps(PLAN),'docx').actions[0].type,'set_header')
        for plan,extension in [({**PLAN,'execute':'evil'},'docx'),({**PLAN,'reply':' '},'docx'),(PLAN,'xlsx')]:
            with self.assertRaises(ValueError): oa.parse_plan(json.dumps(plan),extension)
        # CSV and XLSX are treated identically for cell plans
        cell_plan={'version':1,'kind':'cell','reply':'Review','actions':[{'type':'add_sheet','name':'Test'}]}
        self.assertEqual(oa.parse_plan(json.dumps(cell_plan),'xlsx').actions[0].type,'add_sheet')
        self.assertEqual(oa.parse_plan(json.dumps(cell_plan),'csv').actions[0].type,'add_sheet')
        with self.assertRaises(ValueError): oa.parse_plan('Here is '+json.dumps(PLAN),'docx')
        self.assertEqual(oa.parse_plan('```json\n'+json.dumps(PLAN)+'\n```','docx').version,1)
    def test_pdf_plans_are_bounded_and_capability_checked(self):
        context = oa.Context(kind='pdf', page_count=2, capabilities=['pdf_add_text', 'pdf_rotate_page', 'pdf_update_text'],
            pages=[{'page': 1, 'objects': [{'object_index': 1, 'text': 'Old', 'editable': True}]}])
        plan = oa.parse_plan(json.dumps({'version': 1, 'kind': 'pdf', 'reply': 'Review edits',
            'actions': [{'type': 'pdf_add_text', 'page': 1, 'text': 'Draft'},
                        {'type': 'pdf_rotate_page', 'page': 2, 'angle': 90},
                        {'type': 'pdf_update_text', 'page': 1, 'object_index': 1, 'old_text': 'Old', 'text': 'New'}]}), 'pdf')
        oa.validate_context_plan(plan, context)
        for invalid_context in (oa.Context(kind='pdf', page_count=2),
                oa.Context(kind='pdf', page_count=1, capabilities=context.capabilities),
                oa.Context(kind='pdf', page_count=2, capabilities=context.capabilities)):
            with self.assertRaises(ValueError):
                oa.validate_context_plan(plan, invalid_context)
        with self.assertRaises(ValueError):
            oa.parse_plan(json.dumps(PLAN), 'pdf')
        for action in ({'type': 'pdf_rotate_page', 'page': 1, 'angle': 45},
                {'type': 'pdf_add_text', 'page': 0, 'text': 'Bad'},
                {'type': 'pdf_add_text', 'page': 1, 'text': 'Bad', 'x': -1}):
            with self.assertRaises(ValueError):
                oa.parse_plan(json.dumps({'version': 1, 'kind': 'pdf', 'reply': 'Review', 'actions': [action]}), 'pdf')
        req = oa.Draft(prompt='Summarize', context={'kind': 'pdf', 'page_count': 1, 'text_available': False})
        self.assertIn('Empty text is not evidence of a blank PDF', oa.completion_for(req, 'pdf').messages[0].content)

    def test_existing_page_context_and_limits(self):
        req=oa.Draft(prompt='Create a report',context={'kind':'word','header':'Company','footer':'Private','sheet':'Sheet1'})
        content=oa.completion_for(req,'docx').messages[0].content
        self.assertIn('"header": "Company"',content)
        self.assertIn('"footer": "Private"',content)
        self.assertIn('CURRENT document',content)
        for model,fields in [(oa.SetHeader,{'type':'set_header','text':'x'*4001}),
                             (oa.SetFooter,{'type':'set_footer','text':'x'*4001}),
                             (oa.SetPrintHeaderFooter,{'type':'set_print_header_footer','header':'x'*4001}),
                             (oa.Context,{'kind':'word','footer':'x'*4001})]:
            with self.assertRaises(ValidationError): model(**fields)

    def test_selection_rewrite_policy_and_validated_plan(self):
        req=oa.Draft(prompt='Rewrite the selected text professionally',context={'kind':'word','text':'Keep before. Weak text. Keep after.','selection':'Weak text.'})
        prompt=oa.completion_for(req,'docx').messages[0].content
        self.assertIn('use insert_blocks with position replace_selection',prompt)
        self.assertIn('Preserve all surrounding document content',prompt)
        self.assertIn('context.selection is empty',prompt)
        self.assertIn('"selection": "Weak text."',prompt)
        plan=oa.parse_plan(json.dumps({'version':1,'kind':'word','reply':'Review the proposed rewrite','actions':[{'type':'insert_blocks','position':'replace_selection','blocks':[{'type':'paragraph','text':'Improved passage.'}]}]}),'docx')
        self.assertEqual(plan.actions[0].position,'replace_selection')

    def test_cell_limits(self):
        for cell_range in ['A1:AE2','A1:A201','B3:A2','XFE1','A0','A1;execute()']:
            with self.assertRaises(ValueError): oa.checked_range(cell_range)
        with self.assertRaises(ValidationError): oa.SetCells(type='set_cells',range='A1:B2',values=[[1]])
        with self.assertRaises(ValidationError): oa.FormatRange(type='format_range',range='A1',fill='url(evil)')
    def test_auth_and_origin(self):
        with TestClient(self.app) as client: self.assertEqual(client.post(self.url,json=self.body).status_code,401)
        self.login()
        with TestClient(self.app) as client:
            self.assertEqual(client.post(self.url,json=self.body,headers={'Origin':'https://evil.example'}).status_code,403)
    def test_ownership_precedes_model(self):
        self.login()
        with patch.object(oa,'owned_extension',side_effect=HTTPException(404,'Office file not found')),patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock) as run:
            with TestClient(self.app) as client: self.assertEqual(client.post(self.url,json=self.body).status_code,404)
            run.assert_not_called()
    def test_stream_has_plan_and_no_raw_actions_in_delta(self):
        self.login()
        async def source(req,language,on_text):
            raw=json.dumps(PLAN)
            await on_text(raw[:40]);await on_text(raw[40:]);return raw
        with patch.dict('os.environ',{'BOB_API_KEY':'test-secret'}),patch.object(oa,'owned_extension',return_value='docx'),patch.object(oa.office_ai,'run_acp',side_effect=source):
            with TestClient(self.app) as client: response=client.post(self.url,json=self.body)
        events=[json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(response.status_code,200)
        self.assertEqual(events[-1]['type'],'done')
        self.assertEqual(next(e['plan'] for e in events if e['type']=='plan')['actions'][0]['type'],'set_header')
        self.assertNotIn('create_form', next(e['plan'] for e in events if e['type']=='plan'))
        self.assertEqual(''.join(e['text'] for e in events if e['type']=='delta'),PLAN['reply'])
        self.assertNotIn('alice',oa.office_ai._active)
    def test_requested_form_is_preserved_in_stream(self):
        self.login()
        plan = {**PLAN, 'actions': [], 'create_form': {
            'name': 'Request', 'title': 'Request',
            'fields': [{'name': 'name', 'label': 'Name'}]}}
        with patch.dict('os.environ', {'BOB_API_KEY': 'test'}), patch.object(oa, 'owned_extension', return_value='docx'), patch.object(oa.office_ai, 'run_acp', new_callable=AsyncMock, return_value=json.dumps(plan)):
            with TestClient(self.app) as client:
                response = client.post(self.url, json={**self.body, 'prompt': 'Create a new fillable PDF form'})
        emitted = next(json.loads(line)['plan'] for line in response.text.splitlines() if json.loads(line)['type'] == 'plan')
        self.assertEqual(emitted['create_form']['title'], 'Request')

    def test_failure_is_private(self):
        self.login()
        with patch.dict('os.environ',{'BOB_API_KEY':'test-secret'}),patch.object(oa,'owned_extension',return_value='docx'),patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock,side_effect=RuntimeError('private selection test-secret')):
            with TestClient(self.app) as client: response=client.post(self.url,json=self.body)
        self.assertIn('"type": "error"',response.text)
        self.assertNotIn('test-secret',response.text);self.assertNotIn('private selection',response.text)
        self.assertNotIn('alice',oa.office_ai._active)
    def test_invalid_plan_regenerates_once_without_raw_values(self):
        self.login()
        invalid='{"version":1,"kind":"word","reply":"Draft preview","actions":[{"type":"arbitrary_code","code":"PRIVATE MODEL CONTENT"}]}'
        with patch.dict('os.environ',{'BOB_API_KEY':'test'}),patch.object(oa,'owned_extension',return_value='docx'),patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock,side_effect=[invalid,json.dumps(PLAN)]) as run:
            with TestClient(self.app) as client: response=client.post(self.url,json=self.body)
        self.assertEqual(run.await_count,2)
        self.assertIn('"type": "plan"',response.text)
        self.assertNotIn('PRIVATE MODEL CONTENT',response.text)
        repair_prompt=run.call_args_list[1].args[0].messages[0].content
        self.assertIn('Schema issues:',repair_prompt)
        self.assertNotIn('PRIVATE MODEL CONTENT',repair_prompt)

    def test_repeated_invalid_plan_has_specific_safe_error(self):
        self.login()
        with patch.dict('os.environ',{'BOB_API_KEY':'test'}),patch.object(oa,'owned_extension',return_value='docx'),patch.object(oa.office_ai,'run_acp',new_callable=AsyncMock,return_value='PRIVATE invalid output') as run:
            with TestClient(self.app) as client: response=client.post(self.url,json=self.body)
        self.assertEqual(run.await_count,2)
        events=[json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]['code'],'invalid_plan')
        self.assertNotIn('PRIVATE',response.text)
        self.assertNotIn('connection',events[-1]['message'])
        self.assertNotIn('alice',oa.office_ai._active)

    def test_workbook_context_and_known_sheet_targets(self):
        context=oa.Context(kind='cell',sheet='Ledger 2026',workbook=[{'name':'Ledger 2026','used_range':'C4:G24000','range':'C4:G5','rows':24000,'columns':7,'values':[['Cost','Booked','Revenue'],[20,46023,50]],'display_values':[['Cost','Booked','Revenue'],['20','01/01/2026','50']],'number_formats':[{'column':'D','format':'dd/mm/yyyy'}],'truncated':True}])
        request=oa.Draft(prompt='Build monthly profit summary',context=context)
        prompt=oa.completion_for(request,'xlsx').messages[0].content
        self.assertIn('Ledger 2026',prompt);self.assertIn('Never assume a sheet named Sheet1',prompt)
        self.assertIn('Do not use truncated samples as if complete totals',prompt)
        plan=oa.Plan(version=1,kind='cell',reply='Review',actions=[oa.SetCells(type='set_cells',sheet='Sheet1',range='A1',values=[[1]])])
        with self.assertRaises(ValueError): oa.validate_context_plan(plan,context)
        plan.actions=[oa.AddSheet(type='add_sheet',name='Summary'),oa.SetCells(type='set_cells',sheet='Summary',range='A1',values=[[1]])]
        oa.validate_context_plan(plan,context)
        with self.assertRaises(ValidationError): oa.Context(kind='cell',workbook=[{'name':'Ledger','used_range':'XFE1'}])

    def test_repair_prompt_and_workbook_trim_stay_bounded(self):
        workbook=[{'name':'Ledger','used_range':'A1:T10000','range':'A1:T40','rows':10000,'columns':20,'truncated':True,'values':[['x'*15]*20 for _ in range(40)],'display_values':[['x'*15]*20 for _ in range(20)]}]
        req=oa.Draft(prompt='x'*12000,context={'kind':'cell','text':'x'*30000,'selection':'y'*12000,'workbook':workbook})
        completion=oa.completion_for(req,'xlsx',reserve=1500)
        self.assertLessEqual(len(completion.messages[0].content)+1500,oa.office_ai.MAX_INPUT)
        self.assertEqual(oa.assistant_error(TimeoutError())[0],'timeout')

    def test_disconnect_cancels_acp(self):
        async def run_test():
            cancelled=asyncio.Event()
            async def slow(*args):
                try: await asyncio.sleep(30)
                finally: cancelled.set()
            request=type('Request',(),{'is_disconnected':AsyncMock(return_value=True)})()
            req=oa.Draft(**self.body);oa.office_ai._active.add('alice')
            with patch.object(oa.office_ai,'run_acp',side_effect=slow):
                stream=oa.draft_events(req,oa.completion_for(req,'docx'),'docx',request,'alice')
                self.assertIn('start',await anext(stream))
                await asyncio.sleep(.01)
                with self.assertRaises(StopAsyncIteration): await anext(stream)
            self.assertTrue(cancelled.is_set());self.assertNotIn('alice',oa.office_ai._active)
        asyncio.run(run_test())
    def test_prompt_bounds_language_and_untrusted_context(self):
        req=oa.Draft(prompt='Generate',ui_language='el',context={'kind':'word','text':'x'*30000,'selection':'y'*12000},history=[{'prompt':'p'*2000,'reply':'r'*3000}]*6)
        completion=oa.completion_for(req,'docx')
        text=completion.messages[0].content
        self.assertLessEqual(len(text),oa.office_ai.MAX_INPUT)
        self.assertIn('Greek',text);self.assertIn('untrusted data',text);self.assertIn('Never claim changes were applied',text)
    def test_concurrency_shared_with_legacy(self):
        self.login();oa.office_ai._active.add('alice')
        with patch.dict('os.environ',{'BOB_API_KEY':'test'}),patch.object(oa,'owned_extension',return_value='docx'):
            with TestClient(self.app) as client: self.assertEqual(client.post(self.url,json=self.body).status_code,429)

    def test_chart_and_autofit_actions(self):
        plan_json = json.dumps({
            'version': 1,
            'kind': 'cell',
            'reply': 'Summary and chart:\n\n```chart\n{"type":"bar","title":"Profit","labels":["A","B"],"datasets":[{"label":"Profit","data":[10,20]}]}\n```',
            'actions': [
                {'type': 'add_sheet', 'name': 'Dashboard'},
                {'type': 'set_cells', 'sheet': 'Dashboard', 'range': 'A1:B3', 'values': [['Region', 'Profit'], ['A', 10], ['B', 20]]},
                {'type': 'format_range', 'sheet': 'Dashboard', 'range': 'A1:B1', 'bold': True, 'fill': '#E8EEF5'},
                {'type': 'add_chart', 'sheet': 'Dashboard', 'range': 'A1:B3', 'chart_type': 'bar', 'title': 'Profit by Region', 'from_col': 3, 'from_row': 1, 'width_mm': 160, 'height_mm': 95},
                {'type': 'autofit_columns', 'sheet': 'Dashboard', 'range': 'A1:B1'},
            ]
        })
        for ext in ('xlsx', 'csv'):
            plan = oa.parse_plan(plan_json, ext)
            self.assertEqual(len(plan.actions), 5)
            self.assertEqual(plan.actions[3].type, 'add_chart')
            context = oa.Context(kind='cell', sheet='Source', workbook=[{'name': 'Source', 'used_range': 'A1:B10', 'rows': 10, 'columns': 2}])
            oa.validate_context_plan(plan, context)

    def test_tokenomics_pruning_and_row_trimming(self):
        rows = [['Region', 'Channel', 'Item Type', 'Priority', 'Order Date', 'Profit']]
        for i in range(100):
            rows.append(['Europe' if i % 2 == 0 else 'Asia', 'Online' if i % 3 == 0 else 'Offline', f'Item{i%5}', 'High', f'2025-{(i%12)+1:02d}-15', 100.0 + i])
        sheet_summary = oa._analyze_row_iterator('Sales', iter(rows))
        raw_analytics = {'file_extension': 'csv', 'full_dataset_analytics': [sheet_summary]}
        pruned_region = oa._prune_analytics_for_prompt(raw_analytics, 'Show profit by region')
        self.assertIn('Region', pruned_region['full_dataset_analytics'][0]['group_breakdowns'])
        self.assertLessEqual(len(pruned_region['full_dataset_analytics'][0]['group_breakdowns']), 3)
        workbook = [{'name': 'Sales', 'used_range': 'A1:F101', 'range': 'A1:F40', 'rows': 101, 'columns': 6, 'truncated': True,
                     'values': rows[:40], 'display_values': [[str(x) for x in r] for r in rows[:40]]}]
        req = oa.Draft(prompt='Show profit by region', context={'kind': 'cell', 'sheet': 'Sales', 'workbook': workbook})
        comp_with_analytics = oa.completion_for(req, 'csv', analytics=pruned_region)
        payload = json.loads(comp_with_analytics.messages[0].content.split('Input data:\n', 1)[1])
        self.assertEqual(payload['analytics']['source'], 'saved_file')
        self.assertIn('may exclude unsaved editor changes', comp_with_analytics.messages[0].content)
        self.assertEqual(len(payload['context']['workbook'][0]['values']), 8)
        self.assertEqual(len(payload['context']['workbook'][0]['display_values']), 8)

    def test_slide_actions_and_plan_validation(self):
        slide_plan_json = json.dumps({
            'version': 1,
            'kind': 'slide',
            'reply': 'Created a 2-slide executive deck.',
            'actions': [
                {'type': 'update_slide', 'slide_index': 1, 'title': 'Q4 Strategy', 'subtitle': 'Executive Overview', 'bullets': ['Revenue +18% YoY', 'New enterprise tier'], 'background': '#F7F4FA', 'notes': 'Welcome remarks'},
                {'type': 'add_slide', 'title': 'Next Steps', 'bullets': ['Finalize Q1 roadmap', 'Align sales targets'], 'notes': 'Closing slide'},
            ]
        })
        plan = oa.parse_plan(slide_plan_json, 'pptx')
        self.assertEqual(plan.kind, 'slide')
        self.assertEqual(len(plan.actions), 2)
        self.assertEqual(plan.actions[0].type, 'update_slide')
        self.assertEqual(plan.actions[1].type, 'add_slide')
        with self.assertRaises(ValueError):
            oa.parse_plan(slide_plan_json, 'docx')
        with self.assertRaises(ValueError):
            oa.parse_plan(slide_plan_json, 'xlsx')

if __name__=='__main__': main()

