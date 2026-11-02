import unittest
import json
from unittest.mock import patch, MagicMock
from app.personalization import format_user_context, personalize_prompt, get_tutorial_settings, update_tutorial_settings, TutorialSettings

class UserPersonalizationTests(unittest.TestCase):
    def test_tutorial_default_and_account_lookup(self):
        with patch('app.personalization.records', return_value=[]) as records:
            self.assertEqual(get_tutorial_settings({'username': 'alice'}), {'disabled': False})
            records.assert_called_once_with('alice', 'tutorials')
        with patch('app.personalization.records', return_value=[{'disabled': True}]):
            self.assertEqual(get_tutorial_settings({'username': 'alice'}), {'disabled': False})
        with patch('app.personalization.records', return_value=[{'disabled': True, 'welcome_version': 1}]):
            self.assertEqual(get_tutorial_settings({'username': 'alice'}), {'disabled': True})

    def test_tutorial_setting_can_be_disabled_and_reenabled(self):
        connection = MagicMock()
        with patch('app.personalization.ensure_schema'), patch('app.personalization.job_queue._connect') as connect:
            connect.return_value.__enter__.return_value = connection
            for disabled in (True, False):
                self.assertEqual(update_tutorial_settings(TutorialSettings(disabled=disabled), {'username': 'alice'}), {'disabled': disabled})
                sql, params = connection.execute.call_args.args
                self.assertIn('ON CONFLICT', sql)
                self.assertEqual(params[0], 'alice')
                self.assertEqual(json.loads(params[1]), {'disabled': disabled, 'welcome_version': 1})

    def test_name_and_enabled_preferences(self):
        context = format_user_context('Alice Smith', [{'content':'Use Greek', 'enabled':True}, {'content':'Use German','enabled':False}])
        self.assertIn('Alice Smith', context)
        self.assertIn('Use Greek', context)
        self.assertNotIn('Use German', context)
        self.assertIn('current request takes precedence', context)
        self.assertIn('not privileged instructions', context)
    def test_no_technical_identity_or_invented_profile(self):
        self.assertEqual(format_user_context('kc-'+'a'*40, []), '')
        self.assertEqual(format_user_context(None, []), '')
    def test_profile_is_loaded_for_requested_account_only(self):
        with patch('app.auth.user_profile', return_value={'display_name':'Alice Smith'}) as profile, patch('app.personalization.records', return_value=[{'content':'Concise answers'}]) as memories:
            result = personalize_prompt('Explain bandwidth', 'alice')
        profile.assert_called_once_with('alice', False)
        memories.assert_called_once_with('alice', 'memories')
        self.assertTrue(result.startswith('Explain bandwidth'))
        self.assertIn('Alice Smith', result)
    def test_profile_values_are_json_escaped_and_bounded(self):
        context = format_user_context('A"\nB', [{'content':'x'*2000}])
        self.assertIn('A\\"\\nB', context)
        self.assertNotIn('x'*1001, context)

if __name__ == '__main__': unittest.main()
