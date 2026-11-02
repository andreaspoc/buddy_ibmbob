"""Invoice prompts and edit plans use the existing reviewed Office pipeline."""
import json
import unittest
from app import office_assistant as assistant


class OfficeInvoiceTests(unittest.TestCase):
    def test_invoice_guidance_is_present_and_history_is_available(self):
        request = assistant.Draft(prompt='Create the invoice now', context={'kind': 'word'},
            history=[{'prompt': 'Use EUR and the supplied customer details', 'reply': 'Please provide line items.', 'state': 'discarded'}])
        prompt = assistant.completion_for(request, 'docx').messages[0].content
        self.assertIn('Invoice assistance:', prompt)
        self.assertIn('A missing tax rate does not mean zero tax', prompt)
        self.assertIn('return actions:[]', prompt)
        self.assertIn('Use EUR and the supplied customer details', prompt)
        self.assertIn('changes remain a proposal until the user applies them', prompt)

    def test_follow_up_replacement_overrides_additive_invoice_default(self):
        request = assistant.Draft(prompt='Replace the invoice template you created with a simpler version',
            context={'kind': 'word', 'text': 'Existing invoice template. Customer: [Customer name]'},
            history=[{'prompt': 'Create an invoice template', 'reply': 'Draft ready.', 'state': 'applied'}])
        prompt = assistant.completion_for(request, 'docx').messages[0].content
        self.assertIn('Word edit intent takes priority', prompt)
        self.assertIn('do not append a second artifact', prompt)
        self.assertIn('replace only part of the document must preserve unrelated content', prompt)
        self.assertIn('Replace the invoice template you created', prompt)

    def test_word_invoice_table_is_a_supported_reviewed_plan(self):
        plan = assistant.parse_plan(json.dumps({'version': 1, 'kind': 'word',
            'reply': 'Synthetic invoice draft ready for review.', 'actions': [{'type': 'insert_blocks', 'position': 'end', 'blocks': [
                {'type': 'title', 'text': 'Invoice template'},
                {'type': 'paragraph', 'text': 'Seller: [Seller name] · Customer: [Customer name]'},
                {'type': 'table', 'rows': [['Description', 'Quantity', 'Unit price', 'Total'], ['Synthetic supplied service', '2', 'EUR 25.00', 'EUR 50.00']]},
            ]}]}), 'docx')
        self.assertEqual(plan.actions[0].position, 'end')
        self.assertEqual(plan.actions[0].blocks[2].rows[1][-1], 'EUR 50.00')

    def test_invoice_spreadsheet_accepts_bounded_working_formulas(self):
        plan = assistant.parse_plan(json.dumps({'version': 1, 'kind': 'cell',
            'reply': 'Synthetic invoice worksheet proposal.', 'actions': [{'type': 'set_cells', 'range': 'A1:D3', 'values': [
                ['Description', 'Quantity', 'Unit price', 'Line total'],
                ['Synthetic supplied service', 2, 25, '=B2*C2'],
                ['Subtotal', None, None, '=SUM(D2:D2)'],
            ]}]}), 'xlsx')
        self.assertEqual(plan.actions[0].values[1][3], '=B2*C2')


if __name__ == '__main__':
    unittest.main()
