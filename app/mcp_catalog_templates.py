"""Documented work-content MCP presets. All new entries require explicit admin grants.

Endpoint definitions are setup recipes, not claims that a provider is connected.
Database, CRM, payment and private-chat services are excluded. Microsoft Office
and read-only Keycloak configuration are the explicitly requested account exceptions.
"""

def remote(identifier, name, icon, category, url, docs, description, *, auth='oauth', instructions='', fields=None, requires_url=False):
    return dict(id=identifier, name=name, icon=icon, category=category, url=url,
                docs_url=docs, description=description, auth_mode=auth,
                setup_instructions=instructions, fields=fields or [], requires_url=requires_url,
                access_mode='grants', groups=[], users=[], enabled=True)


def token(label='API key', target='Authorization', prefix='Bearer ', required=True):
    return dict(key='token', label=label, target=target, prefix=prefix, required=required)


PROVIDERS = [
    remote('docmost', 'Docmost', 'docmost', 'knowledge', '',
           'https://docmost.com/docs/user-guide/mcp',
           'Search, read and update company wiki pages and spaces.', requires_url=True,
           instructions='Administrator: set your Docmost instance MCP URL (your instance address followed by /mcp). Enable MCP in Docmost. Business or Enterprise edition is required. Users sign in to their work account.'),
    dict(id='microsoft365', name='Microsoft 365 / Office', icon='microsoft', category='productivity',
         description='Use your connected Microsoft account for Outlook, calendar, OneDrive, SharePoint and Teams.',
         auth_mode='microsoft', transport='stdio', command='python3', args=['-m', 'app.mcp_microsoft'], fields=[],
         docs_url='https://learn.microsoft.com/en-us/graph/auth-v2-user',
         setup_instructions='Uses the existing Microsoft account sign-in. An administrator must configure the Microsoft application before users connect. Microsoft Office is the personal-account exception.',
         access_mode='grants', groups=[], users=[], enabled=True),
    remote('microsoft-learn', 'Microsoft Learn', 'microsoft', 'knowledge', 'https://learn.microsoft.com/api/mcp',
           'https://learn.microsoft.com/en-us/training/support/mcp',
           'Search and read public Microsoft product documentation and code examples.', auth='none'),
    remote('notion', 'Notion work documentation', 'notion', 'knowledge', 'https://mcp.notion.com/mcp',
           'https://developers.notion.com/guides/mcp/build-mcp-client',
           'Find and update documentation pages in an authorized work workspace.',
           instructions='Sign in to your work workspace and authorize only the documentation required for your task.'),
    remote('atlassian', 'Atlassian Jira & Confluence', 'atlassian', 'productivity', 'https://mcp.atlassian.com/v2/mcp',
           'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
           'Find company Confluence documentation and manage Jira project work.',
           instructions='Use your work Atlassian account. Organization policies and product permissions determine available tools.'),
    remote('linear', 'Linear', 'linear', 'productivity', 'https://mcp.linear.app/mcp',
           'https://linear.app/docs/mcp', 'Search and manage work issues, projects and milestones.'),
    remote('linear-readonly', 'Linear read-only', 'linear', 'productivity', 'https://mcp.linear.app/mcp/readonly',
           'https://linear.app/docs/mcp', 'Read project and issue context without exposing write tools.'),
    remote('gitlab', 'GitLab', 'gitlab', 'development', 'https://gitlab.com/api/v4/mcp',
           'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
           'Read repository context and work with merge requests and issues.',
           instructions='GitLab MCP availability and permissions must be enabled. If dynamic registration is disabled, an administrator must configure an OAuth client ID. Administrators can change the endpoint for a company GitLab instance.'),
    remote('cloudflare-docs', 'Cloudflare documentation', 'cloudflare', 'knowledge', 'https://docs.mcp.cloudflare.com/mcp',
           'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
           'Search public Cloudflare documentation for Workers, DNS and platform development.', auth='none'),
    remote('deepwiki', 'DeepWiki', 'deepwiki', 'development', 'https://mcp.deepwiki.com/mcp',
           'https://docs.devin.ai/work-with-devin/deepwiki-mcp', 'Read and ask questions about public repository documentation.', auth='none'),
    dict(id='keycloak', name='Keycloak', icon='keycloak', category='development',
         description='Read realm, client, role and authentication-flow configuration. User records and write operations are not exposed.',
         auth_mode='keycloak', transport='stdio', command='python3', args=['-m', 'app.mcp_keycloak'], fields=[],
         url='', requires_url=True, docs_url='https://www.keycloak.org/securing-apps/mcp-authz-server',
         setup_instructions='Administrator: configure the HTTPS realm issuer URL and a registered OAuth client ID with Standard Flow and PKCE S256. Grant only the realm/client configuration read permissions needed. Users sign in in a popup. This is a Buddy connector for Keycloak configuration, not a hosted Keycloak MCP endpoint.',
         access_mode='grants', groups=[], users=[], enabled=True),
    remote('context7', 'Context7', 'context7', 'development', 'https://mcp.context7.com/mcp/oauth',
           'https://context7.com/docs/resources/all-clients', 'Retrieve current library documentation and coding examples.'),
    remote('context7-key', 'Context7 with API key', 'context7', 'development', 'https://mcp.context7.com/mcp',
           'https://context7.com/docs/resources/all-clients', 'Retrieve current library documentation using an API key.',
           auth='credentials', fields=[token('Context7 API key')]),
    remote('tavily', 'Tavily', 'tavily', 'search', 'https://mcp.tavily.com/mcp/',
           'https://docs.tavily.com/documentation/mcp', 'Search public webpages and extract evidence for research.'),
    remote('exa', 'Exa', 'exa', 'search', 'https://mcp.exa.ai/mcp?login',
           'https://exa.ai/docs/get-started/exa-mcp', 'Search public web sources and retrieve research content.'),
    remote('exa-key', 'Exa with API key', 'exa', 'search', 'https://mcp.exa.ai/mcp',
           'https://exa.ai/docs/get-started/exa-mcp', 'Search public web sources using your Exa API key.',
           auth='credentials', fields=[token('Exa API key', 'x-api-key', '')]),
    remote('firecrawl', 'Firecrawl', 'firecrawl', 'search', 'https://mcp.firecrawl.dev/v2/mcp-oauth',
           'https://docs.firecrawl.dev/mcp-server/keyless', 'Read and extract public web content for research.'),
    remote('firecrawl-key', 'Firecrawl with API key', 'firecrawl', 'search', 'https://mcp.firecrawl.dev/v2/mcp',
           'https://docs.firecrawl.dev/mcp-server', 'Extract public webpages using your Firecrawl API key.',
           auth='credentials', fields=[token('Firecrawl API key')]),
    dict(id='brave-search', name='Brave Search', icon='brave', category='search',
         description='Search public web sources through the built-in Brave search connector.',
         auth_mode='credentials', transport='stdio', command='python3', args=['-m', 'app.mcp_search'],
         fields=[dict(key='token', label='Brave Search API key', location='env', target='BRAVE_API_KEY')],
         docs_url='https://brave.com/search/api/guides/use-with-claude-desktop-with-mcp/',
         access_mode='grants', groups=[], users=[], enabled=True),
]
