import unittest
from app.skill_routing import add_skill_routing

class SkillRoutingTests(unittest.TestCase):
    skills = [{'name': 'knowledge-buddy', 'description': 'Use uploaded evidence'},
              {'name': 'custom-policy-buddy', 'description': 'Follow company policy'}]

    def test_catalog_includes_user_custom_skills(self):
        prompt = add_skill_routing('Explain this PDF', self.skills, documents=['policy.pdf'])
        self.assertIn('custom-policy-buddy', prompt)
        self.assertIn('policy.pdf', prompt)
        self.assertIn('use_skill', prompt)
        self.assertIn('Never begin creating a presentation', prompt)

    def test_manual_override_is_preserved(self):
        self.assertEqual(add_skill_routing('Question', self.skills, explicit_skill='knowledge-buddy'), 'Question')
        self.assertEqual(add_skill_routing('$knowledge-buddy Question', self.skills), '$knowledge-buddy Question')

    def test_no_matching_skill_can_use_normal_coding(self):
        prompt = add_skill_routing('Write a Python parser', self.skills)
        self.assertIn('proceed normally', prompt)
        self.assertIn('do not invent a skill', prompt)
        self.assertEqual(add_skill_routing('Question', []), 'Question')

    def test_analyst_guidance_reaches_existing_and_manual_skills(self):
        from app.skill_routing import DATA_VISUALIZATION_GUIDANCE
        skills = self.skills + [{'name': 'data-buddy', 'description': 'Legacy analysis skill'}]
        for prompt, explicit in [('Analyze sales', None), ('Analyze sales', 'data-buddy'),
                                 ('$data-buddy Analyze sales', None)]:
            with self.subTest(explicit=explicit, prompt=prompt):
                result = add_skill_routing(prompt, skills, explicit_skill=explicit)
                self.assertTrue(result.startswith(prompt))
                self.assertIn(DATA_VISUALIZATION_GUIDANCE, result)
        self.assertEqual(add_skill_routing('Question', skills, explicit_skill='knowledge-buddy'), 'Question')
        self.assertEqual(add_skill_routing('$knowledge-buddy Question', skills), '$knowledge-buddy Question')

    def test_template_context_is_retained(self):
        prompt = add_skill_routing('Create HTML deck', self.skills, mode='presentation', template_id='forest-gold-starter')
        self.assertIn('forest-gold-starter', prompt)
        self.assertIn('retain the selected template', prompt)

    def test_direct_tool_invocation_guidance(self):
        prompt = add_skill_routing('Search for latest news', self.skills)
        self.assertIn('invoke that tool immediately on turn 1', prompt)

    def test_unrelated_request_omits_expensive_chart_guidance(self):
        from app.skill_routing import DATA_VISUALIZATION_GUIDANCE
        skills = self.skills + [{'name': 'data-buddy', 'description': 'Analysis'}]
        for request in ['Hello!', 'Explain how a Python context manager works']:
            result = add_skill_routing('Persona mentions data analysis. ' + request,
                                       skills, request_prompt=request)
            self.assertNotIn(DATA_VISUALIZATION_GUIDANCE, result)
            self.assertIn('custom-policy-buddy', result)
            self.assertIn('Available skills:', result)

    def test_analysis_and_ambiguous_followups_keep_complete_guidance(self):
        from app.skill_routing import DATA_VISUALIZATION_GUIDANCE
        skills = self.skills + [{'name': 'data-buddy', 'description': 'Analysis'}]
        for request in ['Analyze the sales figures', 'Show those by region instead',
                        'Why?', 'Make a histogram of response times']:
            result = add_skill_routing('Wrapped request', skills, request_prompt=request)
            self.assertIn(DATA_VISUALIZATION_GUIDANCE, result)

    def test_raw_explicit_skill_survives_prompt_wrapping(self):
        result = add_skill_routing('Persona and history', self.skills,
                                   request_prompt='$knowledge-buddy Explain the document')
        self.assertEqual(result, 'Persona and history')

    def test_web_button_requires_search_even_with_explicit_skill(self):
        from app.skill_routing import BRAVE_SEARCH_GUIDANCE
        result = add_skill_routing('Wrapped request', self.skills,
                                   explicit_skill='research-buddy', request_prompt='Latest news')
        self.assertIn(BRAVE_SEARCH_GUIDANCE, result)
        self.assertNotIn('Automatic skill selection:', result)

    def test_online_research_requires_brave_without_installed_skill(self):
        for request in ['research online about Python', 'Search the web for news',
                        'Do online research about batteries', '/research-buddy news',
                        '$research-buddy news', 'look up the answer on the internet']:
            with self.subTest(request=request):
                result = add_skill_routing('Wrapped request', [], request_prompt=request)
                self.assertIn('Required Brave Search:', result)
                self.assertIn('app.mcp_client tools brave_search', result)

    def test_online_research_keeps_requirement_with_other_explicit_skill(self):
        result = add_skill_routing('Wrapped request', self.skills,
                                   explicit_skill='custom-policy-buddy',
                                   request_prompt='Research online about this policy')
        self.assertIn('Required Brave Search:', result)

    def test_ordinary_local_request_does_not_require_search(self):
        self.assertEqual(add_skill_routing('Search the local files', []), 'Search the local files')

if __name__ == '__main__': unittest.main()
