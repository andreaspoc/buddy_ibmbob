"""Permission policy and durable human decisions for a single job action."""
from app.branding import brand_text
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict

Action = Literal['commands', 'files', 'dependencies', 'messages', 'external', 'publish']

class ApprovalPolicy(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: Literal['auto', 'selected'] = 'auto'
    actions: list[Action] = Field(default_factory=list)


def review_required(policy: dict, tool: dict) -> bool:
    if policy.get('mode', 'auto') == 'auto':
        return False
    if policy.get('mode') != 'selected':
        return True
    kind = tool.get('kind')
    if kind in {'read', 'search', 'think'}:
        return False
    if kind in {'edit', 'delete', 'move'}:
        return 'files' in policy.get('actions', [])
    # Executables and external tools can affect multiple categories. Review
    # conservatively whenever the user has selected any review category.
    return bool(policy.get('actions', []))


def once_option(options: list[dict]) -> str | None:
    return next((option.get('optionId', option.get('option_id')) for option in options
                 if option.get('kind') == 'allow_once'), None)


def runtime_supported(payload: dict) -> tuple[bool, str | None]:
    if payload.get('agent_name'):
        return False, brand_text('Remote agents cannot enforce Buddy approval policies.')
    if payload.get('workflow') or payload.get('research'):
        return False, 'Runtime approval changes are unavailable for research and workflow runs.'
    if payload.get('approval_runtime') != 'acp':
        return False, 'This task started before runtime approval controls were enabled. Start a new task to use them.'
    return True, None


def policy_state(job: dict) -> dict:
    payload = job['payload']
    supported, reason = runtime_supported(payload)
    active = job['status'] in {'queued', 'running'} and not payload.get('cancel_requested')
    return {'policy': payload.get('approval_policy', {'mode': 'auto', 'actions': []}),
            'revision': payload.get('approval_policy_revision', 0),
            'mutable': supported and active,
            'reason': reason if not supported else None if active else 'This task has finished or is stopping.'}
