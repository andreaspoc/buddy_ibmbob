"""Real PDF widget creation and identity-bound chat dispatch checks."""
import io
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
from pydantic import ValidationError
from pypdf import PdfReader, PdfWriter
from app.office_forms import FormSpec
from app import office_actions as actions
from buddy_office.office_forms import render_form


def spec(**overrides):
    return FormSpec.model_validate({'name': 'Leave request', 'title': 'Leave request',
        'description': 'Complete the fields below.', 'fields': [
            {'name': 'employee', 'label': 'Employee name', 'required': True},
            {'name': 'start', 'label': 'Start date', 'type': 'date'},
            {'name': 'email', 'label': 'Email', 'type': 'email'},
            {'name': 'reason', 'label': 'Reason', 'type': 'textarea'},
            {'name': 'approved', 'label': 'Approval', 'type': 'checkbox'},
            {'name': 'category', 'label': 'Leave type', 'type': 'dropdown', 'options': ['Annual', 'Other']},
        ], **overrides})


class FormTests(unittest.TestCase):
    def test_actual_widgets_and_roundtrip_values(self):
        reader = PdfReader(io.BytesIO(render_form(spec())))
        fields = reader.get_fields()
        self.assertEqual(len(fields), 6)
        self.assertEqual(fields['employee']['/FT'], '/Tx')
        self.assertEqual(fields['employee']['/Ff'] & 2, 2)
        self.assertEqual(fields['reason']['/Ff'] & 4096, 4096)
        self.assertEqual(fields['approved']['/FT'], '/Btn')
        self.assertEqual(fields['category']['/FT'], '/Ch')
        self.assertEqual(fields['category']['/Opt'], ['', 'Annual', 'Other'])
        self.assertIn('Leave request', reader.pages[0].extract_text())
        writer = PdfWriter(clone_from=reader)
        writer.update_page_form_field_values(writer.pages[0], {'employee': 'Test Person', 'approved': '/Yes', 'category': 'Other'}, auto_regenerate=False)
        output = io.BytesIO()
        writer.write(output)
        saved = PdfReader(io.BytesIO(output.getvalue())).get_fields()
        self.assertEqual(saved['employee']['/V'], 'Test Person')
        self.assertEqual(saved['approved']['/V'], '/Yes')
        self.assertEqual(saved['category']['/V'], 'Other')

    def test_pagination_keeps_all_widgets_on_page(self):
        reader = PdfReader(io.BytesIO(render_form(spec(fields=[{'name': f'f{i}', 'label': f'Field {i}', 'type': 'textarea'} for i in range(30)]))))
        self.assertGreater(len(reader.pages), 1)
        self.assertEqual(len(reader.get_fields()), 30)
        for page in reader.pages:
            for ref in page['/Annots']:
                rect = ref.get_object()['/Rect']
                self.assertGreaterEqual(rect[1], 44)
                self.assertLessEqual(rect[3], 842)

    def test_invalid_specs_are_rejected(self):
        for fields in [[], [{'name': 'same', 'label': 'One'}, {'name': 'same', 'label': 'Two'}],
                       [{'name': 'choice', 'label': 'Choice', 'type': 'dropdown'}],
                       [{'name': 'value', 'label': 'Value', 'options': ['unexpected']}]]:
            with self.assertRaises(ValidationError):
                spec(fields=fields)

    def test_service_stores_pdf_for_authenticated_owner(self):
        from buddy_office import office, office_app_actions as endpoint
        fid, folder = uuid4(), uuid4()
        request = spec(folder_id=folder)
        with patch.object(office, 'store_new', return_value={'id': fid, 'name': 'Leave request.pdf'}) as store:
            result = endpoint._execute('alice', 'create_form', request.model_dump(mode='json'), db='transaction')
        self.assertEqual(store.call_args.args[0:2], ('alice', 'Leave request.pdf'))
        self.assertEqual(store.call_args.args[3], folder)
        self.assertEqual(store.call_args.kwargs['db'], 'transaction')
        self.assertEqual(len(PdfReader(io.BytesIO(store.call_args.args[2])).get_fields()), 6)
        self.assertEqual(result['field_count'], 6)


class FormDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_requires_turn_and_emits_open_after_success(self):
        from app import office_action_client as transport
        emit = AsyncMock()
        context = {'username': 'alice', 'workspace_id': 'workspace', 'assistant_message_id': 'reply', 'emit': emit}
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}), patch.object(transport, 'office_request', new=AsyncMock(return_value={'id': 'file', 'name': 'Leave request.pdf'})) as request:
            with self.assertRaises(PermissionError):
                await actions.dispatch('alice', 'office_create_form', spec().model_dump(mode='json'), {})
            result = await actions.dispatch('alice', 'office_create_form', spec().model_dump(mode='json'), context)
        self.assertTrue(result['saved'])
        self.assertEqual(request.call_args.args[:2], ('alice', 'create_form'))
        self.assertEqual(len(request.call_args.args[2]['action_key']), 64)
        self.assertNotIn('action_index', request.call_args.args[2])
        self.assertEqual(emit.await_args_list[-1].args[0]['action'], 'office_open')

    async def test_capability_discovery_reports_actual_operations(self):
        with patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED': '1'}):
            result = await actions.dispatch('alice', 'office_capabilities', {}, {})
        self.assertIn('office_create_form', {tool['name'] for tool in result['tools']})
        self.assertIn('pdf_rotate_page', result['pdf_editor']['operations'])


class SidebarFormTests(unittest.IsolatedAsyncioTestCase):
    def test_plan_proposes_form_without_editor_actions(self):
        from buddy_office.office_assistant import Plan, plan_schema_for
        plan = Plan(version=1, kind='pdf', reply='Review the new form.', actions=[], create_form=spec())
        self.assertEqual(len(plan.create_form.fields), 6)
        self.assertIn('FormSpec', plan_schema_for('pdf')['$defs'])
        with self.assertRaises(ValidationError):
            Plan(version=1, kind='pdf', reply='Conflicting edits', actions=[{'type':'pdf_rotate_page','page':1,'angle':90}], create_form=spec())

    async def test_reviewed_creation_checks_access_and_uses_stable_key(self):
        from buddy_office import office_assistant as assistant, office_app_actions as endpoint
        request = assistant.ReviewedForm(**spec().model_dump(), request_id=uuid4())
        file_id = uuid4()
        with patch.object(assistant, 'owned_extension', return_value='pdf') as access, patch.object(endpoint, 'execute', return_value={'id':'new'}) as create:
            result = await assistant.create_reviewed_form(file_id, request, {'username':'alice'})
            access.assert_called_once_with(file_id, 'alice')
            first_key = create.call_args.args[2]['action_key']
            await assistant.create_reviewed_form(file_id, request, {'username':'alice'})
            self.assertEqual(first_key, create.call_args.args[2]['action_key'])
            self.assertEqual(result['id'], 'new')
        with patch.object(assistant, 'owned_extension', side_effect=PermissionError), patch.object(endpoint, 'execute') as create:
            with self.assertRaises(PermissionError):
                await assistant.create_reviewed_form(file_id, request, {'username':'alice'})
            create.assert_not_called()

    def test_isolation_failure_is_not_reported_as_connection_failure(self):
        from buddy_office.office_assistant import assistant_error
        code, message = assistant_error(RuntimeError('Agent isolation unavailable: install bubblewrap'))
        self.assertEqual(code, 'isolation_unavailable')
        self.assertIn('namespace', message)
