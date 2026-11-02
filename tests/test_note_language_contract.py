"""The real stream schema accepts UI language codes, never regional locales."""
import unittest
from pydantic import ValidationError
from app.main import StreamRequest

class NoteLanguageContract(unittest.TestCase):
    def test_supported_note_languages_match_stream_schema(self):
        for language, locale in [('en','en-GB'),('el','el-GR'),('hi','hi-IN'),('mt','mt-MT')]:
            with self.subTest(language=language):
                payload={'prompt':'Revise this synthetic test note.', 'workspace_id':'a'*32,
                         'session_id':None, 'mode':'agent','ui_language':language,
                         'approval_policy':{'mode':'selected','actions':['commands','files','dependencies','messages','external','publish']}}
                self.assertEqual(StreamRequest.model_validate(payload).ui_language,language)
                with self.assertRaises(ValidationError):
                    StreamRequest.model_validate({**payload,'ui_language':locale})

if __name__=='__main__':unittest.main()
