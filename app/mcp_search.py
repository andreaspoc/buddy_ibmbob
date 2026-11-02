"""Brave Web Search and Page Fetcher MCP Server for Buddy ACP.

Provides tools for searching the web and reading webpage content over stdio MCP.
Also supports direct CLI execution:
    python3 -m app.mcp_search --search "query"
    python3 -m app.mcp_search --fetch "https://example.com"
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from typing import Any
import httpx


import time

BRAVE_SEARCH_API = os.getenv("BRAVE_SEARCH_API", "https://api.search.brave.com/res/v1/web/search")

_client: httpx.Client | None = None
_SEARCH_CACHE: dict[str, tuple[float, str]] = {}
_PAGE_CACHE: dict[str, tuple[float, str]] = {}
CACHE_TTL = 900.0  # 15 minutes


def _log(msg: str) -> None:
    sys.stderr.write(f"[mcp_search] {msg}\n")
    sys.stderr.flush()


def _get_api_key() -> str:
    return os.environ.get("BRAVE_API_KEY", "").strip()


def _get_client() -> httpx.Client:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.Client(
            timeout=httpx.Timeout(6.0, connect=2.5, read=4.5),
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=60.0),
            follow_redirects=True,
        )
    return _client


def brave_web_search(query: str, count: int = 5, freshness: str | None = None) -> str:
    """Execute a web search using Brave Search API."""
    api_key = _get_api_key()
    if not api_key:
        return (
            "Error: BRAVE_API_KEY is not set in the environment.\n"
            "To enable live web search:\n"
            "1. Obtain a free Brave Search API key at https://brave.com/search/api/\n"
            "2. Add BRAVE_API_KEY=your_key to .env and restart Docker."
        )

    cleaned_query = query.strip()
    if not cleaned_query:
        return "Error: Empty search query provided."

    from datetime import datetime, timezone
    now_year = datetime.now(timezone.utc).year

    # Check query cache first
    cache_key = f"{cleaned_query.lower()}::{count}::{freshness or ''}"
    now_ts = time.time()
    if cache_key in _SEARCH_CACHE:
        cached_ts, cached_res = _SEARCH_CACHE[cache_key]
        if now_ts - cached_ts < CACHE_TTL:
            return cached_res

    is_recent_query = bool(re.search(r"\b(latest|recent|news|today|yesterday|current|this week|upcoming)\b", cleaned_query, re.I))

    if is_recent_query:
        # If the query asks for latest/recent news but hardcoded a past year,
        # update to the current year so stale results are not returned
        past_years = [str(y) for y in range(2020, now_year)]
        for py in past_years:
            if re.search(r"\b" + py + r"\b", cleaned_query):
                _log(f"Auto-correcting outdated year {py} to current year {now_year} for query: {cleaned_query}")
                cleaned_query = re.sub(r"\b" + py + r"\b", str(now_year), cleaned_query).strip()

    count = max(1, min(int(count), 10))
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": api_key,
    }
    params = {
        "q": cleaned_query,
        "count": count,
        "text_decorations": "false",
        "safesearch": "moderate",
    }
    if freshness and freshness in {"pd", "pw", "pm", "py"}:
        params["freshness"] = freshness

    try:
        client = _get_client()
        resp = client.get(BRAVE_SEARCH_API, headers=headers, params=params)
        if resp.status_code in {401, 403}:
            return f"Error: Invalid or unauthorized BRAVE_API_KEY (HTTP {resp.status_code})."
        if resp.status_code == 429:
            return "Error: Brave Search rate limit or quota exceeded. Please wait a moment or check your quota."
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        _log(f"Brave Search request error: {exc}")
        return f"Error executing web search for '{query}': {exc}"

    web_results = (data.get("web") or {}).get("results") or []

    # If freshness restriction caused 0 results, fall back to unrestricted search in the same call
    if not web_results and "freshness" in params:
        _log(f"Zero results with freshness filter '{params.get('freshness')}'; falling back to general search...")
        fallback_params = dict(params)
        fallback_params.pop("freshness", None)
        try:
            client = _get_client()
            resp2 = client.get(BRAVE_SEARCH_API, headers=headers, params=fallback_params)
            if resp2.status_code == 200:
                data = resp2.json()
                web_results = (data.get("web") or {}).get("results") or []
        except Exception:
            pass

    if not web_results:
        return f"No web search results found for query: '{query}'."

    output_lines = [f"### Web Search Results for: \"{cleaned_query}\"\n"]

    infobox = data.get("infobox")
    if isinstance(infobox, dict):
        info_title = (infobox.get("title") or "").strip()
        info_desc = (infobox.get("description") or "").strip()
        if info_title or info_desc:
            output_lines.append(f"**Quick Overview ({info_title}):** {info_desc}\n")

    def _clean_snippet_text(t: str) -> str:
        t = re.sub(r"(?i)\b(accept all cookies|we use cookies|privacy policy|manage preferences|all rights reserved)\b.*", "", t)
        t = re.sub(r"\s+", " ", t).strip()
        return t

    for i, item in enumerate(web_results[:count], 1):
        title = item.get("title", "Untitled").strip()
        url = item.get("url", "").strip()
        description = _clean_snippet_text(item.get("description", ""))
        age = item.get("page_age") or item.get("age") or ""

        age_text = f" ({age})" if age else ""
        output_lines.append(f"{i}. **[{title}]({url})**{age_text}")
        if description:
            output_lines.append(f"   {description}")

        # Extract extra snippets for rich contextual facts without needing fetch_web_page
        extra_snippets = item.get("extra_snippets") or []
        for extra in extra_snippets[:2]:
            snip = _clean_snippet_text(str(extra))
            if snip and snip != description and len(snip) > 20:
                output_lines.append(f"   > {snip}")
        output_lines.append("")

    result_text = "\n".join(output_lines).replace("\x00", "").replace("\u0000", "").strip()
    _SEARCH_CACHE[cache_key] = (now_ts, result_text)
    return result_text


def _strip_html(raw_html: str) -> str:
    """Extract clean text content from HTML without heavy external libraries."""
    from html.parser import HTMLParser

    class ReadableText(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts = []
            self.hidden = []
            self.hidden_counts = {}

        def hide(self, tag):
            self.hidden.append(tag)
            self.hidden_counts[tag] = self.hidden_counts.get(tag, 0) + 1

        def handle_starttag(self, tag, attrs):
            void = tag in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
            if self.hidden:
                if not void:
                    self.hide(tag)
                return
            attributes = ' '.join(name + ' ' + (value or '') for name, value in attrs).lower()
            banner = tag in {'div', 'section', 'aside'} and any(word in attributes for word in ('cookie', 'consent', 'gdpr', 'banner', 'modal'))
            if tag in {'script', 'style', 'header', 'footer', 'nav', 'svg'} or banner:
                self.hide(tag)
                self.parts.append(' ')
            elif tag in {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'section', 'article'}:
                self.parts.append('\n\n')
            elif tag == 'li':
                self.parts.append('\n- ')
            elif tag == 'br':
                self.parts.append('\n')
            else:
                self.parts.append(' ')

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)

        def handle_endtag(self, tag):
            if self.hidden:
                if self.hidden_counts.get(tag):
                    while True:
                        closed = self.hidden.pop()
                        self.hidden_counts[closed] -= 1
                        if closed == tag:
                            break
            else:
                self.parts.append(' ')

        def handle_data(self, data):
            if not self.hidden:
                self.parts.append(data)

        def handle_comment(self, data):
            if not self.hidden:
                self.parts.append(' ')

        def handle_decl(self, decl):
            if not self.hidden:
                self.parts.append(' ')

        def handle_pi(self, data):
            if not self.hidden:
                self.parts.append(' ')

    parser = ReadableText()
    parser.feed(raw_html)
    parser.close()
    text = ''.join(parser.parts)

    # Clean redundant whitespace
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def fetch_web_page(url: str, max_chars: int = 4000) -> str:
    """Fetch URL and extract clean, readable text."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        return f"Error: Invalid URL scheme for '{url}'. URL must start with http:// or https://"

    max_chars = max(500, min(int(max_chars), 15000))
    now_ts = time.time()
    cache_key = f"{url}::{max_chars}"
    if cache_key in _PAGE_CACHE:
        cached_ts, cached_res = _PAGE_CACHE[cache_key]
        if now_ts - cached_ts < CACHE_TTL:
            return cached_res

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        client = _get_client()
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        encoding = resp.headers.get("content-encoding", "").lower()
        raw_bytes = resp.content
        if encoding == "br" or (len(raw_bytes) > 10 and raw_bytes.startswith(b"U&m")):
            try:
                import brotli
                raw_text = brotli.decompress(raw_bytes).decode("utf-8", errors="replace")
            except Exception:
                raw_text = resp.text
        elif encoding == "gzip":
            import gzip
            try:
                raw_text = gzip.decompress(raw_bytes).decode("utf-8", errors="replace")
            except Exception:
                raw_text = resp.text
        else:
            raw_text = resp.text

        content_type = resp.headers.get("content-type", "").lower()
        if "application/json" in content_type:
            clean_text = raw_text
        else:
            clean_text = _strip_html(raw_text)
    except Exception as exc:
        _log(f"Page fetch error for {url}: {exc}")
        return f"Error fetching webpage '{url}': {exc}"

    clean_text = clean_text.replace("\x00", "").replace("\u0000", "").strip()

    if not clean_text:
        return f"Page at '{url}' returned empty or non-extractable content."

    if len(clean_text) > max_chars:
        clean_text = clean_text[:max_chars] + f"\n\n... [Content truncated at {max_chars} characters]"

    res = f"### Extracted content from: {url}\n\n{clean_text}"
    _PAGE_CACHE[cache_key] = (now_ts, res)
    return res


TOOLS_REGISTRY: dict[str, dict[str, Any]] = {
    "brave_web_search": {
        "name": "brave_web_search",
        "description": "Search the live web using Brave Search. Returns top ranked web results with titles, URLs, and summaries. Prioritizes primary official domains. For complete lists or directories (such as store branches, retail locations, or full specs), follow up with fetch_web_page on the official primary URL to ensure complete, non-truncated ground truth.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (e.g. 'latest release python 3.13 features' or 'APOEL FC news').",
                },
                "count": {
                    "type": "integer",
                    "description": "Number of search results to return (1-10, default 5).",
                    "default": 5,
                },
                "freshness": {
                    "type": "string",
                    "description": "Filter by time discovered: 'pd' (past 24h), 'pw' (past 7 days), 'pm' (past 31 days), 'py' (past 365 days).",
                    "enum": ["pd", "pw", "pm", "py"],
                },
            },
            "required": ["query"],
        },
        "func": lambda args: brave_web_search(
            query=args.get("query", ""),
            count=args.get("count", 5),
            freshness=args.get("freshness"),
        ),
    },
    "fetch_web_page": {
        "name": "fetch_web_page",
        "description": "Fetch a webpage URL and extract clean, readable text. Use this to read full articles, documentation, or pages found in web search.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The full HTTP or HTTPS URL to fetch.",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum characters to extract (default 4000).",
                    "default": 4000,
                },
            },
            "required": ["url"],
        },
        "func": lambda args: fetch_web_page(
            url=args.get("url", ""),
            max_chars=args.get("max_chars", 4000),
        ),
    },
}


def _send_response(resp: dict[str, Any]) -> None:
    line = json.dumps(resp, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def run_mcp_stdio_server() -> None:
    """Run JSON-RPC stdio loop for Buddy ACP."""
    _log("Starting Brave Web Search MCP server on stdio...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            _log(f"Invalid JSON received: {exc}")
            continue

        method = req.get("method")
        msg_id = req.get("id")

        if method == "initialize":
            _send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {},
                    },
                    "serverInfo": {
                        "name": "brave-web-search-mcp",
                        "version": "1.0.0",
                    },
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            tools_list = [
                {
                    "name": tool_meta["name"],
                    "description": tool_meta["description"],
                    "inputSchema": tool_meta["inputSchema"],
                }
                for tool_meta in TOOLS_REGISTRY.values()
            ]
            _send_response({
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": tools_list,
                },
            })
        elif method == "tools/call":
            params = req.get("params") or {}
            tool_name = params.get("name")
            tool_args = params.get("arguments") or {}

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Brave Web Search and Page Fetcher")
    parser.add_argument("--search", "-s", type=str, help="Run a search query")
    parser.add_argument("--fetch", "-f", type=str, help="Fetch a webpage URL")
    parser.add_argument("--count", "-c", type=int, default=5, help="Number of search results")
    parser.add_argument("--freshness", choices=["pd", "pw", "pm", "py"], default=None, help="Filter by freshness: pd (24h), pw (7d), pm (31d), py (365d)")
    args = parser.parse_args()

    if args.search:
        print(brave_web_search(args.search, count=args.count, freshness=args.freshness))
    elif args.fetch:
        print(fetch_web_page(args.fetch))
    else:
        run_mcp_stdio_server()


if __name__ == "__main__":
    main()
