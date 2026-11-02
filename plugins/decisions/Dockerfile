ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
FROM ${BUDDY_RUNTIME_IMAGE}
COPY app/decisions_buddy /opt/bob-a2a/app/decisions_buddy
COPY plugins/decisions /tmp/buddy-decisions
RUN pip3 install --break-system-packages --no-cache-dir --no-deps --no-build-isolation /tmp/buddy-decisions && rm -rf /tmp/buddy-decisions
LABEL org.opencontainers.image.title="DecisionsBuddy" org.opencontainers.image.version="1.0.0"
CMD ["python3", "-m", "uvicorn", "buddy_decisions.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
