"""Optional Office Suite/S3 archive for personal conversation files.

Buddy works on local files. Completed files are mirrored to S3; an operator can
later evict verified copies from inactive personal sessions.
"""
from __future__ import annotations

import os
import json
import hashlib
from pathlib import Path
from botocore.exceptions import ClientError


def enabled() -> bool:
    return bool(os.getenv("BOB_S3_BUCKET"))


def personal_session(username: str, session_id: str) -> bool:
    if session_id == "legacy":
        return False
    from app.sessions import session_storage
    metadata = session_storage(session_id, username) / ".conversation.json"
    return not (metadata.is_file() and json.loads(metadata.read_text()).get("project_id"))


def _client():
    from app.s3_client import client
    return client()


def _prefix(username: str, session_id: str) -> str:
    from app.sessions import _VALID_ID, _VALID_USER
    if not _VALID_USER.fullmatch(username) or not _VALID_ID.fullmatch(session_id):
        raise ValueError("Invalid object storage identity")
    return f"users/{username}/sessions/{session_id}/files/"


def _conversation_prefix(username: str, session_id: str) -> str:
    return _prefix(username, session_id).removesuffix("files/")


def _relative(root: Path, path: Path) -> str:
    resolved = path.resolve()
    if not resolved.is_file() or not resolved.is_relative_to(root.resolve()) or path.is_symlink():
        raise ValueError("File is outside the conversation workspace")
    relative = path.relative_to(root).as_posix()
    if relative.endswith(".s3-download") or any(part.startswith(".") or part in {"node_modules", "__pycache__"} for part in Path(relative).parts):
        raise ValueError("Private or generated path cannot be archived")
    return relative


def _key(username: str, session_id: str, relative: str) -> str:
    if not relative or Path(relative).is_absolute() or any(p in {"", ".", ".."} or p.startswith(".") for p in Path(relative).parts):
        raise ValueError("Invalid archive path")
    return _prefix(username, session_id) + Path(relative).as_posix()


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _mark_backed(username: str, session_id: str) -> None:
    from app.sessions import session_storage
    (session_storage(session_id, username) / ".s3-backed").touch(exist_ok=True)


def upload_file(username: str, session_id: str, root: Path, path: Path) -> None:
    if not enabled() or not personal_session(username, session_id):
        return
    relative = _relative(root, path)
    client = _client()
    bucket = os.environ["BOB_S3_BUCKET"]
    key = _key(username, session_id, relative)
    digest = _digest(path)
    try:
        head = client.head_object(Bucket=bucket, Key=key)
        if head["ContentLength"] == path.stat().st_size and head.get("Metadata", {}).get("sha256") == digest:
            _mark_backed(username, session_id)
            return
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey"}:
            raise
    client.upload_file(str(path), bucket, key, ExtraArgs={"Metadata": {"sha256": digest}})
    _mark_backed(username, session_id)


def sync_workspace(username: str, session_id: str, root: Path) -> int:
    """Mirror visible regular files; leave active local copies in place."""
    if not enabled() or not personal_session(username, session_id):
        return 0
    count = 0
    for path in root.rglob("*"):
        try:
            upload_file(username, session_id, root, path)
        except ValueError:
            continue
        count += 1
    return count


def backup_history(username: str, session_id: str, root: Path) -> None:
    if not enabled() or not personal_session(username, session_id):
        return
    history = root / ".history.jsonl"
    if not history.is_file():
        return
    client = _client()
    bucket = os.environ["BOB_S3_BUCKET"]
    key = _prefix(username, session_id) + "history.jsonl"
    digest = _digest(history)
    try:
        head = client.head_object(Bucket=bucket, Key=key)
        if head["ContentLength"] == history.stat().st_size and head.get("Metadata", {}).get("sha256") == digest:
            _mark_backed(username, session_id)
            return
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey"}:
            raise
    client.upload_file(str(history), bucket, key, ExtraArgs={"Metadata": {"sha256": digest}})
    _mark_backed(username, session_id)


def restore_history(username: str, session_id: str, root: Path) -> None:
    if not enabled() or not personal_session(username, session_id):
        return
    history = root / ".history.jsonl"
    if history.exists():
        return
    key = _prefix(username, session_id) + "history.jsonl"
    temporary = root / ".history.s3-download"
    try:
        _client().download_file(os.environ["BOB_S3_BUCKET"], key, str(temporary))
        head = _client().head_object(Bucket=os.environ["BOB_S3_BUCKET"], Key=key)
        expected = head.get("Metadata", {}).get("sha256")
        if expected and _digest(temporary) != expected:
            raise OSError("Conversation history checksum mismatch")
        temporary.replace(history)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey"}:
            raise
    finally:
        temporary.unlink(missing_ok=True)


def list_objects(username: str, session_id: str) -> list[dict]:
    if not enabled() or not personal_session(username, session_id):
        return []
    prefix = _prefix(username, session_id)
    result = []
    paginator = _client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=os.environ["BOB_S3_BUCKET"], Prefix=prefix):
        for item in page.get("Contents", []):
            relative = item["Key"][len(prefix):]
            if relative:
                result.append({"path": relative, "size": item["Size"], "modified": int(item["LastModified"].timestamp() * 1e9)})
    return result


def restore_file(username: str, session_id: str, root: Path, relative: str) -> Path | None:
    if not enabled() or not personal_session(username, session_id):
        return None
    key = _key(username, session_id, relative)
    target = root / relative
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Invalid archive path")
    if target.is_file():
        return target
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".s3-download")
        _client().download_file(os.environ["BOB_S3_BUCKET"], key, str(temporary))
        head = _client().head_object(Bucket=os.environ["BOB_S3_BUCKET"], Key=key)
        expected = head.get("Metadata", {}).get("sha256")
        if expected and _digest(temporary) != expected:
            temporary.unlink(missing_ok=True)
            raise OSError("Object storage checksum mismatch")
        temporary.replace(target)
        return target
    except ClientError as exc:
        temporary.unlink(missing_ok=True)
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey"}:
            return None
        raise


def restore_workspace(username: str, session_id: str, root: Path) -> int:
    count = 0
    for item in list_objects(username, session_id):
        if not (root / item["path"]).exists() and restore_file(username, session_id, root, item["path"]):
            count += 1
    return count


def evict_verified_file(username: str, session_id: str, root: Path, path: Path) -> bool:
    """Remove one local copy only after a matching size exists in S3."""
    relative = _relative(root, path)
    head = _client().head_object(Bucket=os.environ["BOB_S3_BUCKET"], Key=_key(username, session_id, relative))
    if head["ContentLength"] != path.stat().st_size or head.get("Metadata", {}).get("sha256") != _digest(path):
        return False
    path.unlink()
    return True


def delete_conversation_objects(username: str, session_id: str) -> int:
    """Permanently remove current objects, prior versions, and delete markers."""
    if not enabled():
        return 0
    prefix = _conversation_prefix(username, session_id)
    bucket = os.environ["BOB_S3_BUCKET"]
    client = _client()
    count = 0

    def delete_batch(objects: list[dict]) -> None:
        nonlocal count
        for start in range(0, len(objects), 1000):
            batch = objects[start:start + 1000]
            response = client.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
            if response.get("Errors"):
                raise OSError(f"Object storage rejected deletion of {len(response['Errors'])} objects")
            count += len(batch)

    # Version listing is required even when versioning is currently disabled:
    # a bucket may have been versioned earlier and still retain old copies.
    paginator = client.get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        batch = []
        for item in page.get("Versions", []) + page.get("DeleteMarkers", []):
            if not item["Key"].startswith(prefix):
                continue
            version_id = item.get("VersionId")
            entry = {"Key": item["Key"]}
            if version_id is not None:
                entry["VersionId"] = version_id
            batch.append(entry)
        delete_batch(batch)

    # Catch current objects in non-versioned or suspended buckets.
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        delete_batch([{"Key": item["Key"]} for item in page.get("Contents", []) if item["Key"].startswith(prefix)])

    remaining = client.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=1)
    if remaining.get("Versions") or remaining.get("DeleteMarkers"):
        raise OSError("Object storage still has conversation versions")
    if client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1).get("Contents"):
        raise OSError("Object storage still has conversation files")
    return count
