"""Request identity and canonical request hashing for safe chat retries."""
import hashlib
import json


def fingerprint(values):
    ignored = {'correlation_id', 'user_message_id', 'assistant_message_id', 'idempotency_key'}
    canonical = {key: value for key, value in values.items() if key not in ignored}
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


class SubmissionResult(str):
    def __new__(cls, job_id, payload, reused=False):
        result = super().__new__(cls, str(job_id))
        result.payload = payload
        result.reused = reused
        return result
