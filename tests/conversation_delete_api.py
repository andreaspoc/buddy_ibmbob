"""Exercise authenticated delete, ownership, and active-job protection."""
import os
import tempfile
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.auth import current_user
from app.main import app
from app.sessions import create_session
from app import job_queue


def main():
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BOB_WORKSPACE": directory, "BOB_S3_BUCKET": ""}):
        own = create_session("deleteowner")["id"]
        other = create_session("deleteother")["id"]
        app.dependency_overrides[current_user] = lambda: {"username": "deleteowner", "is_admin": False}
        try:
            with TestClient(app) as client:
                assert client.delete(f"/sessions/{other}").status_code == 404
                workspace = directory + "/users/deleteowner/sessions/" + own
                job_id = str(uuid.uuid4())
                job_queue.ensure_schema()
                with job_queue._connect() as db:
                    db.execute("""INSERT INTO bob_jobs
                        (id,username,workspace_id,workspace_key,payload,status,worker_token,lease_until)
                        VALUES (%s,%s,%s,%s,'{}'::jsonb,'running',%s,now()+interval '1 hour')""",
                        (job_id, "deleteowner", own, workspace, str(uuid.uuid4())))
                try:
                    assert client.delete(f"/sessions/{own}").status_code == 409
                finally:
                    with job_queue._connect() as db:
                        db.execute("DELETE FROM bob_jobs WHERE id=%s", (job_id,))
                response = client.delete(f"/sessions/{own}")
                assert response.status_code == 200, response.text
                assert response.json()["deleted"]
                assert client.get(f"/sessions/{own}/history").status_code == 404
        finally:
            app.dependency_overrides.clear()
            with job_queue._connect() as db:
                db.execute("DELETE FROM bob_deleted_conversations WHERE username=%s", ("deleteowner",))
    print("conversation delete API passed")


if __name__ == "__main__":
    main()
