"""Microsoft 365 & Graph Model Context Protocol (MCP) Server for Buddy ACP.

Provides tools for Outlook Mail, Calendar, and OneDrive files over stdio.
Credentials and tokens are loaded from the user's workspace ~/.bob/tokens/microsoft.json.
"""

from __future__ import annotations

from app.branding import brand_text
import json
import os
import sys
import time
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import quote
from typing import Any
import httpx
from app import personal_data
from app import postgres_storage as storage
from app.business_connectors import business_tools


GRAPH_BASE = os.getenv("GRAPH_API_BASE", "https://graph.microsoft.com/v1.0").rstrip("/")
DEFAULT_TIMEZONE = os.getenv("DEFAULT_TIMEZONE", "UTC")


def _log(msg: str) -> None:
    sys.stderr.write(f"[mcp_microsoft] {msg}\n")
    sys.stderr.flush()


def _get_token_file() -> Path:
    if os.getenv('BOB_MICROSOFT_TOKEN_FILE'):
        return Path(os.environ['BOB_MICROSOFT_TOKEN_FILE'])
    home_dir = Path(os.environ.get("HOME", "/root")).resolve()
    return home_dir / ".bob" / "tokens" / "microsoft.json"


def _load_and_refresh_token(token_file: Path | None = None) -> dict[str, Any] | None:
    token_file = token_file or _get_token_file()
    content = storage.read_user_file(token_file)
    if content is None:
        return None
    try:
        data = json.loads(content)
    except Exception as exc:
        _log(f"Error reading token file: {exc}")
        return None

    # Check if access token is expired (or expires within 90 seconds)
    expires_at = data.get("expires_at", 0)
    now = time.time()
    if now + 90 >= expires_at and data.get("refresh_token"):
        # Refresh the token
        client_id = data.get("client_id") or os.environ.get("AZURE_CLIENT_ID")
        client_secret = os.environ.get("AZURE_CLIENT_SECRET")
        tenant_id = data.get("tenant_id") or os.environ.get("AZURE_TENANT_ID", "common")

        if client_id:
            try:
                _log("Access token expired or expiring soon; refreshing...")
                token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
                form_data = {
                    "client_id": client_id,
                    "grant_type": "refresh_token",
                    "refresh_token": data["refresh_token"],
                }
                if client_secret:
                    form_data["client_secret"] = client_secret

                with httpx.Client(timeout=15.0) as client:
                    resp = client.post(token_url, data=form_data)
                    if resp.status_code == 200:
                        new_token_data = resp.json()
                        data["access_token"] = new_token_data["access_token"]
                        if "refresh_token" in new_token_data:
                            data["refresh_token"] = new_token_data["refresh_token"]
                        data["expires_at"] = now + new_token_data.get("expires_in", 3600)
                        if 'scope' in new_token_data:
                            data['scope'] = new_token_data['scope']
                        storage.write_user_file(token_file, json.dumps(data).encode("utf-8"))
                        _log("Token refreshed successfully")
                    else:
                        _log(f"Failed to refresh token: {resp.status_code} {resp.text}")
            except Exception as exc:
                _log(f"Exception while refreshing token: {exc}")

    return data


def _graph_request(method: str, endpoint: str, **kwargs: Any) -> tuple[int, Any]:
    token_data = _load_and_refresh_token()
    if not token_data or not token_data.get("access_token"):
        raise PermissionError(
            brand_text("Microsoft account is not connected. Please click 'Connect Microsoft 365' in the Buddy ACP UI.")
        )

    url = endpoint if endpoint.startswith("http") else f"{GRAPH_BASE}/{endpoint.lstrip('/')}"
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token_data['access_token']}"
    headers.setdefault("Accept", "application/json")

    with httpx.Client(timeout=25.0) as client:
        resp = client.request(method, url, headers=headers, **kwargs)
        if resp.status_code == 204:
            return 204, {}
        try:
            return resp.status_code, resp.json()
        except Exception:
            return resp.status_code, resp.text


# Tool Implementations
def tool_get_me(_args: dict[str, Any]) -> str:
    status, data = _graph_request("GET", "/me")
    if status != 200:
        return f"Error getting user profile: {data}"
    return json.dumps({
        "displayName": data.get("displayName"),
        "email": data.get("mail") or data.get("userPrincipalName"),
        "id": data.get("id"),
        "jobTitle": data.get("jobTitle"),
        "officeLocation": data.get("officeLocation"),
    }, indent=2)


def tool_list_emails(args: dict[str, Any]) -> str:
    top = min(max(int(args.get("top", 10)), 1), 50)
    query = args.get("query", "").strip()
    unread_only = bool(args.get("unread_only", False))
    folder = args.get("folder", "inbox").strip()

    params: dict[str, str] = {
        "$top": str(top),
        "$select": "id,subject,from,receivedDateTime,bodyPreview,isRead",
    }
    if query:
        params["$search"] = f'"{query}"'
    if unread_only:
        params["$filter"] = "isRead eq false"

    endpoint = f"/me/mailFolders/{folder}/messages"
    status, data = _graph_request("GET", endpoint, params=params)
    if status != 200:
        return f"Error fetching emails from folder '{folder}': {data}"

    messages = data.get("value", [])
    if not messages:
        return "No emails found matching criteria."

    result = []
    for msg in messages:
        sender = msg.get("from", {}).get("emailAddress", {})
        result.append({
            "id": msg.get("id"),
            "subject": msg.get("subject", "(No Subject)"),
            "from": f"{sender.get('name', '')} <{sender.get('address', '')}>".strip(),
            "date": msg.get("receivedDateTime"),
            "isRead": msg.get("isRead"),
            "preview": msg.get("bodyPreview", "")[:200],
        })
    return json.dumps(result, indent=2)


def _require_personal_data_review(args: dict[str, Any]) -> None:
    from app import privacy_policy
    content = {key: value for key, value in args.items() if key != "personal_data_approval"}
    blocked, ask = privacy_policy.review_arguments(content, "email")
    if blocked:
        raise PermissionError(str(personal_data.PersonalDataBlocked(blocked)))
    if ask and not personal_data.approval_valid(
            os.environ.get(personal_data.APPROVAL_KEY_ENV), args.get("personal_data_approval"),
            args.get("to"), args.get("subject"), args.get("body"), bool(args.get("is_html", False))):
        raise PermissionError(str(personal_data.PersonalDataFound(ask)))


def tool_send_email(args: dict[str, Any]) -> str:
    to = args.get("to", "").strip()
    subject = args.get("subject", "").strip()
    body = args.get("body", "").strip()
    is_html = bool(args.get("is_html", False))

    if not to or not subject or not body:
        return "Error: 'to', 'subject', and 'body' are required to send an email."
    _require_personal_data_review(args)

    recipients = [{"emailAddress": {"address": addr.strip()}} for addr in to.split(",") if addr.strip()]
    payload = {
        "message": {
            "subject": subject,
            "body": {
                "contentType": "HTML" if is_html else "Text",
                "content": body,
            },
            "toRecipients": recipients,
        },
        "saveToSentItems": True,
    }

    status, data = _graph_request("POST", "/me/sendMail", json=payload)
    if status in (200, 202, 204):
        return f"Email successfully sent to {to} with subject '{subject}'."
    return f"Error sending email: {data}"


def tool_list_calendar_events(args: dict[str, Any]) -> str:
    days_ahead = int(args.get("days_ahead", 7))
    top = min(max(int(args.get("top", 15)), 1), 50)

    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)

    params = {
        "startDateTime": now.isoformat(),
        "endDateTime": end.isoformat(),
        "$top": str(top),
        "$select": "id,subject,start,end,location,organizer,isAllDay,webLink",
    }

    status, data = _graph_request("GET", "/me/calendarView", params=params)
    if status != 200:
        return f"Error fetching calendar events: {data}"

    events = data.get("value", [])
    if not events:
        return f"No calendar events found for the next {days_ahead} days."

    result = []
    for ev in events:
        result.append({
            "id": ev.get("id"),
            "subject": ev.get("subject", "(No Title)"),
            "start": ev.get("start", {}).get("dateTime"),
            "end": ev.get("end", {}).get("dateTime"),
            "timeZone": ev.get("start", {}).get("timeZone"),
            "location": ev.get("location", {}).get("displayName", ""),
            "organizer": ev.get("organizer", {}).get("emailAddress", {}).get("name", ""),
            "link": ev.get("webLink"),
        })
    return json.dumps(result, indent=2)


def tool_create_calendar_event(args: dict[str, Any]) -> str:
    subject = args.get("subject", "").strip()
    start_time = args.get("start_time", "").strip()
    end_time = args.get("end_time", "").strip()
    location = args.get("location", "").strip()
    body = args.get("body", "").strip()
    attendees_str = args.get("attendees", "").strip()

    if not subject or not start_time or not end_time:
        return "Error: 'subject', 'start_time', and 'end_time' are required."

    payload: dict[str, Any] = {
        "subject": subject,
        "start": {"dateTime": start_time, "timeZone": "UTC"},
        "end": {"dateTime": end_time, "timeZone": "UTC"},
    }
    if location:
        payload["location"] = {"displayName": location}
    if body:
        payload["body"] = {"contentType": "Text", "content": body}
    if attendees_str:
        payload["attendees"] = [
            {"emailAddress": {"address": a.strip()}, "type": "required"}
            for a in attendees_str.split(",") if a.strip()
        ]

    status, data = _graph_request("POST", "/me/events", json=payload)
    if status in (200, 201):
        return f"Calendar event '{subject}' created successfully from {start_time} to {end_time}."
    return f"Error creating calendar event: {data}"


def tool_list_files(args: dict[str, Any]) -> str:
    folder_path = args.get("folder_path", "").strip()
    top = min(max(int(args.get("top", 25)), 1), 100)

    if folder_path:
        endpoint = f"/me/drive/root:/{folder_path.strip('/')}:/children"
    else:
        endpoint = "/me/drive/root/children"

    status, data = _graph_request("GET", endpoint, params={"$top": str(top)})
    if status != 200:
        return f"Error listing OneDrive files: {data}"

    items = data.get("value", [])
    if not items:
        return "No files or folders found."

    result = []
    for item in items:
        result.append({
            "name": item.get("name"),
            "id": item.get("id"),
            "isFolder": "folder" in item,
            "sizeBytes": item.get("size"),
            "lastModified": item.get("lastModifiedDateTime"),
            "webUrl": item.get("webUrl"),
        })
    return json.dumps(result, indent=2)


def tool_search_files(args: dict[str, Any]) -> str:
    query = args.get("query", "").strip()
    top = min(max(int(args.get("top", 10)), 1), 50)
    if not query:
        return "Error: 'query' parameter is required to search files."

    status, data = _graph_request("GET", f"/me/drive/root/search(q='{query}')", params={"$top": str(top)})
    if status != 200:
        return f"Error searching OneDrive files: {data}"

    items = data.get("value", [])
    if not items:
        return f"No files found matching '{query}'."

    result = []
    for item in items:
        result.append({
            "name": item.get("name"),
            "id": item.get("id"),
            "isFolder": "folder" in item,
            "sizeBytes": item.get("size"),
            "lastModified": item.get("lastModifiedDateTime"),
            "webUrl": item.get("webUrl"),
        })
    return json.dumps(result, indent=2)


def tool_read_spreadsheet(args: dict[str, Any]) -> str:
    from app.spreadsheet_utils import summarize_spreadsheet
    file_path_str = args.get("file_path", "").strip()
    if not file_path_str:
        return "Error: 'file_path' is required (e.g. 'sales.xlsx' or 'data.csv')."
    
    path = Path(file_path_str)
    if not path.is_file():
        cwd_path = Path.cwd() / file_path_str
        if cwd_path.is_file():
            path = cwd_path
        else:
            return f"Error: File '{file_path_str}' not found in current directory ({Path.cwd()})."

    max_rows = int(args.get("max_rows", 50))
    summary = summarize_spreadsheet(path, max_preview_rows=max_rows)
    return json.dumps(summary, indent=2, ensure_ascii=False)


def tool_excel_read_range(args: dict[str, Any]) -> str:
    """Read data from an Excel workbook on OneDrive via Graph API."""
    file_path = args.get("file_path", "").strip()
    sheet_name = args.get("sheet_name", "").strip()
    range_address = args.get("range_address", "").strip()

    if not file_path:
        return "Error: 'file_path' on OneDrive is required (e.g. 'Documents/Budget.xlsx')."

    if sheet_name:
        if range_address:
            endpoint = f"/me/drive/root:/{file_path.strip('/')}:/workbook/worksheets('{sheet_name}')/range(address='{range_address}')"
        else:
            endpoint = f"/me/drive/root:/{file_path.strip('/')}:/workbook/worksheets('{sheet_name}')/usedRange"
    else:
        endpoint = f"/me/drive/root:/{file_path.strip('/')}:/workbook/worksheets/usedRange"

    status, data = _graph_request("GET", endpoint)
    if status != 200:
        return f"Error reading Excel range from OneDrive: {data}"

    values = data.get("values", [])
    address = data.get("address", "")
    return json.dumps({
        "address": address,
        "rowCount": data.get("rowCount", len(values)),
        "columnCount": data.get("columnCount", len(values[0]) if values else 0),
        "values": values,
    }, indent=2)


def tool_download_onedrive_file(args: dict[str, Any]) -> str:
    """Download a file from OneDrive into the local workspace."""
    onedrive_path = args.get("onedrive_path", "").strip()
    local_name = args.get("local_filename", "").strip() or Path(onedrive_path).name

    if not onedrive_path:
        return "Error: 'onedrive_path' is required."

    token_data = _load_and_refresh_token()
    if not token_data or not token_data.get("access_token"):
        raise PermissionError("Microsoft account is not connected.")

    url = f"{GRAPH_BASE}/me/drive/root:/{onedrive_path.strip('/')}:/content"
    headers = {"Authorization": f"Bearer {token_data['access_token']}"}

    with httpx.Client(timeout=45.0, follow_redirects=True) as client:
        resp = client.get(url, headers=headers)
        if resp.status_code != 200:
            return f"Error downloading OneDrive file: {resp.status_code} {resp.text}"
        
        dest = Path.cwd() / local_name
        dest.write_bytes(resp.content)
        return f"File successfully downloaded to local workspace: {dest.name} ({len(resp.content)} bytes)."


def tool_upload_onedrive_file(args: dict[str, Any]) -> str:
    """Upload a local workspace file to OneDrive."""
    local_file = args.get("local_file", "").strip()
    onedrive_folder = args.get("onedrive_folder", "").strip()

    if not local_file:
        return "Error: 'local_file' path is required."

    local_path = Path(local_file)
    if not local_path.is_file():
        local_path = Path.cwd() / local_file
        if not local_path.is_file():
            return f"Error: Local file '{local_file}' not found."

    filename = local_path.name
    if onedrive_folder:
        endpoint = f"/me/drive/root:/{onedrive_folder.strip('/')}/{filename}:/content"
    else:
        endpoint = f"/me/drive/root:/{filename}:/content"

    token_data = _load_and_refresh_token()
    if not token_data or not token_data.get("access_token"):
        raise PermissionError("Microsoft account is not connected.")

    url = f"{GRAPH_BASE}{endpoint}"
    headers = {
        "Authorization": f"Bearer {token_data['access_token']}",
        "Content-Type": "application/octet-stream",
    }

    with httpx.Client(timeout=45.0) as client:
        resp = client.put(url, headers=headers, content=local_path.read_bytes())
        if resp.status_code in (200, 201):
            return f"File '{filename}' successfully uploaded to OneDrive: {endpoint}."
        return f"Error uploading to OneDrive: {resp.status_code} {resp.text}"


TOOLS_REGISTRY = {
    "read_spreadsheet": {
        "func": tool_read_spreadsheet,
        "description": "Read, inspect, and parse a local CSV or Excel (.xlsx) file in the workspace. Returns sheet names, headers, row count, and formatted data.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Filename or path (e.g. 'sales.xlsx' or 'data.csv')"},
                "max_rows": {"type": "integer", "description": "Max rows to preview (default 50)", "default": 50},
            },
            "required": ["file_path"],
        },
    },
    "microsoft_excel_read_range": {
        "func": tool_excel_read_range,
        "description": "Read cell values or used range from an Excel file on Microsoft OneDrive.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to Excel file on OneDrive (e.g. 'Documents/Budget.xlsx')"},
                "sheet_name": {"type": "string", "description": "Optional worksheet name"},
                "range_address": {"type": "string", "description": "Optional cell range (e.g. 'A1:E20')"},
            },
            "required": ["file_path"],
        },
    },
    "microsoft_download_onedrive_file": {
        "func": tool_download_onedrive_file,
        "description": "Download a file from OneDrive into the local workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "onedrive_path": {"type": "string", "description": "Path on OneDrive (e.g. 'Reports/Q3.xlsx')"},
                "local_filename": {"type": "string", "description": "Optional local filename to save as"},
            },
            "required": ["onedrive_path"],
        },
    },
    "microsoft_upload_onedrive_file": {
        "func": tool_upload_onedrive_file,
        "description": "Upload a local workspace file to OneDrive.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "local_file": {"type": "string", "description": "Local file path (e.g. 'report.xlsx')"},
                "onedrive_folder": {"type": "string", "description": "Optional destination folder on OneDrive"},
            },
            "required": ["local_file"],
        },
    },
    "microsoft_get_me": {
        "func": tool_get_me,
        "description": "Get profile details of the connected Microsoft 365 account user.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    "microsoft_list_emails": {
        "func": tool_list_emails,
        "description": "Search or list recent Outlook emails with optional query, unread filter, and folder name.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keyword for subject or content"},
                "top": {"type": "integer", "description": "Number of emails to return (default 10, max 50)", "default": 10},
                "unread_only": {"type": "boolean", "description": "Only return unread emails", "default": False},
                "folder": {"type": "string", "description": "Mail folder name (default 'inbox')", "default": "inbox"},
            },
        },
    },
    "microsoft_send_email": {
        "func": tool_send_email,
        "description": "Send an email from the user's Outlook account.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email address(es), comma-separated"},
                "subject": {"type": "string", "description": "Email subject line"},
                "body": {"type": "string", "description": "Email body content"},
                "is_html": {"type": "boolean", "description": "True if body contains HTML tags", "default": False},
            },
            "required": ["to", "subject", "body"],
        },
    },
    "microsoft_list_calendar_events": {
        "func": tool_list_calendar_events,
        "description": "List upcoming Outlook calendar meetings and events for the user.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "description": "Number of days ahead to search (default 7)", "default": 7},
                "top": {"type": "integer", "description": "Maximum number of events to return (default 15)", "default": 15},
            },
        },
    },
    "microsoft_create_calendar_event": {
        "func": tool_create_calendar_event,
        "description": "Schedule a new meeting or event in the user's Outlook Calendar.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "Event subject / meeting title"},
                "start_time": {"type": "string", "description": "Start datetime in ISO format (e.g. '2026-10-01T14:00:00')"},
                "end_time": {"type": "string", "description": "End datetime in ISO format (e.g. '2026-10-01T15:00:00')"},
                "location": {"type": "string", "description": "Meeting location or link"},
                "body": {"type": "string", "description": "Meeting agenda or description"},
                "attendees": {"type": "string", "description": "Comma-separated attendee email addresses"},
            },
            "required": ["subject", "start_time", "end_time"],
        },
    },
    "microsoft_list_files": {
        "func": tool_list_files,
        "description": "List files and folders in OneDrive root or a specified subfolder.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_path": {"type": "string", "description": "Subfolder path (e.g. 'Documents' or leave empty for root)"},
                "top": {"type": "integer", "description": "Max items to return (default 25)", "default": 25},
            },
        },
    },
    "microsoft_search_files": {
        "func": tool_search_files,
        "description": "Search files in OneDrive by filename or content keyword.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query keyword"},
                "top": {"type": "integer", "description": "Max search results (default 10)", "default": 10},
            },
            "required": ["query"],
        },
    },
}


def tool_download_sharepoint_file(args: dict[str, Any]) -> str:
    """Read through Graph on every call; keep the downloaded file private."""
    drive_id = str(args.get('drive_id', '')).strip()
    item_id = str(args.get('item_id', '')).strip()
    if not drive_id or not item_id or max(len(drive_id), len(item_id)) > 512:
        raise ValueError('drive_id and item_id are required (maximum 512 characters each).')
    endpoint = f"/drives/{quote(drive_id, safe='')}/items/{quote(item_id, safe='')}"
    status, item = _graph_request('GET', endpoint, params={'$select': 'id,name,size,webUrl,file'})
    if status in (401, 403):
        raise PermissionError('Microsoft denied access to this file. Reconnect or request access from its owner.')
    if status != 200 or not isinstance(item, dict) or 'file' not in item:
        raise ValueError('The Microsoft file is unavailable.')
    limit = 20 * 1024 * 1024
    if int(item.get('size', 0)) > limit:
        raise ValueError('Choose a Microsoft file no larger than 20 MB.')
    name = str(args.get('local_filename') or item.get('name') or 'document').strip()
    if name != Path(name).name or name in {'.', '..'} or '/' in name or '\\' in name:
        raise ValueError('local_filename must be a filename within the current workspace.')
    dest = Path.cwd() / name
    if dest.exists() or dest.is_symlink():
        raise ValueError('That workspace filename already exists. Choose a different local_filename.')
    token = _load_and_refresh_token()
    if not token or not token.get('access_token'):
        raise PermissionError('Microsoft account is not connected.')
    # httpx removes Authorization when a Graph download redirects to another host.
    with tempfile.TemporaryFile() as temporary, httpx.Client(timeout=45, follow_redirects=True) as client:
        with client.stream('GET', GRAPH_BASE + endpoint + '/content', headers={'Authorization': 'Bearer ' + token['access_token']}) as response:
            if response.status_code in (401, 403):
                raise PermissionError('Microsoft denied access to this file. No content was saved.')
            response.raise_for_status()
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > limit:
                    raise ValueError('Microsoft file exceeds the 20 MB download limit.')
                temporary.write(chunk)
        temporary.seek(0)
        with dest.open('xb') as output:
            while chunk := temporary.read(65536):
                output.write(chunk)
    return json.dumps({'filename': name, 'size': size, 'source_url': item.get('webUrl'),
                       'guidance': 'Read this file in the private workspace. Cite source_url; do not add it to shared knowledge.'})


TOOLS_REGISTRY.update(business_tools(_graph_request))
TOOLS_REGISTRY['microsoft_download_sharepoint_file'] = {
    'func': tool_download_sharepoint_file,
    'description': 'Download a SharePoint or OneDrive search result into the private workspace for full reading. Checks access using the connected user’s token on every call.',
    'inputSchema': {'type': 'object', 'properties': {
        'drive_id': {'type': 'string'}, 'item_id': {'type': 'string'},
        'local_filename': {'type': 'string'}}, 'required': ['drive_id', 'item_id']},
}


def _send_response(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def run_mcp_stdio_server() -> None:
    """Run standard JSON-RPC 2.0 loop over stdin/stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})

        if method == "initialize":
            _send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "microsoft365",
                        "version": "1.0.0",
                    },
                },
            })
        elif method == "notifications/initialized":
            # Client notification; no response required
            pass
        elif method == "tools/list":
            tools_list = [
                {
                    "name": name,
                    "description": info["description"],
                    "inputSchema": info["inputSchema"],
                }
                for name, info in TOOLS_REGISTRY.items()
            ]
            _send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"tools": tools_list},
            })
        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            if tool_name not in TOOLS_REGISTRY:
                _send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": -32601,
                        "message": f"Tool '{tool_name}' not found",
                    },
                })
                continue

            try:
                result_text = TOOLS_REGISTRY[tool_name]["func"](tool_args)
                _send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "content": [
                            {"type": "text", "text": str(result_text)}
                        ],
                    },
                })
            except PermissionError as p_err:
                _send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "isError": True,
                        "content": [
                            {"type": "text", "text": str(p_err)}
                        ],
                    },
                })
            except Exception as exc:
                _send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "isError": True,
                        "content": [
                            {"type": "text", "text": f"Error running tool '{tool_name}': {exc}"}
                        ],
                    },
                })
        elif method == "ping":
            _send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {},
            })
        else:
            if msg_id is not None:
                _send_response({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method '{method}' not found",
                    },
                })


if __name__ == "__main__":
    run_mcp_stdio_server()
