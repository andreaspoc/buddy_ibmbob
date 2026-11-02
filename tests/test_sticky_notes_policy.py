import unittest

from app.sticky_notes import add_sticky_notes_policy


class StickyNotesPolicyTests(unittest.TestCase):
    def test_external_source_is_not_permission_to_publish(self):
        policy = add_sticky_notes_policy('create me a note about Docmost')
        for requirement in ('private note in this application', 'SOURCE',
                            'does not authorize creating a Docmost page',
                            'External writes require an explicit request',
                            'no I need note here', 'does not schedule a reminder'):
            self.assertIn(requirement, policy)

    def test_preserves_prompt_and_documents_response_contract(self):
        prompt = add_sticky_notes_policy('Original user context')
        self.assertTrue(prompt.startswith('Original user context'))
        for contract in ('```bobnotes', 'title', 'body', 'color', '1–12', '160', '6000',
                         'butter, rose, lavender, mint, sky'):
            self.assertIn(contract, prompt)

    def test_grounded_sources_intent_and_save_semantics_are_explicit(self):
        prompt = add_sticky_notes_policy('')
        for requirement in ('previous response', 'actual research', 'Never invent',
                            'source citations', 'meeting minutes', 'drafts until the user saves',
                            'Do not emit bobnotes unless the user requests notes'):
            self.assertIn(requirement, prompt)

    def test_draft_selection_precedes_conversational_save(self):
        policy=add_sticky_notes_policy('')
        for requirement in ('which notes the user wants to save','which Notes collection','displayed note numbers or exact titles','save only that selection','original draft text and sources'):
            self.assertIn(requirement,policy)

    def test_optional_offers_use_conversation_judgment_and_require_acceptance(self):
        policy = add_sticky_notes_policy('The user has just explained their goal.')
        for requirement in ('Use conversational judgment', 'not a keyword trigger',
                            'not a keyword trigger, fixed schedule', 'after the user declines',
                            'acceptance refers to the proposed topic', 'An offer alone does not create or save anything'):
            self.assertIn(requirement, policy)


if __name__ == '__main__':
    unittest.main()
