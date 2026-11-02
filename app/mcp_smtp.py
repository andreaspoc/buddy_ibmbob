"""SMTP sending over the authenticated MCP broker; no credentials in tool arguments."""
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
import os
from app.personal_data import APPROVAL_KEY_ENV, approval_valid
from app.smtp_settings import load_config, send_message

mcp = FastMCP('Platform SMTP')


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True))
def smtp_send_email(to: str, subject: str, body: str, is_html: bool = False, personal_data_approval: str = '') -> str:
    """Send email from the administrator-configured shared platform address.

    Use only when the user requests sending. Recipients are comma-separated email
    addresses. Acceptance by SMTP does not confirm delivery. Never automatically
    retry an uncertain or partially accepted submission. Leave personal_data_approval
    empty; the platform sets it after the user reviews personal data in the email.
    """
    try:
        confirmed = approval_valid(os.environ.get(APPROVAL_KEY_ENV), personal_data_approval, to, subject, body, is_html)
        return send_message(load_config(), to, subject, body, is_html, personal_data_confirmed=confirmed)
    except ValueError as exc:
        raise ToolError(str(exc)) from None
    except Exception:
        raise ToolError('SMTP could not complete the request. Ask an administrator to check the settings and server logs before retrying.') from None


if __name__ == '__main__':
    mcp.run(transport='stdio')
