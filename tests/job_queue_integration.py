"""Run inside the app container against its disposable test jobs."""
import uuid

from app import job_queue


def main():
    workspace = "queue-test/" + uuid.uuid4().hex
    payload = {"prompt": "test", "bob_prompt": "test", "mode": "agent"}
    job = job_queue.enqueue("queue-test", "legacy", workspace, payload)
    second_workspace = workspace + "-second"
    try:
        try:
            job_queue.enqueue("queue-test", "legacy", workspace, payload)
            raise AssertionError("duplicate active workspace accepted")
        except ValueError:
            pass
        first = job_queue.claim(str(uuid.uuid4()))
        assert first and str(first["id"]) == job
        second = job_queue.enqueue("queue-test", "legacy", second_workspace, payload)
        assert job_queue.claim(str(uuid.uuid4())) is None
        assert job_queue.heartbeat(job, str(first["worker_token"]))
        assert job_queue.append_event(job, str(first["worker_token"]), {"type": "delta", "text": "hello"})
        assert job_queue.finish(job, str(first["worker_token"]), {"type": "done"})
        assert not job_queue.append_event(job, str(first["worker_token"]), {"type": "delta", "text": "late"})
        events, status = job_queue.events_after(job, 0)
        assert status == "completed"
        assert [row["event"]["type"] for row in events] == ["status", "status", "delta", "done"]
        second_claim = job_queue.claim(str(uuid.uuid4()))
        assert second_claim and str(second_claim["id"]) == second
        job_queue.finish(second, str(second_claim["worker_token"]), {"type": "done"})

        retried = job_queue.enqueue("queue-test", "legacy", workspace, payload)
        with job_queue._connect() as db:
            db.execute("UPDATE bob_jobs SET status='running', attempts=1, lease_until=now()-interval '1 second' WHERE id=%s", (retried,))
        job_queue.requeue_expired()
        assert job_queue.get_job(retried)["status"] == "failed"
        assert job_queue.get_job(retried)["max_attempts"] == 1
    finally:
        with job_queue._connect() as db:
            db.execute("DELETE FROM bob_jobs WHERE workspace_key=%s", (workspace,))
            db.execute("DELETE FROM bob_jobs WHERE workspace_key=%s", (second_workspace,))
    print("queue integration passed")


if __name__ == "__main__":
    main()
