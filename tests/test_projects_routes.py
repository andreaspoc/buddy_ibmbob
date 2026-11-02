"""Exercise the actual /projects handler without importing the heavy app runtime."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse


class ProjectsRouteContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'app' / 'main.py'
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'projects')
        self.assertEqual({ast.literal_eval(decorator.args[0]) for decorator in handler.decorator_list}, {'/projects', '/projects/'})
        handler.decorator_list = []
        self.store = SimpleNamespace(list_projects=Mock(return_value=[{'id':'personal-code-project','name':'Owned repository'}]))
        self.root = AsyncMock(return_value=HTMLResponse('<!doctype html><div id="root"></div>'))
        async def threadpool(function, *args):
            return function(*args)
        namespace = {'Request':Request, 'Depends':lambda dependency:None, 'current_user':object(),
                     'project_store':self.store, 'root':self.root, 'run_in_threadpool':threadpool, 'JSONResponse':JSONResponse}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[handler],type_ignores=[])),str(source),'exec'), namespace)
        self.handler=namespace['projects']

    async def invoke(self, accept=None):
        headers=[] if accept is None else [(b'accept',accept.encode())]
        return await self.handler(Request({'type':'http','headers':headers}), {'username':'fixture'})

    async def test_html_navigation_serves_app_and_varies_accept(self):
        for accept in ['text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'TEXT/HTML']:
            with self.subTest(accept=accept):
                response=await self.invoke(accept)
                self.assertEqual(response.media_type,'text/html')
                self.assertEqual(response.headers['vary'],'Accept')
                self.assertIn(b'id="root"',response.body)
        self.store.list_projects.assert_not_called()
        self.assertEqual(self.root.await_count,3)

    async def test_json_api_keeps_owned_code_projects(self):
        for accept in [None,'application/json','*/*']:
            with self.subTest(accept=accept):
                response=await self.invoke(accept)
                self.assertEqual(response.media_type,'application/json')
                self.assertEqual(response.headers['vary'],'Accept')
                self.assertEqual(json.loads(response.body),[{'id':'personal-code-project','name':'Owned repository'}])
        self.root.assert_not_awaited()
        self.assertEqual(self.store.list_projects.call_count,3)
        self.store.list_projects.assert_called_with('fixture')


if __name__=='__main__':
    unittest.main()
