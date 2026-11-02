import unittest
from pydantic import ValidationError
from app.main import StreamRequest
from app.skill_routing import add_skill_routing, BRAVE_SEARCH_GUIDANCE, DATA_VISUALIZATION_GUIDANCE


class MultiSkillTests(unittest.TestCase):
    def test_request_limit_and_names(self):
        names = ['analysis-buddy', 'writing-buddy', 'research-buddy', 'data-buddy', 'planning-buddy', 'coding-buddy']
        self.assertEqual(StreamRequest(prompt='Combine instructions', skill_names=names).skill_names, names)
        for invalid in [names + ['security-buddy'], ['bad/name'], ['UPPER']]:
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                StreamRequest(prompt='Combine instructions', skill_names=invalid)
        self.assertEqual(StreamRequest(prompt='Legacy selection', skill_name='data-buddy').skill_names, [])

    def test_secondary_skills_keep_specialized_guidance(self):
        prompt = add_skill_routing('Analyze and research', [], explicit_skill='writing-buddy',
                                   explicit_skills=['writing-buddy', 'research-buddy', 'data-buddy'])
        self.assertIn(BRAVE_SEARCH_GUIDANCE, prompt)
        self.assertIn(DATA_VISUALIZATION_GUIDANCE, prompt)
        self.assertIn('Apply all explicitly selected skills together', prompt)
        self.assertNotIn('Automatic skill selection:', prompt)


if __name__ == '__main__':
    unittest.main()
