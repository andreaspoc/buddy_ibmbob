"""Office imports preserve caller identity, read only, and bound streamed data."""
import json
import os
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import httpx
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response
import app
from buddy_learning import office_import as importer


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.read_count = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.read_count += 1
            yield chunk


class OfficeImportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = str(uuid4())
        self.request = Request({'type':'http', 'method':'GET', 'path':'/api/learning/office-files',
            'headers':[(b'host',b'buddy.fixture'), (b'cookie',b'bob_ui_session=fixture-session'),
                       (b'authorization',b'Bearer fixture-token'), (b'x-user',b'forged-user'),
                       (b'x-username',b'forged-user'), (b'origin',b'https://buddy.fixture')],
            'state':{}, 'query_string':b''})
        self.user = {'username':'verified-user', 'is_admin':False}
        self.env = patch.dict(os.environ, {'BUDDY_OFFICE_ENABLED':'1', 'BUDDY_OFFICE_PLUGIN_URL':'http://office.fixture:8080'})
        self.env.start()
        self.auth = patch.object(importer, 'current_user', new=AsyncMock(return_value=self.user))
        self.current_user = self.auth.start()
        self.requests = []
        self.options = []
        self.real_client = httpx.AsyncClient

    def tearDown(self):
        self.auth.stop()
        self.env.stop()

    def metadata(self, **changes):
        return {'id':self.identity, 'name':'Fixture.pdf', 'extension':'pdf', 'size':3, **changes}

    def transport(self, handler):
        def factory(**kwargs):
            self.options.append(kwargs)
            def record(request):
                self.requests.append(request)
                return handler(request)
            return self.real_client(transport=httpx.MockTransport(record), **kwargs)
        return patch.object(importer.httpx, 'AsyncClient', side_effect=factory)

    async def assert_http_error(self, expected, awaitable):
        with self.assertRaises(HTTPException) as failure:
            await awaitable
        self.assertEqual(failure.exception.status_code, expected)

    async def test_remote_list_filters_supported_files_and_returns_only_bounded_metadata(self):
        files = [self.metadata(), self.metadata(id=str(uuid4()), name='Other.docx',extension='docx',owner='PRIVATE_OWNER'),
                 self.metadata(id=str(uuid4()), name='Hidden.exe',extension='exe'),
                 self.metadata(id=str(uuid4()), name='Mismatch.exe',extension='pdf'),
                 self.metadata(id=str(uuid4()), name='Fixture second.pdf')]
        with self.transport(lambda request: httpx.Response(200,json={'items':files})):
            first = await importer.list_files(self.request, query='fixture', limit=1)
            second = await importer.list_files(self.request, query='fixture', offset=1, limit=1)
        self.assertEqual(len(first['items']),1)
        self.assertEqual(first['next_offset'],1)
        self.assertEqual(second['next_offset'],None)
        self.assertEqual(second['items'][0]['name'],'Fixture second.pdf')
        self.assertEqual(set(first['items'][0]),{'id','name','extension'})
        self.assertTrue(all(request.method=='GET' for request in self.requests))
        self.assertTrue(all(request.url.path=='/api/office/files' for request in self.requests))
        self.assertTrue(all(options['trust_env'] is False and options['follow_redirects'] is False for options in self.options))

    async def test_remote_read_forwards_original_auth_and_never_forged_actor_headers(self):
        def handler(request):
            if request.url.path.endswith('/download'):
                return httpx.Response(200,content=b'PDF')
            return httpx.Response(200,json=self.metadata())
        with self.transport(handler):
            result = await importer.read_file(self.request,self.identity)
        self.assertEqual(result,{'name':'Fixture.pdf','raw':b'PDF'})
        self.current_user.assert_awaited_once_with(self.request)
        self.assertEqual(len(self.requests),2)
        for request in self.requests:
            self.assertEqual(request.method,'GET')
            self.assertEqual(request.headers['authorization'],'Bearer fixture-token')
            self.assertEqual(request.headers['cookie'],'bob_ui_session=fixture-session')
            self.assertNotIn('x-user',request.headers)
            self.assertNotIn('x-username',request.headers)
            self.assertNotIn('origin',request.headers)
            self.assertNotEqual(request.headers['host'],'buddy.fixture')
            self.assertNotIn('verified-user',str(request.url))
            self.assertNotIn('forged-user',str(request.url))

    async def test_disabled_office_or_invalid_connection_makes_no_request(self):
        with self.transport(lambda request: self.fail('Office must not be contacted')):
            with patch.dict(os.environ,{'BUDDY_OFFICE_ENABLED':'0'}):
                await self.assert_http_error(503, importer.list_files(self.request))
            for origin in ('file:///etc/passwd','http://user:password@office.fixture','http://office.fixture?token=secret'):
                with patch.dict(os.environ,{'BUDDY_OFFICE_PLUGIN_URL':origin}):
                    await self.assert_http_error(503, importer.list_files(self.request))
        self.assertEqual(self.requests,[])

    async def test_original_identity_must_be_verified_before_remote_access(self):
        self.current_user.side_effect=HTTPException(401,'Sign in required')
        with self.transport(lambda request: self.fail('Unverified request must not reach Office')):
            await self.assert_http_error(401,importer.read_file(self.request,self.identity))
        self.assertEqual(self.requests,[])

    async def test_denied_missing_and_unavailable_responses_do_not_download(self):
        for upstream,expected in ((401,401),(403,403),(404,404),(413,413),(500,503),(429,503),(302,502)):
            with self.subTest(upstream=upstream), self.transport(lambda request:httpx.Response(upstream,headers={'Location':'https://untrusted.fixture/'})):
                await self.assert_http_error(expected,importer.read_file(self.request,self.identity))
        self.assertTrue(all(not request.url.path.endswith('/download') for request in self.requests))

    async def test_streamed_download_limit_applies_without_content_length(self):
        chunks=Chunks([b'ab',b'cde',b'never-read'])
        def handler(request):
            if request.url.path.endswith('/download'):
                return httpx.Response(200,stream=chunks)
            return httpx.Response(200,json=self.metadata())
        with patch.object(importer,'MAX_BYTES',4),self.transport(handler):
            await self.assert_http_error(413,importer.read_file(self.request,self.identity))
        self.assertEqual(chunks.read_count,2)

    async def test_large_metadata_size_rejected_before_download(self):
        with self.transport(lambda request:httpx.Response(200,json=self.metadata(size=importer.MAX_BYTES+1))):
            await self.assert_http_error(413,importer.read_file(self.request,self.identity))
        self.assertEqual(len(self.requests),1)

    async def test_content_length_limit_does_not_read_body(self):
        chunks=Chunks([b'never-read'])
        with patch.object(importer,'MAX_METADATA_BYTES',4),self.transport(lambda request:httpx.Response(200,headers={'Content-Length':'20'},stream=chunks)):
            await self.assert_http_error(413,importer.list_files(self.request))
        self.assertEqual(chunks.read_count,0)

    async def test_invalid_metadata_and_unsupported_files_rejected(self):
        for metadata,expected in ((self.metadata(id=str(uuid4())),502),
                                  (self.metadata(name='Fixture.exe',extension='exe'),422),
                                  ({'items':[]},502)):
            with self.subTest(metadata=metadata),self.transport(lambda request:httpx.Response(200,json=metadata)):
                await self.assert_http_error(expected,importer.read_file(self.request,self.identity))
        with self.transport(lambda request:httpx.Response(200,content=b'not-json')):
            await self.assert_http_error(502,importer.list_files(self.request))

    async def test_bad_pagination_and_paths_never_reach_office(self):
        with self.transport(lambda request:self.fail('Invalid request must not reach Office')):
            for args in ({'limit':0},{'limit':101},{'limit':True},{'offset':-1},{'offset':True},{'query':'q'*201}):
                await self.assert_http_error(422,importer.list_files(self.request,**args))
            await self.assert_http_error(422,importer.read_file(self.request,'../../other-user'))
        self.assertEqual(self.requests,[])

    async def test_embedded_office_uses_verified_user_only(self):
        office=types.SimpleNamespace(files=MagicMock(return_value={'items':[self.metadata()]}),
            file_info=MagicMock(return_value=self.metadata()),download=MagicMock(return_value=Response(b'PDF')))
        with patch.dict(os.environ,{'BUDDY_OFFICE_PLUGIN_URL':''}),patch.object(app,'office',office,create=True):
            listed=await importer.list_files(self.request)
            result=await importer.read_file(self.request,self.identity)
        self.assertEqual(listed['items'][0]['id'],self.identity)
        self.assertEqual(result['raw'],b'PDF')
        office.files.assert_called_once_with(user=self.user)
        office.file_info.assert_called_once_with(importer.UUID(self.identity),user=self.user)
        office.download.assert_called_once_with(importer.UUID(self.identity),user=self.user)

    async def test_embedded_limit_and_access_denial_preserved(self):
        office=types.SimpleNamespace(file_info=MagicMock(return_value=self.metadata()),
                                    download=MagicMock(return_value=Response(b'too-large')))
        with patch.dict(os.environ,{'BUDDY_OFFICE_PLUGIN_URL':''}),patch.object(app,'office',office,create=True),patch.object(importer,'MAX_BYTES',4):
            await self.assert_http_error(413,importer.read_file(self.request,self.identity))
            office.file_info.side_effect=HTTPException(403,'Forbidden')
            await self.assert_http_error(403,importer.read_file(self.request,self.identity))


if __name__=='__main__':
    unittest.main()
