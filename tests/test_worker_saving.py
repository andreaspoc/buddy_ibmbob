"""Exercise production finalization ordering with a deliberately blocked save."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock


class SavingTests(unittest.IsolatedAsyncioTestCase):
    async def test_answer_ready_is_published_before_saving_and_done_waits_for_save(self):
        tree = ast.parse(Path('app/worker.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_run_in_workspace')
        # Execute the production finalization block without unrelated model setup.
        context = next(n for n in function.body if isinstance(n, ast.AsyncWith))
        index = next(i for i,n in enumerate(context.body) if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and ast.unparse(n.test)=="done.get('type') == 'done'")
        body = context.body[index:]
        wrapper = ast.AsyncFunctionDef(name='finalize', args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=body,decorator_list=[])
        module=ast.fix_missing_locations(ast.Module(body=[wrapper],type_ignores=[]))
        saving = asyncio.Event(); release = asyncio.Event()
        checked = []
        async def blocked_save(*args):
            self.assertEqual(checked, ['fixture-before'])
            saving.set(); await release.wait()
        async def threaded(function,*args):
            result = function(*args)
            if hasattr(result,'__await__'): return await result
            return result
        recorder=SimpleNamespace(correlation={},record_event=AsyncMock(return_value=True),finish=AsyncMock())
        namespace={'asyncio':SimpleNamespace(to_thread=threaded,get_running_loop=asyncio.get_running_loop),
            'done':{'type':'done'},'recorder':recorder,'package_changed_carbon_html':lambda *args:None,
            'flag_changed_html':lambda _,before:checked.append(before),'html_before':'fixture-before',
            'workspace':None,'carbon_before':{},'storage':SimpleNamespace(persist_job=blocked_save),
            'job':{'id':'fixture'},'root':None,'logger':SimpleNamespace(info=lambda *args:None)}
        exec(compile(module,'app/worker.py','exec'),namespace)
        task=asyncio.create_task(namespace['finalize']())
        await asyncio.wait_for(saving.wait(),1)
        self.assertEqual(recorder.record_event.call_args.args[0]['state'],'saving')
        recorder.finish.assert_not_awaited()
        self.assertFalse(task.done())
        release.set(); await task
        recorder.finish.assert_awaited_once_with({'type':'done'})
