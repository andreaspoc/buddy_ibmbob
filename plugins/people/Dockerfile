ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
FROM ${BUDDY_RUNTIME_IMAGE}
COPY plugins/people /tmp/buddy-people
RUN pip3 install --break-system-packages --no-cache-dir --no-deps --no-build-isolation /tmp/buddy-people && rm -rf /tmp/buddy-people
LABEL org.opencontainers.image.title="Buddy People Chat" org.opencontainers.image.version="1.1.0"
CMD ["python3", "-m", "uvicorn", "buddy_people.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
