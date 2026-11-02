"""Administrator-owned shared SMTP sender. Secrets never appear in API responses."""
from app.branding import brand_name, brand_text
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from psycopg.types.json import Jsonb
from app.auth import _connect
from app.admin_users import administrator
from app.personal_data import PersonalDataFound

router = APIRouter(prefix='/admin/smtp', tags=['administration'])


def address(value: str) -> str:
    value = value.strip()
    if len(value) > 254 or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
        raise ValueError('Enter a valid email address')
    return value


class SMTPSettings(BaseModel):
    enabled: bool = False
    host: str = Field(default='', max_length=253)
    port: int = Field(default=587, ge=1, le=65535)
    security: Literal['starttls', 'tls', 'none'] = 'starttls'
    username: str = Field(default='', max_length=320)
    password: str = Field(default='', max_length=4096, repr=False)
    from_address: str = Field(default='', max_length=254)
    from_name: str = Field(default_factory=brand_name, max_length=200)

    @field_validator('host', 'username', 'from_address', 'from_name')
    @classmethod
    def safe_header(cls, value):
        if any(c in value for c in ('\r', '\n', '\x00')):
            raise ValueError('Line breaks are not allowed')
        return value.strip()

    @field_validator('host')
    @classmethod
    def valid_host(cls, value):
        if value and (any(c.isspace() for c in value) or any(c in value for c in '/:@')):
            raise ValueError('Enter a hostname or IPv4 address without a port or URL scheme')
        return value

    @model_validator(mode='after')
    def complete(self):
        if self.from_address:
            address(self.from_address)
        if self.enabled and (not self.host or not self.from_address):
            raise ValueError('Host and sender address are required to enable SMTP')
        return self


def ensure_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS bob_smtp_settings (id INTEGER PRIMARY KEY CHECK(id=1), config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())')


def load_config():
    with _connect() as db:
        ensure_schema(db)
        row = db.execute('SELECT config FROM bob_smtp_settings WHERE id=1').fetchone()
    return row[0] if row else SMTPSettings().model_dump()


def public_config(config):
    return {**{k: v for k, v in config.items() if k != 'password'}, 'password_configured': bool(config.get('password'))}


@router.get('')
def get_settings(user=Depends(administrator)):
    return public_config(load_config())


@router.put('')
def save_settings(body: SMTPSettings, user=Depends(administrator)):
    from app import mcp_access
    mcp_access.ensure_schema()
    with _connect() as db:
        ensure_schema(db)
        db.execute("SELECT pg_advisory_xact_lock(hashtext('smtp-settings'))")
        row = db.execute('SELECT config FROM bob_smtp_settings WHERE id=1').fetchone()
        config = body.model_dump()
        if not config['password'] and config['username'] and row and row[0].get('username') == config['username']:
            config['password'] = row[0].get('password', '')
        db.execute('INSERT INTO bob_smtp_settings(id,config) VALUES (1,%s) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,updated_at=now()', (Jsonb(config),))
        # Credentials live only in the settings table, never in assistant-facing MCP config.
        db.execute("INSERT INTO bob_mcp_registry(name,config) VALUES ('smtp',%s) ON CONFLICT(name) DO UPDATE SET config=EXCLUDED.config,deleted=false,updated_at=now()", (Jsonb({'command': 'python3', 'args': ['-m', 'app.mcp_smtp'], 'disabled': not config['enabled']}),))
        db.execute('INSERT INTO bob_access_audit(actor,action,target,details) VALUES (%s,%s,%s,%s)', (user['username'], 'configure-smtp', 'smtp', Jsonb(public_config(config))))
    return public_config(config)


def _review_personal_data(recipients, subject, body, markdown_attachment, attachments, confirmed):
    from app import privacy_policy
    blocked, ask = privacy_policy.review_email(subject, body, recipients, markdown_attachment, attachments)
    privacy_policy.raise_if_blocked(blocked)
    if ask and not confirmed:
        raise PersonalDataFound(ask)


def send_message(config, to, subject, body, is_html=False, *, markdown_attachment=None, attachments=None,
                 personal_data_confirmed=False, certificate_delivery=False):
    settings = SMTPSettings(**config)
    if not settings.enabled:
        raise ValueError('SMTP sending is disabled. Ask an administrator to enable it.')
    if not isinstance(to, str) or not isinstance(subject, str) or not isinstance(body, str):
        raise ValueError('Recipient, subject and body must be text')
    if not subject.strip() or len(subject) > 998 or any(c in subject for c in ('\r', '\n', '\x00')) or not body.strip() or len(body.encode('utf-8')) > 5 * 1024 * 1024:
        raise ValueError('Enter a subject without line breaks and a body under 5 MB')
    recipients = [address(item) for item in to.split(',')]
    if len(recipients) > 50:
        raise ValueError('At most 50 recipients are supported')
    message = EmailMessage()
    message['From'] = formataddr((settings.from_name, settings.from_address))
    message['To'] = ', '.join(recipients)
    message['Subject'] = subject
    message['Date'] = formatdate(localtime=False)
    message['Message-ID'] = make_msgid()
    message.set_content(body, subtype='html' if is_html else 'plain')
    if markdown_attachment is not None:
        filename, content = markdown_attachment
        if not filename.endswith(".md") or any(c in filename for c in ("\r", "\n", "\x00", "/", "\\")) or len(content.encode("utf-8")) > 5 * 1024 * 1024:
            raise ValueError("Invalid Markdown attachment")
        message.add_attachment(content, subtype="markdown", charset="utf-8", filename=filename)
    for item in attachments or ():
        filename, content, media_type = item
        if any(c in filename for c in ("\r", "\n", "\x00", "/", "\\")):
            raise ValueError("Invalid attachment filename")
        raw = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        if len(raw) > 5 * 1024 * 1024:
            raise ValueError("Attachment exceeds 5 MB limit")
        maintype, _, subtype = (media_type or "application/octet-stream").partition("/")
        message.add_attachment(raw, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=filename)
    # Every caller passes here. Confirmation answers "ask" rules only; a block always stands.
    if not certificate_delivery:
        _review_personal_data(recipients, subject, body, markdown_attachment, attachments, personal_data_confirmed)
    context = ssl.create_default_context()
    factory = smtplib.SMTP_SSL if settings.security == 'tls' else smtplib.SMTP
    kwargs = {'timeout': 20}
    if settings.security == 'tls':
        kwargs['context'] = context
    try:
        with factory(settings.host, settings.port, **kwargs) as client:
            client.ehlo()
            if settings.security == 'starttls':
                client.starttls(context=context)
                client.ehlo()
            if settings.username:
                client.login(settings.username, settings.password)
            refused = client.send_message(message, from_addr=settings.from_address, to_addrs=recipients)
        if refused:
            return 'SMTP accepted the message for some recipients but refused others. Do not resend automatically; check the mail server logs.'
    except smtplib.SMTPAuthenticationError:
        raise ValueError('SMTP authentication failed. Check the saved username and password.') from None
    except ssl.SSLError:
        raise ValueError('SMTP TLS verification failed. Check the server certificate and security mode.') from None
    except (OSError, smtplib.SMTPException):
        raise ValueError('SMTP could not complete sending. Check host, port, security and server logs before retrying; delivery may be uncertain.') from None
    return 'SMTP server accepted the email for delivery.'


class TestEmail(BaseModel):
    to: str = Field(max_length=254)

    @field_validator('to')
    @classmethod
    def valid_address(cls, value):
        return address(value)


@router.post('/test')
def test_email(body: TestEmail, user=Depends(administrator)):
    try:
        return {'message': send_message(load_config(), body.to, brand_text('Buddy SMTP test'), brand_text('Your SMTP settings can submit email from Buddy.'))}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
