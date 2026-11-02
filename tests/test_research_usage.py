import unittest
from app.research import research_usage

class UsageTests(unittest.TestCase):
    def test_phases_not_double_counted_and_retries_added(self):
        events=[{'type':'error','cost':2,'tokens':20},{'type':'research_usage','phase':'Planning','cost':1,'tokens':10},{'type':'research_usage','phase':'Evidence','cost':3,'tokens':30},{'type':'done','cost':4,'tokens':40}]
        usage=research_usage(events)
        self.assertEqual(usage['bobcoins'],6)
        self.assertEqual(usage['tokens'],60)
        self.assertEqual(len(usage['phases']),2)
    def test_unknown_is_not_zero(self):
        self.assertIsNone(research_usage([])['bobcoins'])
        self.assertEqual(research_usage([{'type':'done','cost':0}])['bobcoins'],0)
