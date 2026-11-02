"""Spreadsheet analytics, plan limits and draft streaming with mocked storage and ACP."""
import asyncio
from datetime import date, datetime
import io
import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import openpyxl
from pydantic import ValidationError

from buddy_office import office_assistant as oa

FILE_ID = uuid4()


def row(extension='csv', **changes):
    return {'extension': extension, 'sha256': uuid4().hex, 'object_key': 'k', 'name': f'data.{extension}', **changes}


class FieldLimitTests(TestCase):
    def assertRefused(self, model, fragment, **values):
        with self.assertRaisesRegex(ValidationError, fragment):
            model(**values)

    def test_chart_range_limits(self):
        self.assertEqual(oa.checked_chart_range("'Q1'!A1:B3"), (3, 2))
        for value in ('ZZZ1:A1', 'A9:A1', 'XFE1'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'limits'):
                oa.checked_chart_range(value)

    def test_cell_values(self):
        self.assertRefused(oa.SetCells, 'too long', type='set_cells', range='A1', values=[['x' * 12001]])
        self.assertRefused(oa.SetCells, 'finite', type='set_cells', range='A1', values=[[float('inf')]])

    def test_filter_criteria(self):
        self.assertRefused(oa.FilterRange, 'exceed limits', type='filter_range', range='A1:B2', field=1, criteria='x' * 201)
        self.assertRefused(oa.FilterRange, 'exceed limits', type='filter_range', range='A1:B2', field=1, criteria=['x'] * 51)

    def test_validation_source_is_required(self):
        model = next(value for value in vars(oa).values() if isinstance(value, type) and issubclass(value, oa.BaseModel)
                     and 'set_validation' in str(value.model_fields.get('type')))
        self.assertRefused(model, 'source or limit', type='set_validation', range='A1', rule='custom')

    def test_workbook_sheet_sample_limits(self):
        for values, fragment in (({'range': 'bad'}, 'Invalid workbook range'), ({'values': [['x' * 257]]}, 'too long'),
                                 ({'values': [[float('nan')]]}, 'finite')):
            with self.subTest(fragment=fragment):
                self.assertRefused(oa.WorkbookSheet, fragment, name='S', **values)

    def test_context_size_limits(self):
        pages = [{'page': 1, 'objects': [{'object_index': i + 1, 'text': 'x' * 1000} for i in range(100)]}]
        self.assertRefused(oa.Context, 'PDF context', kind='pdf', pages=pages)
        sheet = {'name': 'S', 'values': [['x' * 250] * 20] * 7}
        self.assertRefused(oa.Context, 'Workbook sample', kind='cell', workbook=[sheet])
        self.assertRefused(oa.Context, 'Select fewer', kind='cell', values=[['x' * 1000] * 20])

    def test_blank_prompt_is_refused(self):
        self.assertRefused(oa.Draft, 'Enter a request', prompt='   ', context={'kind': 'word'})

    def test_plan_block_and_text_limits(self):
        def plan(blocks):
            return {'version': 1, 'kind': 'word', 'reply': 'ok', 'actions': [{'type': 'insert_blocks', 'position': 'end', 'blocks': blocks}]}
        heading = {'type': 'heading', 'text': 'x' * 400, 'level': 1}
        models = [value for value in vars(oa).values() if isinstance(value, type) and issubclass(value, oa.BaseModel)
                  and {'version', 'actions'} <= set(value.model_fields)]
        with self.assertRaises(ValidationError):
            models[0].model_validate(plan([heading] * 200))


class ParsingHelperTests(TestCase):
    def test_try_float(self):
        for value, expected in ((True, None), (None, None), (3, 3.0), (float('inf'), None), ('  ', None), ('12%', 12.0),
                                ('x%', None), ('$1,200.5', 1200.5), ('abc', None), ('inf', None), ([], None), ('inf%', None)):
            with self.subTest(value=value):
                self.assertEqual(oa._try_float(value), expected)

    def test_try_year_month(self):
        cases = ((datetime(2024, 3, 1), ('2024', '2024-03')), (date(1999, 12, 31), ('1999', '1999-12')),
                 ('2024-02-01', ('2024', '2024-02')), ('13/02/2020', ('2020', '2020-02')), ('', None), ('x' * 33, None),
                 ('2024-13-01', None), ('1800-01-01', None), ('13/13/2020', None), ('01/01/1800', None), ('nope', None), (5, None))
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(oa._try_year_month(value), expected)

    def test_partial_reply_decodes_only_complete_tokens(self):
        for raw, expected in (('{"x":1}', ''), ('{"reply":"hi', 'hi'), ('{"reply":"a\\', 'a'), ('{"reply":"\\u00e', ''),
                              ('{"reply":"ok","x"', 'ok'), ('{"reply":"\\q"', '')):
            with self.subTest(raw=raw):
                self.assertEqual(oa.partial_reply(raw), expected)

    def test_extract_json_object_keeps_unterminated_fence(self):
        self.assertEqual(oa._extract_json_object('```json\n{"a":1}\n```'), '{"a":1}')
        self.assertEqual(oa._extract_json_object('```json\n{"a":1}'), '```json\n{"a":1}')

    def test_parse_plan_size_limit(self):
        with self.assertRaisesRegex(ValueError, 'too large'):
            oa.parse_plan('x' * 250001, 'docx')


class AnalyzerTests(TestCase):
    def analyze(self, rows, **kwargs):
        return oa._analyze_row_iterator('S', iter(rows), **kwargs)

    def test_empty_shapes(self):
        self.assertEqual(self.analyze([])['total_rows'], 0)
        self.assertEqual(self.analyze([[None, ''], []])['columns'], [])
        self.assertEqual(self.analyze([['Only']])['columns'], ['Only'])

    def test_trailing_blank_headers_are_dropped(self):
        result = self.analyze([['A', None, ''], ['1', 'x', 'y']])
        self.assertEqual([column['header'] for column in result['columns']], ['A'])

    def test_numeric_identifiers_used_only_when_no_other_measure(self):
        result = self.analyze([['id', 'Region'], [1, 'N'], [2, 'S'], [3, 'S']])
        self.assertEqual(result['group_breakdowns']['Region']['S']['id'], 5.0)

    def test_offset_table_and_short_rows(self):
        result = self.analyze([[], [None, 'Group', 'Value'], [None, 'a', 5], [], [None, 'b'], [None, '', '']],
                              default_start_col=1, default_start_row=3)
        self.assertEqual(result['header_row'], 4)
        self.assertEqual(result['used_range'][:2], 'C4')
        self.assertEqual(result['total_data_rows'], 3)

    def test_date_column_aggregates_years_months_and_invalid_values(self):
        rows = [['When', 'Amount', 'Kind']]
        rows += [[f'2024-0{i % 3 + 1}-01', 10, 'a' if i % 2 else 'b'] for i in range(9)]
        rows += [['not a date', 7, 'a'], ['', 3, 'b']]
        result = self.analyze(rows)
        kinds = {column['header']: column for column in result['columns']}
        self.assertEqual(kinds['When']['type'], 'date')
        self.assertEqual(kinds['When']['years_count'], {'2024': 9})
        self.assertEqual(result['time_series']['When (by Year)']['2024']['Amount'], 90)
        self.assertEqual(len(result['time_series']['When (by Month)']), 3)
        self.assertEqual(kinds['Kind']['top_values']['a'], 5)

    def test_unparseable_value_in_numeric_column_is_not_counted(self):
        result = self.analyze([['V'], [1], [2], [3], [4], ['bad']])
        self.assertEqual(result['columns'][0]['count'], 4)
        self.assertEqual(result['columns'][0]['max'], 4.0)

    def test_category_and_group_cardinality_is_bounded(self):
        rows = [['Name', 'Value']] + [[f'n{i}', 1] for i in range(300)] + [['n0', 1], [None, 1]]
        result = self.analyze(rows)
        name = result['columns'][0]
        self.assertEqual(name['unique_sampled'], 250)
        self.assertNotIn('Name', result['group_breakdowns'])

    def test_row_limit_stops_the_stream(self):
        def rows():
            yield ['V']
            while True:
                yield [1]
        self.assertEqual(oa._analyze_row_iterator('S', rows())['total_data_rows'], 250000)

    def test_month_cardinality_is_bounded(self):
        rows = [['When', 'V']] + [[f'{1900 + y}-{m:02d}-01', 1] for y in range(25) for m in range(1, 13)]
        result = self.analyze(rows)
        self.assertNotIn('When (by Month)', result['time_series'])
        self.assertEqual(len(result['time_series']['When (by Year)']), 25)


class PruningTests(TestCase):
    def analytics(self, breakdowns):
        return {'full_dataset_analytics': [{'columns': [], 'group_breakdowns': {name: {} for name in breakdowns},
                                            'time_series': {'Y': {}, 'M': {}}}]}

    def test_unmatched_breakdowns_keep_first_two_and_primary_series(self):
        sheet = oa._prune_analytics_for_prompt(self.analytics(['a1', 'b1', 'c1']), 'tell me more')['full_dataset_analytics'][0]
        self.assertEqual(list(sheet['group_breakdowns']), ['a1', 'b1'])
        self.assertEqual(list(sheet['time_series']), ['Y'])

    def test_time_question_keeps_all_series(self):
        sheet = oa._prune_analytics_for_prompt(self.analytics(['Region']), 'monthly trend')['full_dataset_analytics'][0]
        self.assertEqual(list(sheet['time_series']), ['Y', 'M'])


class ComputeAnalyticsTests(TestCase):
    def setUp(self):
        oa._analytics_cache.clear()
        self.addCleanup(oa._analytics_cache.clear)
        self.db = MagicMock()
        self.db.execute.return_value.fetchone.return_value = None
        self.office = self.enterContext(patch.object(oa, 'office'))
        self.office.job_queue._connect.return_value.__enter__.return_value = self.db
        self.enterContext(patch.object(oa, '_analytics_schema_ready', True))

    def compute(self, **kwargs):
        return oa.compute_spreadsheet_analytics(FILE_ID, 'alice', **kwargs)

    def test_unsniffable_csv_falls_back_to_comma(self):
        self.office._file.return_value = row()
        self.office.read.return_value = b'alpha\nbeta\ngamma\n'
        with patch.object(oa.csv.Sniffer, 'sniff', side_effect=oa.csv.Error):
            result = self.compute()
        self.assertEqual(result['full_dataset_analytics'][0]['columns'][0]['header'], 'alpha')

    def test_cache_eviction_keeps_size_bound(self):
        oa._analytics_cache.update({str(i): {'full_dataset_analytics': []} for i in range(64)})
        self.office._file.return_value = row()
        self.office.read.return_value = b'a,b\n1,2\n'
        self.assertIsNotNone(self.compute())
        self.assertEqual(len(oa._analytics_cache), 64)
        self.assertNotIn('0', oa._analytics_cache)

    def test_cache_write_failure_does_not_lose_result(self):
        self.office._file.return_value = row()
        self.office.read.return_value = b'a,b\n1,2\n'
        connect = self.office.job_queue._connect
        connect.side_effect = [connect.return_value, RuntimeError('db gone')]
        self.assertEqual(self.compute()['file_extension'], 'csv')

    def test_failure_returns_none_and_logs_type_only(self):
        self.office._file.side_effect = RuntimeError('private detail')
        with self.assertLogs(oa.logger, 'WARNING') as logs:
            self.assertIsNone(self.compute())
        self.assertNotIn('private detail', ''.join(logs.output))

    def test_large_preview_uses_saved_xlsx(self):
        book = openpyxl.Workbook()
        book.active.append(['Region', 'Sales'])
        book.active.append(['N', 2])
        stream = io.BytesIO()
        book.save(stream)
        self.office._file.return_value = row('xlsx')
        self.office.read.return_value = stream.getvalue()
        context = oa.Context(kind='cell', workbook=[{'name': 'S', 'truncated': True, 'rows': 50, 'values': [['a']]}])
        self.assertEqual(self.compute(context=context)['file_extension'], 'xlsx')

    def test_schema_initialiser_runs_once(self):
        db = MagicMock()
        with patch.object(oa, '_analytics_schema_ready', False):
            oa._ensure_analytics_cache_schema(db)
            oa._ensure_analytics_cache_schema(db)
        db.execute.assert_called_once()


class CompletionTrimTests(TestCase):
    def draft(self, **context):
        return oa.Draft(prompt='Summarise', context={'kind': 'cell', **context})

    def trim(self, request, limit, **kwargs):
        with patch.object(oa.office_ai, 'MAX_INPUT', limit):
            return oa.completion_for(request, 'xlsx', **kwargs).messages[0].content

    def base(self, request):
        return len(oa.completion_for(request, 'xlsx').messages[0].content)

    def test_selection_values_are_trimmed_before_giving_up(self):
        request = self.draft(values=[['v' * 10]] * 40)
        content = self.trim(request, self.base(self.draft()) + 600)
        self.assertIn('"truncated": true', content)
        self.assertLess(content.count('vvvvvvvvvv'), 40)

    def test_impossible_request_is_refused(self):
        with self.assertRaises(HTTPException) as failure:
            self.trim(self.draft(), 10)
        self.assertEqual(failure.exception.status_code, 422)

    def test_analytics_sections_are_dropped_progressively(self):
        request = self.draft()
        analytics = {'full_dataset_analytics': [{'time_series': {'a': 'y' * 500}, 'group_breakdowns': {'b': 'z' * 500}}]}
        base = self.base(request)
        content = self.trim(request, base + 800, analytics=json.loads(json.dumps(analytics)))
        self.assertNotIn('yyy', content)
        self.assertIn('zzz', content)
        content = self.trim(request, base + 150, analytics=json.loads(json.dumps(analytics)))
        self.assertNotIn('zzz', content)
        self.assertNotIn('full_dataset_analytics', content)

    def test_charts_shapes_and_nodes_are_dropped_last_unselected_first(self):
        data = self.draft().model_dump()
        data['context']['charts'] = [{'selected': False, 'title': 'c' * 400}, {'selected': True, 'title': 'd' * 400}]
        data['context']['slide_shapes'] = [{'selected': False, 'text': 'e' * 400}, {'selected': True, 'text': 'f' * 400}]
        data['context']['html_nodes'] = [{'text': 'g' * 400}]
        data['context']['selection'] = 'h' * 2100
        fake = SimpleNamespace(ui_language='en', model_dump=lambda: json.loads(json.dumps(data)))
        total = len(self.trim(fake, 10 ** 7))
        for removed, kept, reduction in (('c', 'd', 200), ('d', 'e', 600), ('e', 'f', 1000), ('f', 'g', 1500), ('g', 'h', 1900)):
            with self.subTest(removed=removed):
                content = self.trim(fake, total - reduction)
                self.assertNotIn(removed * 40, content)
                self.assertIn(kept * 40, content)


class ScopeTests(TestCase):
    PLAN_KIND = {'cell': 'xlsx'}

    def plan(self, actions, kind='cell'):
        return SimpleNamespace(kind=kind, actions=actions)

    def request(self, **context):
        return SimpleNamespace(context_mode='selection', context=oa.Context(kind=context.pop('kind', 'cell'), **context))

    def test_chart_edit_must_target_selected_chart(self):
        action = SimpleNamespace(type='edit_chart', chart_index=1, sheet='S', slide_index=None)
        with self.assertRaisesRegex(ValueError, 'selected chart'):
            oa.validate_selection_scope(self.plan([action]), self.request(range='A1'))

    def test_range_edit_must_stay_on_sheet(self):
        foreign = SimpleNamespace(type='set_cells', range='A1', sheet='Other')
        with self.assertRaisesRegex(ValueError, 'selected worksheet'):
            oa.validate_selection_scope(self.plan([foreign]), self.request(range='A1:B2', sheet='S'))
        rangeless = SimpleNamespace(type='add_sheet', sheet=None)
        with self.assertRaisesRegex(ValueError, 'selected worksheet'):
            oa.validate_selection_scope(self.plan([rangeless]), self.request(range='A1:B2', sheet='S'))

    def test_empty_plan_without_range_is_allowed(self):
        self.assertIsNone(oa.validate_selection_scope(self.plan([]), self.request()))

    def test_other_kinds_have_no_cell_scope(self):
        self.assertIsNone(oa.validate_selection_scope(self.plan([], 'word'), self.request(kind='word')))

    def test_sheet_names_include_context_lists(self):
        action = SimpleNamespace(type='set_cells', sheet='Listed')
        context = oa.Context(kind='cell', sheet='Active', sheets=['Listed'], workbook=[{'name': 'S'}])
        self.assertIsNone(oa.validate_context_plan(self.plan([action]), context))


PLAN = json.dumps({'version': 1, 'kind': 'word', 'reply': 'Prepared', 'actions': []})


class Disconnect:
    def __init__(self, *answers):
        self.answers = list(answers)

    async def is_disconnected(self):
        return self.answers.pop(0) if self.answers else False


class DraftEventTests(TestCase):
    def setUp(self):
        oa.office_ai._active.clear()
        self.addCleanup(oa.office_ai._active.clear)
        self.request = oa.Draft(prompt='Write', context={'kind': 'word'})

    def events(self, run, request=None):
        async def collect():
            completion = oa.completion_for(self.request, 'docx')
            return [json.loads(item) async for item in oa.draft_events(self.request, completion, 'docx', request or Disconnect(), 'alice')]
        with patch.object(oa.office_ai, 'run_acp', run):
            return asyncio.run(collect())

    def test_oversized_stream_is_reported_as_error(self):
        async def run(completion, language, on_text):
            await on_text('x' * 250001)
            return ''
        kinds = self.events(run)
        self.assertEqual(kinds[-1]['type'], 'error')

    def test_disconnect_stops_without_terminal_event(self):
        async def run(completion, language, on_text):
            await asyncio.sleep(0.01)
            return PLAN
        kinds = self.events(run, Disconnect(True))
        self.assertEqual([item['type'] for item in kinds], ['start'])

    def test_status_is_sent_while_waiting(self):
        async def run(completion, language, on_text):
            await asyncio.sleep(0.6)
            return PLAN
        kinds = self.events(run)
        self.assertIn('Buddy is preparing your draft', [item.get('message') for item in kinds])
        self.assertEqual(kinds[-1]['type'], 'done')


class RouteTests(TestCase):
    def setUp(self):
        oa.office_ai._active.clear()
        self.addCleanup(oa.office_ai._active.clear)
        app = FastAPI()
        app.include_router(oa.router)
        app.dependency_overrides[oa.current_user] = lambda: {'username': 'alice'}
        self.client = self.enterContext(TestClient(app))
        self.extension = self.enterContext(patch.object(oa, 'owned_extension', return_value='docx'))
        self.url = f'/api/office/assistant/files/{FILE_ID}'

    def draft(self, kind='word'):
        return self.client.post(self.url + '/draft', json={'prompt': 'Write', 'context': {'kind': kind}})

    def test_unsupported_extension_and_kind_mismatch(self):
        self.assertEqual(self.draft('cell').status_code, 422)
        self.extension.return_value = 'exe'
        self.assertEqual(self.draft().status_code, 422)

    def test_missing_acp_configuration_is_unavailable(self):
        with patch.dict('os.environ', {'BOB_API_KEY': '', 'BOBSHELL_API_KEY': ''}):
            self.assertEqual(self.draft().status_code, 503)

    def test_spreadsheet_document_mode_loads_analytics(self):
        self.extension.return_value = 'xlsx'
        with patch.dict('os.environ', {'BOB_API_KEY': 'synthetic'}), \
                patch.object(oa, 'compute_spreadsheet_analytics', return_value=None) as analytics, \
                patch.object(oa, 'draft_events', return_value=iter(['{"type":"done"}\n'])):
            response = self.client.post(self.url + '/draft', json={'prompt': 'Sum', 'context': {'kind': 'cell', 'values': [[1]]}})
        self.assertEqual(response.status_code, 200)
        analytics.assert_called_once()

    def test_convert_route_delegates(self):
        with patch.object(oa, 'convert_csv_to_xlsx_file', return_value={'id': 'new'}) as convert:
            self.assertEqual(self.client.post(self.url + '/convert-to-xlsx').json(), {'id': 'new'})
        self.assertEqual(convert.call_args.args[1], 'alice')


class ConvertTests(TestCase):
    def setUp(self):
        self.office = self.enterContext(patch.object(oa, 'office'))
        self.office.job_queue._connect.return_value.__enter__.return_value = MagicMock()
        self.office.store_new.side_effect = lambda user, name, payload: {'name': name, 'payload': payload}

    def test_only_csv_converts(self):
        self.office._file.return_value = row('xlsx')
        with self.assertRaises(HTTPException) as failure:
            oa.convert_csv_to_xlsx_file(FILE_ID, 'alice')
        self.assertEqual(failure.exception.status_code, 422)

    def test_numbers_become_numeric_and_leading_zero_text_is_kept(self):
        self.office._file.return_value = row(name='data.csv')
        self.office.read.return_value = b'a,b,c\n1,2.5,007\n,x,-3\n'
        with patch.object(oa.csv.Sniffer, 'sniff', side_effect=oa.csv.Error):
            result = oa.convert_csv_to_xlsx_file(FILE_ID, 'alice')
        self.assertEqual(result['name'], 'data.xlsx')
        values = list(openpyxl.load_workbook(io.BytesIO(result['payload'])).active.values)
        self.assertEqual(values[1], (1, 2.5, '007'))
        self.assertEqual(values[2], (None, 'x', -3))
