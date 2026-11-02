"""Compose email from the UI and review content for personal data before it leaves."""
import logging
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app import smtp_settings
from app.auth import current_user
from app import privacy_policy
from app.personal_data import UNCHECKED, PersonalDataBlocked, PersonalDataFound

router = APIRouter(prefix='/api/email', tags=['email'])
security_log = logging.getLogger('security.personal_data')
MAX_SCAN_BYTES = 25 * 1024 * 1024


def send_reviewed(username, config, to, subject, body, *, confirmed=False, **options):
    """Send for a signed-in person, turning a finding into a decision they can make."""
    try:
        message = smtp_settings.send_message(config, to, subject, body, personal_data_confirmed=confirmed, **options)
    except PersonalDataBlocked as exc:
        raise HTTPException(403, {'code': 'personal_data_blocked', 'categories': exc.categories,
                                  'message': 'Your data protection policy does not allow sending this: ' + ', '.join(exc.categories)}) from None
    except PersonalDataFound as exc:
        raise HTTPException(409, {'code': 'personal_data', 'categories': exc.categories,
                                  'message': 'This email appears to contain personal data.'}) from None
    if confirmed:
        security_log.info('email_sent_after_personal_data_confirmation user=%r', username)
    return message


class ComposedEmail(BaseModel):
    to: str = Field(min_length=3, max_length=13000)
    subject: str = Field(min_length=1, max_length=998)
    body: str = Field(min_length=1, max_length=1024 * 1024)
    personal_data_confirmed: bool = False


@router.post('/send')
def send_email(body: ComposedEmail, user: dict = Depends(current_user)):
    try:
        message = send_reviewed(user['username'], smtp_settings.load_config(), body.to, body.subject, body.body,
                                confirmed=body.personal_data_confirmed)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {'message': message}


@router.post('/scan-file')
async def scan_generated_file(request: Request, user: dict = Depends(current_user)):
    """Review a file generated in the browser, which no server download route sees."""
    data = await request.body()
    if len(data) > MAX_SCAN_BYTES:
        blocked, ask = privacy_policy.decide([UNCHECKED], privacy_policy.load_policy())
    else:
        blocked, ask = await run_in_threadpool(privacy_policy.review_file, unquote(request.headers.get('x-file-name', '')), data,
                                               'download', media_type=request.headers.get('content-type', ''))
    return {'categories': ask, 'blocked': blocked}
