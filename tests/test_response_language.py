import ast
from pathlib import Path
import unittest

from pydantic import BaseModel, Field, ValidationError
from app.response_language import language_instruction


class ResponseLanguageTests(unittest.TestCase):
    def test_greek_applies_to_reports_and_user_requests_override(self):
        rule = language_instruction('el')
        self.assertIn('responses in Greek', rule)
        self.assertIn('research reports, report headings', rule)
        self.assertIn('explicitly asks for a different output language', rule)
        self.assertIn('over conflicting saved language preferences', rule)

    def test_english_selection_controls_response_language(self):
        rule = language_instruction('en')
        self.assertIn('responses in English', rule)
        self.assertIn('explicitly asks for a different output language', rule)
        self.assertNotIn('responses in Greek', rule)

    def test_hindi_is_default_but_explicit_language_requests_override(self):
        rule = language_instruction('hi')
        self.assertIn('responses in Hindi', rule)
        self.assertIn('Devanagari script', rule)
        self.assertIn('research reports, report headings', rule)
        self.assertIn('explicitly asks for a different output language', rule)
        self.assertIn('over conflicting saved language preferences', rule)

    def test_maltese_response_language(self):
        rule = language_instruction('mt')
        self.assertIn('responses in Maltese', rule)
        self.assertIn('presentation text', rule)
        self.assertIn('explicitly asks for a different output language', rule)

    def test_request_models_validate_and_default_language(self):
        for path, name in [('app/main.py', 'StreamRequest'), ('app/workflows.py', 'WorkflowSpec'), ('app/research.py', 'ResearchSpec')]:
            with self.subTest(model=name):
                tree = ast.parse(Path(path).read_text())
                node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
                field = next(node for node in node.body if isinstance(node, ast.AnnAssign) and node.target.id == 'ui_language')
                model = ast.ClassDef(name='LanguageRequest', bases=[ast.Name(id='BaseModel', ctx=ast.Load())], keywords=[], body=[field], decorator_list=[])
                namespace = {'BaseModel': BaseModel, 'Field': Field}
                exec(compile(ast.fix_missing_locations(ast.Module(body=[model], type_ignores=[])), path, 'exec'), namespace)
                request = namespace['LanguageRequest']
                self.assertEqual(request().ui_language, 'en')
                self.assertEqual(request(ui_language='el').ui_language, 'el')
                self.assertEqual(request(ui_language='hi').ui_language, 'hi')
                self.assertEqual(request(ui_language='mt').ui_language, 'mt')
                with self.assertRaises(ValidationError):
                    request(ui_language='unsupported')

    def test_office_reference_ids_are_bounded_validated_and_hashable(self):
        import uuid
        from app.chat_submission import fingerprint
        tree = ast.parse(Path('app/main.py').read_text())
        model = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'StreamRequest')
        field = next(node for node in model.body if isinstance(node, ast.AnnAssign) and node.target.id == 'office_file_ids')
        schema = ast.ClassDef(name='OfficeReferences', bases=[ast.Name(id='BaseModel', ctx=ast.Load())], keywords=[], body=[field], decorator_list=[])
        namespace = {'BaseModel': BaseModel, 'Field': Field, 'uuid': uuid}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[schema], type_ignores=[])), 'app/main.py', 'exec'), namespace)
        request = namespace['OfficeReferences']
        self.assertEqual(request().office_file_ids, [])
        valid = str(uuid.uuid4())
        self.assertEqual(str(request(office_file_ids=[valid]).office_file_ids[0]), valid)
        self.assertIsInstance(fingerprint(request(office_file_ids=[valid]).model_dump(mode='json')), str)
        for ids in [['bad-id'], [valid] * 4]:
            with self.assertRaises(ValidationError): request(office_file_ids=ids)


if __name__ == '__main__':
    unittest.main()
