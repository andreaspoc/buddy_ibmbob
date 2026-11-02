import asyncio, json, sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    async with stdio_client(StdioServerParameters(command=sys.executable,args=['-m','mcp_server_fetch'])) as (read,write):
        async with ClientSession(read,write) as session:
            await session.initialize()
            tools=await session.list_tools()
            results=[]
            for url in ['https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html','https://example.com','http://127.0.0.1/','http://169.254.169.254/']:
                result=await session.call_tool('fetch',{'url':url,'max_length':1500})
                text='\n'.join(c.text for c in result.content if hasattr(c,'text'))
                blocked=url.startswith(('http://127.','http://169.254.'))
                passed=bool(result.is_error) if blocked else not result.is_error and ('AI Agent Security' in text if 'owasp.org' in url else 'Example Domain' in text)
                results.append({'url':url,'isError':bool(result.is_error),'passed':passed,'excerpt':text[:350]})
            print(json.dumps({'tools':[tool.name for tool in tools.tools],'results':results},indent=2))
            if any(not result['passed'] for result in results):sys.exit(1)
asyncio.run(main())
