import unittest
from app.conversation_titles import conversation_title

class ConversationTitleTests(unittest.TestCase):
    def test_topics(self):
        self.assertEqual(conversation_title('check docs and tell me about acme company information'), 'Acme company information')
        self.assertEqual(conversation_title('please need info for my dashboards names'), 'My dashboards names')
        self.assertEqual(conversation_title('Can you create a PowerPoint presentation about cloud migration?'), 'Cloud migration presentation')
        self.assertEqual(conversation_title('[Attached spreadsheet: SAS_ETLs.xlsx]\nPlease review ETL failures'), 'Review ETL failures')
        self.assertEqual(conversation_title('[Attached spreadsheet: SAS_ETLs.xlsx]'), 'SAS ETLs analysis')
    def test_greetings_do_not_name_a_topic(self):
        for text in ('hi how are you?', 'Hello!', 'thanks', ''):
            self.assertIsNone(conversation_title(text))
    def test_whole_word_limit(self):
        title=conversation_title('Analyze customer application performance and infrastructure monitoring over multiple regions')
        self.assertLessEqual(len(title), 42)
        self.assertLessEqual(len(title.split()), 6)
        self.assertNotIn('…', title)

if __name__ == '__main__': unittest.main()
