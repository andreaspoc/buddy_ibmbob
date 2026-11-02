"""Synthetic spreadsheet interchange and prose-rule regression cases."""
from io import BytesIO
import unittest
try:
    from openpyxl import Workbook
except ImportError:
    Workbook = None
from app.decisions_buddy.scenario_workbook import import_workbook, workbook_template
from app.decisions_buddy.bal_engine import evaluate_bal_rule


def workbook_bytes(rows):
    workbook = Workbook()
    workbook.active.title = 'Scenarios'
    for row in rows:
        workbook.active.append(row)
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


@unittest.skipIf(Workbook is None, 'openpyxl is not installed in this test environment')
class WorkbookTests(unittest.TestCase):
    def test_template_and_nested_typed_cases(self):
        self.assertEqual(len(import_workbook(workbook_template())), 1)
        cases = import_workbook(workbook_bytes([
            ['name', 'input', 'expected'],
            ['Boundary', '{"customer":{"age":18}}', '{"approved":true,"notes":["ok"]}'],
            ['Null result', '{}', 'null'],
        ]))
        self.assertEqual(cases[0]['input']['customer']['age'], 18)
        self.assertIs(cases[0]['expected']['approved'], True)
        self.assertIsNone(cases[1]['expected'])

    def test_reject_bad_headers_missing_expectations_formulas_and_invalid_json(self):
        rows = [
            [['id', 'input', 'expected'], ['A', '{}', '{}']],
            [['name', 'input', 'expected'], ['A', '{}', None]],
            [['name', 'input', 'expected'], ['A', '=1+1', '{}']],
            [['name', 'input', 'expected'], ['A', '[]', '{}']],
            [['name', 'input', 'expected'], ['A', '{}', 'NaN']],
            [['name', 'input', 'expected']],
        ]
        for data in rows:
            with self.subTest(data=data), self.assertRaises(ValueError):
                import_workbook(workbook_bytes(data))
        with self.assertRaises(ValueError):
            import_workbook(b'not a workbook')

    def test_case_and_archive_size_limits(self):
        with self.assertRaises(ValueError):
            import_workbook(workbook_bytes([['name', 'input', 'expected']] + [['case', '{}', '{}']] * 101))
        with self.assertRaises(ValueError):
            import_workbook(b'x' * (1024 * 1024 + 1))
        from zipfile import ZipFile, ZIP_DEFLATED
        output = BytesIO()
        with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('large.xml', b'x' * (8 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, 'expanded size'):
            import_workbook(output.getvalue())


class ProseRuleTests(unittest.TestCase):
    def test_membership_and_quoted_keywords_are_preserved(self):
        context = {'country': 'CY'}
        result = evaluate_bal_rule('if country is one of ["CY", "GR"] then set note to "this is then; else if";', context)
        self.assertTrue(result['passed'])
        self.assertEqual(context['note'], 'this is then; else if')
        evaluate_bal_rule('if country is not in ["US"] then set approved to true;', context)
        self.assertTrue(context['approved'])

    def test_definitions_are_local_and_failed_actions_are_atomic(self):
        context = {'customer': {'age': 18}}
        evaluate_bal_rule('definitions set customer.age to 99; if customer.age > 20 then set approved to true;', context)
        self.assertEqual(context, {'customer': {'age': 18}, 'approved': True})
        with self.assertRaises(ValueError):
            evaluate_bal_rule('then set customer.age to 50; set approved to unknown;', context)
        self.assertEqual(context['customer']['age'], 18)

    def test_escaped_quotes_and_malformed_sections(self):
        context = {}
        evaluate_bal_rule('then set note to "say \\"then\\"; this is fine";', context)
        self.assertEqual(context['note'], 'say "then"; this is fine')
        for rule in ('if true then', 'if true then set x to 1; else', 'garbage then set x to 1;'):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                evaluate_bal_rule(rule, {})
