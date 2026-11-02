"""Read real public OAuth metadata only; never register clients or sign in."""
from app.mcp_oauth import discover, OAuthError

PROVIDERS = [
    ('Linear', 'https://mcp.linear.app/mcp'),
    ('Notion', 'https://mcp.notion.com/mcp'),
    ('Atlassian', 'https://mcp.atlassian.com/v2/mcp'),
    ('Context7', 'https://mcp.context7.com/mcp/oauth'),
    ('Firecrawl', 'https://mcp.firecrawl.dev/v2/mcp-oauth'),
    ('Exa', 'https://mcp.exa.ai/mcp?login'),
]
for name, endpoint in PROVIDERS:
    try:
        result = discover({'url': endpoint, 'oauth_scopes': ''})
        print(name + ': discovered PKCE S256; ' + ('dynamic registration advertised' if result['registration_endpoint'] else 'pre-registered client required') + '; issuer=' + result['issuer'], flush=True)
    except OAuthError as error:
        print(name + ': ' + str(error), flush=True)
