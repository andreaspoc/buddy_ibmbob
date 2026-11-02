"""Authenticated ElevenLabs proxy. Provider credentials stay on the server."""
from __future__ import annotations
import asyncio
import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from app.auth import current_user

router = APIRouter(prefix='/voice', tags=['voice'])
_slots = asyncio.Semaphore(4)
_requests: dict[str, deque] = defaultdict(deque)


def configuration() -> dict:
    try:
        data = json.loads(Path(os.getenv('ELEVENLABS_CONFIG_FILE', '/root/.bob/elevenlabs.json')).read_text())
    except (OSError, ValueError):
        data = {}
    return {'api_key': os.getenv('ELEVENLABS_API_KEY') or data.get('api_key', ''),
            'voice_id': os.getenv('ELEVENLABS_VOICE_ID') or data.get('voice_id', ''),
            'model_id': os.getenv('ELEVENLABS_MODEL_ID') or data.get('model_id', 'eleven_multilingual_v2')}


def credentials() -> dict:
    config = configuration()
    if not config['api_key']:
        raise HTTPException(503, 'Voice replies are not configured. Ask your administrator to connect ElevenLabs.')
    return config


def provider_error(status: int) -> HTTPException:
    if status in (401, 403):
        return HTTPException(502, 'ElevenLabs rejected the connection. Check the server API key and its permissions.')
    if status == 402:
        return HTTPException(402, 'ElevenLabs requires credits or a paid plan for this voice. Choose another voice or check your ElevenLabs subscription.')
    if status == 429:
        return HTTPException(429, 'ElevenLabs usage or concurrency limit reached. Try again later.')
    return HTTPException(502, 'ElevenLabs could not generate speech. Try another voice or retry.')


@router.get('/status')
async def status(user: dict = Depends(current_user)):
    config = configuration()
    return {'configured': bool(config['api_key']), 'voice_id': config['voice_id']}


@router.get('/voices')
async def voices(user: dict = Depends(current_user)):
    config = credentials()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get('https://api.elevenlabs.io/v2/voices',
                                        params={'page_size': 100}, headers={'xi-api-key': config['api_key']})
        if not response.is_success:
            raise provider_error(response.status_code)
        return {'voices': [{'id': v['voice_id'], 'name': v['name']} for v in response.json().get('voices', [])],
                'default_voice_id': config['voice_id']}
    except httpx.HTTPError:
        raise HTTPException(502, 'Could not connect to ElevenLabs. Try again later.') from None


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=3000)
    voice_id: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')

    @field_validator('text')
    @classmethod
    def text_required(cls, value: str):
        if not value.strip():
            raise ValueError('Speech text cannot be empty')
        return value.strip()


@router.post('/speech')
async def speech(body: SpeechRequest, user: dict = Depends(current_user)):
    config = credentials()
    now = time.monotonic()
    # Remove expired user buckets so shared-server memory stays bounded.
    for key in list(_requests):
        if not _requests[key] or _requests[key][-1] < now - 60:
            del _requests[key]
    bucket = _requests[user['username']]
    while bucket and bucket[0] < now - 60:
        bucket.popleft()
    if len(bucket) >= 90:
        raise HTTPException(429, 'Too many voice requests. Please wait a minute.')
    bucket.append(now)
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=5)
    except TimeoutError:
        raise HTTPException(429, 'Voice is busy. Please try again shortly.') from None
    client = httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10))
    try:
        request = client.build_request('POST', f'https://api.elevenlabs.io/v1/text-to-speech/{body.voice_id}/stream',
                                       params={'output_format': 'mp3_44100_128'},
                                       headers={'xi-api-key': config['api_key']},
                                       json={'text': body.text, 'model_id': config['model_id']})
        response = await client.send(request, stream=True)
        if not response.is_success:
            await response.aclose()
            raise provider_error(response.status_code)
    except BaseException as exc:
        await client.aclose()
        _slots.release()
        if isinstance(exc, httpx.HTTPError):
            raise HTTPException(502, 'Could not connect to ElevenLabs. Try again later.') from None
        raise

    async def audio():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()
            _slots.release()
    return StreamingResponse(audio(), media_type='audio/mpeg', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


from app.voice_policy import discussion_prompt

# Realtime transports use same-origin, cookie-authenticated sockets. No provider
# token or API key is ever passed to the browser.
from contextlib import suppress
import base64
from urllib.parse import urlsplit, urlencode
from fastapi import WebSocket, WebSocketDisconnect, Request
from websockets.asyncio.client import connect as ws_connect

_ws_users: dict[str, int] = defaultdict(int)
_ws_slots = asyncio.Semaphore(12)


async def socket_user(socket: WebSocket):
    origin = socket.headers.get('origin', '')
    host = socket.headers.get('host', '')
    if not origin or urlsplit(origin).netloc.lower() != host.lower():
        await socket.close(code=1008, reason='Same-origin voice connection required')
        return None
    try:
        user = await current_user(Request({**socket.scope, 'type': 'http'}))
        credentials()
    except HTTPException:
        await socket.close(code=1008, reason='Sign in and configure voice first')
        return None
    if _ws_users[user['username']] >= 3:
        await socket.close(code=1013, reason='Too many voice connections')
        return None
    try:
        await asyncio.wait_for(_ws_slots.acquire(), .1)
    except TimeoutError:
        await socket.close(code=1013, reason='Voice service is busy')
        return None
    _ws_users[user['username']] += 1
    return user


def release_socket(user):
    name = user['username']
    _ws_users[name] -= 1
    if not _ws_users[name]:
        del _ws_users[name]
    _ws_slots.release()


async def socket_failure(socket: WebSocket):
    with suppress(Exception):
        await socket.send_json({'type': 'error', 'message': 'The ElevenLabs voice stream stopped. Check your connection, API permissions, and credits, then reconnect.'})
        await socket.close(code=1011)


async def relay_pair(upstream, downstream):
    tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket('/listen')
async def realtime_listen(socket: WebSocket):
    user = await socket_user(socket)
    if not user:
        return
    config = configuration()
    params = {'model_id': 'scribe_v2_realtime', 'audio_format': 'pcm_16000',
              'commit_strategy': 'vad', 'vad_silence_threshold_secs': '0.8',
              'min_speech_duration_ms': '160'}
    started = time.monotonic()
    byte_count = 0
    try:
        await socket.accept()
        async with asyncio.timeout(900):
            async with ws_connect('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + urlencode(params),
                                  additional_headers={'xi-api-key': config['api_key']},
                                  open_timeout=15, max_size=1_000_000) as provider:
                async def receive_audio():
                    nonlocal byte_count
                    while True:
                        chunk = await socket.receive_bytes()
                        byte_count += len(chunk)
                        if len(chunk) > 32768 or len(chunk) % 2 or byte_count > 32000 * (time.monotonic() - started + 10):
                            await socket.close(code=1008, reason='Invalid audio stream')
                            return
                        await provider.send(json.dumps({'message_type': 'input_audio_chunk',
                                                        'audio_base_64': base64.b64encode(chunk).decode()}))

                async def receive_transcripts():
                    async for raw in provider:
                        data = json.loads(raw)
                        kind = data.get('message_type')
                        if kind == 'session_started':
                            await socket.send_json({'type': 'ready'})
                        elif kind in ('partial_transcript', 'committed_transcript'):
                            await socket.send_json({'type': 'partial' if kind == 'partial_transcript' else 'transcript',
                                                    'text': str(data.get('text', ''))[:20000]})
                        elif 'error' in data or kind in ('auth_error', 'quota_exceeded', 'rate_limited', 'resource_exhausted', 'unaccepted_terms', 'session_time_limit_exceeded'):
                            raise RuntimeError('Speech provider rejected the stream')
                await relay_pair(receive_audio, receive_transcripts)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:
        await socket_failure(socket)
    finally:
        with suppress(Exception):
            await socket.close()
        release_socket(user)


@router.websocket('/speak')
async def realtime_speak(socket: WebSocket):
    user = await socket_user(socket)
    if not user:
        return
    config = configuration()
    try:
        await socket.accept()
        async with asyncio.timeout(180):
            initial = await asyncio.wait_for(socket.receive_json(), 10)
            body = SpeechRequest(text='initial', voice_id=initial.get('voice_id', ''))
            uri = f'wss://api.elevenlabs.io/v1/text-to-speech/{body.voice_id}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000'
            async with ws_connect(uri, open_timeout=15, max_size=4_000_000) as provider:
                await provider.send(json.dumps({'text': ' ', 'xi_api_key': config['api_key'],
                                                'generation_config': {'chunk_length_schedule': [80, 120, 200, 260]}}))
                await socket.send_json({'type': 'ready'})
                total = 0

                async def send_text():
                    nonlocal total
                    finished = False
                    while True:
                        try:
                            data = await asyncio.wait_for(socket.receive_json(), 10)
                        except TimeoutError:
                            await provider.send(json.dumps({'text': ' '}))
                            continue
                        if finished:
                            raise ValueError('Speech input already finished')
                        text = data.get('text', '')
                        if not isinstance(text, str) or len(text) > 3000:
                            raise ValueError('Invalid speech text')
                        total += len(text)
                        if total > 18000:
                            raise ValueError('Speech turn too long')
                        if text:
                            await provider.send(json.dumps({'text': text, 'flush': bool(data.get('flush'))}))
                        if data.get('done'):
                            await provider.send(json.dumps({'text': ''}))
                            finished = True
                            # Keep the receiver alive until the last audio arrives.

                async def receive_audio():
                    async for raw in provider:
                        data = json.loads(raw)
                        if data.get('audio'):
                            await socket.send_bytes(base64.b64decode(data['audio']))
                        if data.get('isFinal'):
                            await socket.send_json({'type': 'done'})
                            return
                        if data.get('error') or data.get('message'):
                            raise RuntimeError('Speech generation failed')
                    await socket.send_json({'type': 'done'})
                await relay_pair(send_text, receive_audio)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:
        await socket_failure(socket)
    finally:
        with suppress(Exception):
            await socket.close()
        release_socket(user)
