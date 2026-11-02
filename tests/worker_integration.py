"""Exercise a queued Bob stream with a fake Bob process."""
import asyncio
import json
import os
import tempfile
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from app import job_queue, worker
from app.sessions import append_history, create_session, read_history, user_root


async def quiz_clarification_roundtrip(directory):
    """Exercise real durable replies with a deterministic bridge, not a model."""
    username = "queuequizclarification"
    session_id = create_session(username)["id"]
    root = user_root(username) / "sessions" / session_id
    workspace = Path(directory) / "quiz-workspace"
    workspace.mkdir()
    vague = "Need a qa mutliple choice test"
    questions = "```bobquestion\n" + json.dumps([
        {"question": "What does QA mean and what subject should the test cover?",
         "options": ["Quality assurance", "Questions and answers"]},
        {"question": "Who will take the test and for what purpose?",
         "options": ["New staff training", "Experienced staff assessment"]},
    ]) + "\n```"
    answer = "QA means quality assurance. Test new staff on basic software quality for onboarding."
    quiz = '```bobquiz\n{"title":"Software quality onboarding","questions":[{"id":"q1","type":"single","question":"What is the purpose of testing?","options":["Find defects","Hide defects"],"answer":[0],"explanation":"Testing identifies defects."}]}\n```'
    captured = []
    jobs = []

    async def stream(prompt, *args, **kwargs):
        captured.append(prompt)
        # An artifact scaffold must not turn a valid clarification into a failed job.
        if len(captured) == 1:
            (workspace / "presentation.html").write_text("<html><body>unfinished")
        yield {"type": "start"}
        yield {"type": "delta", "text": questions if len(captured) == 1 else quiz}
        yield {"type": "done", "session_id": "quiz-test", "duration_ms": 5}

    try:
        with ExitStack() as mocks:
            mocks.enter_context(patch.object(worker.bridge, "stream_with_approvals", stream))
            mocks.enter_context(patch.object(worker.storage, "persist_job"))
            mocks.enter_context(patch.object(worker.storage, "list_files", return_value=[]))
            mocks.enter_context(patch.object(worker, "select_root"))
            mocks.enter_context(patch.object(worker, "list_skills", return_value=[]))
            mocks.enter_context(patch("app.personalization.personalize_prompt", side_effect=lambda prompt, user: prompt))
            mocks.enter_context(patch("app.workspace_config.ensure_brave_mcp"))
            mocks.enter_context(patch("app.conversation_documents.context_manifest", return_value=""))
            mocks.enter_context(patch("app.mcp_access.allowed_servers", return_value={}))
            mocks.enter_context(patch("app.mcp_access.catalog", return_value=[]))
            for request in (vague, answer):
                append_history(session_id, username, {"type": "request", "prompt": request})
                payload = {"prompt": request, "bob_prompt": "Use the selected template and create the finished artifact immediately.\n" + request,
                           "mode": "presentation", "presentation_format": "html", "template_id": "test-template",
                           "session_id": None, "approval_policy": {"mode": "all"}}
                job_id = job_queue.enqueue(username, session_id, str(root), payload)
                jobs.append(job_id)
                job = job_queue.claim(str(uuid.uuid4()))
                assert str(job["id"]) == job_id
                await worker._run_in_workspace(job, root, workspace)
                rows, status = job_queue.events_after(job_id, 0)
                assert status == "completed", (status, rows)
                assert not any(row["event"]["type"] == "error" for row in rows)
                history = read_history(session_id, username)
                assert history[-1]["type"] == "done", history
                assert history[-2]["text"] == (questions if request == vague else quiz)

        first, followup = captured
        assert vague in first
        assert "[Interactive clarification policy]" in first
        assert "This automated research/workflow cannot pause" not in first
        assert "Clarification forms may appear BEFORE authoring" in first
        assert "A selected visual template, mode, skill, or assistant preset" in first
        assert "subject/source" in first and "audience/purpose" in first
        assert not (workspace / "presentation.html").exists()
        assert (workspace / ".presentation.incomplete.html").is_file()
        assert answer in followup
        history_context = followup.split("[Previous turns from this conversation]", 1)[1]
        assert vague in history_context and "What does QA mean" in history_context
    finally:
        with job_queue._connect() as db:
            for job_id in jobs:
                db.execute("DELETE FROM bob_jobs WHERE id=%s", (job_id,))
    print("worker quiz clarification and answered follow-up integration passed")


async def fake_stream(*args, **kwargs):
    yield {"type": "start"}
    yield {"type": "delta", "text": "A completed reply"}
    yield {"type": "done", "session_id": "task-test", "duration_ms": 5}


async def main():
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BOB_WORKSPACE": directory, "BOB_S3_BUCKET": ""}):
        session_id = create_session("queueworker")["id"]
        root = user_root("queueworker") / "sessions" / session_id
        payload = {"prompt": "test", "bob_prompt": "test", "mode": "agent", "session_id": None,
                   "approval_policy": {"mode": "all"}}
        job_id = job_queue.enqueue("queueworker", session_id, str(root), payload)
        try:
            job = job_queue.claim(str(uuid.uuid4()))
            assert str(job["id"]) == job_id
            with patch.object(worker.bridge, "stream_with_approvals", fake_stream):
                await worker._run(job)
            rows, status = job_queue.events_after(job_id, 0)
            assert status == "completed"
            event_types = [row["event"]["type"] for row in rows]
            assert "start" in event_types and event_types[-2:] == ["delta", "done"], rows
            assert "error" not in event_types
            history = read_history(session_id, "queueworker")
            assert history[-1]["type"] == "done"
            assert history[-2]["text"] == "A completed reply"
        finally:
            with job_queue._connect() as db:
                db.execute("DELETE FROM bob_jobs WHERE id=%s", (job_id,))
        await quiz_clarification_roundtrip(directory)
    print("worker integration passed")


if __name__ == "__main__":
    asyncio.run(main())
