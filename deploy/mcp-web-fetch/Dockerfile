FROM python:3.12-slim
RUN pip install --no-cache-dir mcp-server-fetch==2026.10.19
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
ENTRYPOINT ["python3", "-m", "mcp_server_fetch"]
