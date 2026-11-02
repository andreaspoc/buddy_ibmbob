"""Dedicated Zero-Polling WebSocket Gateway for Buddy.

Handles persistent duplex WebSocket connections with clients (/ws/gateway).
Dispatches prompt turns, cancellations, approvals, and guidance directly,
and streams events with zero polling via PostgreSQL pub/sub notifications.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from starlette.requests import Request
from pydantic import ValidationError

from app.auth import current_user
from app import job_queue

logger = logging.getLogger("bob_gateway")

app = FastAPI(
    title="Assistant Gateway",
    version="1.0.0",
    description="Dedicated real-time WebSocket connection gateway with zero polling.",
)


@app.get("/ready")
async def readiness():
    return {"ok": True, "service": "bob-gateway"}


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "bob-gateway"}


@app.websocket("/ws/gateway")
async def gateway_socket(websocket: WebSocket):
    # Verify origin
    from urllib.parse import urlsplit
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host")
    if origin and host and urlsplit(origin).netloc != host:
        await websocket.close(code=1008)
        return

    # Authenticate using existing session cookie / authorization
    try:
        user = await current_user(websocket)
    except (HTTPException, Exception) as exc:
        logger.warning("Unauthenticated gateway WebSocket attempt: %s", exc)
        await websocket.close(code=1008)
        return

    await websocket.accept()
    username = user["username"]
    logger.info("Gateway WebSocket opened for user %s", username)

    # Send initial connection ready frame
    await websocket.send_json({
        "type": "gateway_ready",
        "username": username,
        "service": "bob-gateway",
    })

    active_streams: dict[str, asyncio.Task] = {}

    async def _handle_prompt(payload: dict[str, Any]):
        from app.main import StreamRequest, chat_stream

        correlation_id = payload.get("correlation_id") or str(uuid.uuid4())
        try:
            stream_req = StreamRequest(**payload)
        except ValidationError as val_err:
            await websocket.send_json({
                "type": "error",
                "correlation_id": correlation_id,
                "message": str(val_err),
            })
            return

        # Prepare HTTP-compatible Request adapter
        headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in websocket.headers.items()]
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/chat/stream",
            "headers": headers,
            "query_string": b"",
            "client": websocket.client,
            "server": websocket.scope.get("server"),
            "state": websocket.scope.get("state", {}),
        }
        req_adapter = Request(scope)

        try:
            resp = await chat_stream(stream_req, req_adapter, user=user)
        except HTTPException as http_exc:
            await websocket.send_json({
                "type": "error",
                "correlation_id": correlation_id,
                "status_code": http_exc.status_code,
                "detail": http_exc.detail,
            })
            return
        except Exception as exc:
            logger.exception("Error executing chat_stream in gateway: %s", exc)
            await websocket.send_json({
                "type": "error",
                "correlation_id": correlation_id,
                "message": str(exc),
            })
            return

        job_id = resp.headers.get("X-Bob-Job-Id")
        resp_corr = resp.headers.get("X-Correlation-Id") or correlation_id
        user_msg_id = resp.headers.get("X-User-Message-Id")
        assistant_msg_id = resp.headers.get("X-Assistant-Message-Id")

        # Send instant ACK frame to the client
        await websocket.send_json({
            "type": "accepted",
            "job_id": job_id,
            "correlation_id": resp_corr,
            "user_message_id": user_msg_id,
            "assistant_message_id": assistant_msg_id,
            "replayed": resp.headers.get("X-Idempotency-Replayed") == "true",
        })

        # Stream lines from response.body_iterator
        async def _stream_worker():
            last_recheck = time.monotonic()
            try:
                async for chunk in resp.body_iterator:
                    now = time.monotonic()
                    if now - last_recheck > 10.0:
                        try:
                            await current_user(websocket)
                        except (HTTPException, Exception) as auth_err:
                            logger.warning("Session revoked during stream for user %s: %s", username, auth_err)
                            await websocket.close(code=1008)
                            break
                        last_recheck = now
                    if isinstance(chunk, bytes):
                        chunk = chunk.decode("utf-8")
                    if chunk.strip():
                        await websocket.send_text(chunk.strip())
            except Exception as stream_err:
                logger.debug("Gateway stream terminated for job %s: %s", job_id, stream_err)
            finally:
                active_streams.pop(resp_corr, None)

        task = asyncio.create_task(_stream_worker())
        active_streams[resp_corr] = task

    async def _handle_cancel(payload: dict[str, Any]):
        job_id_str = payload.get("job_id")
        if not job_id_str:
            return
        from app.main import cancel_job
        try:
            res = await cancel_job(uuid.UUID(job_id_str), user=user)
            await websocket.send_json({"type": "cancel_ack", "job_id": job_id_str, "result": res})
        except Exception as exc:
            logger.warning("Cancel error for job %s: %s", job_id_str, exc)

    async def _handle_approval(payload: dict[str, Any]):
        job_id_str = payload.get("job_id")
        approval_id_str = payload.get("approval_id")
        decision = payload.get("decision")
        if not (job_id_str and approval_id_str and decision):
            return
        from app.main import decide_job_approval, ApprovalDecisionRequest
        try:
            req = ApprovalDecisionRequest(decision=decision)
            res = await decide_job_approval(job_id_str, approval_id_str, req, user=user)
            await websocket.send_json({"type": "approval_ack", "job_id": job_id_str, "result": res})
        except Exception as exc:
            logger.warning("Approval error: %s", exc)

    async def _handle_guidance(payload: dict[str, Any]):
        job_id_str = payload.get("job_id")
        instruction = payload.get("instruction")
        if not (job_id_str and instruction):
            return
        from app.main import guide_chat, ChatGuidanceRequest
        try:
            req = ChatGuidanceRequest(instruction=instruction)
            res = await guide_chat(uuid.UUID(job_id_str), req, user=user)
            await websocket.send_json({"type": "guidance_ack", "job_id": job_id_str, "result": res})
        except Exception as exc:
            logger.warning("Guidance error: %s", exc)

    try:
        while True:
            raw_msg = await websocket.receive_text()
            if not raw_msg.strip():
                continue
            try:
                frame = json.loads(raw_msg)
            except Exception:
                continue

            action = frame.get("action")
            if action == "ping":
                await websocket.send_json({"type": "pong"})
            elif action in ("prompt", "submit", "cancel", "approval", "guidance"):
                try:
                    user = await current_user(websocket)
                except (HTTPException, Exception) as exc:
                    logger.warning("Session revoked or expired for user %s: %s", username, exc)
                    await websocket.close(code=1008)
                    break

                if action in ("prompt", "submit"):
                    await _handle_prompt(frame)
                elif action == "cancel":
                    await _handle_cancel(frame)
                elif action == "approval":
                    await _handle_approval(frame)
                elif action == "guidance":
                    await _handle_guidance(frame)
            else:
                logger.debug("Unknown gateway action received: %s", action)

    except WebSocketDisconnect:
        logger.info("Gateway WebSocket closed for user %s", username)
    except Exception as exc:
        logger.error("Gateway WebSocket error: %s", exc)
    finally:
        for task in active_streams.values():
            task.cancel()
        active_streams.clear()
