import asyncio
import time
import unittest
from app.streaming import coalesce_text


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_text_is_immediate_and_text_is_preserved(self):
        async def source():
            for _ in range(100): yield {'type': 'delta', 'text': 'x'}
            yield {'type': 'done'}
        stream = coalesce_text(source(), interval=.04)
        start = time.monotonic()
        self.assertEqual(await anext(stream), {'type': 'delta', 'text': 'x'})
        self.assertLess(time.monotonic()-start, .02)
        events = [e async for e in stream]
        self.assertEqual(''.join(e.get('text','') for e in events), 'x'*99)
        self.assertLess(len(events), 10)
        self.assertEqual(events[-1]['type'], 'done')

    async def test_status_order_and_final_text_are_preserved(self):
        expected = [{'type':'delta','text':'a'}, {'type':'delta','text':'b'},
                    {'type':'skill','name':'rag'}, {'type':'delta','text':'c'}, {'type':'error','message':'Stopped'}]
        async def source():
            for event in expected: yield event
        events = [e async for e in coalesce_text(source())]
        self.assertEqual(events, expected)

    async def test_idle_text_flushes_before_next_event(self):
        closed = []
        async def source():
            try:
                yield {'type':'delta','text':'first'}
                yield {'type':'delta','text':'next'}
                await asyncio.sleep(10)
            finally: closed.append(True)
        stream = coalesce_text(source(), interval=.02)
        await anext(stream)
        self.assertEqual((await asyncio.wait_for(anext(stream), .3))['text'], 'next')
        await stream.aclose()
        self.assertTrue(closed)

    async def test_continuous_ready_source_cannot_starve_deadline(self):
        async def source():
            for _ in range(50):
                # Simulate a producer whose next item is always ready, but takes
                # CPU time to decode. A ready read must not bypass the deadline.
                time.sleep(.002)
                yield {'type': 'delta', 'text': 'x'}
        events = [e async for e in coalesce_text(source(), interval=.01, max_chars=10000)]
        self.assertEqual(''.join(e['text'] for e in events), 'x' * 50)
        self.assertGreater(len(events), 5)
        self.assertLess(max(len(e['text']) for e in events), 15)

if __name__=='__main__': unittest.main()
