ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
FROM ${BUDDY_RUNTIME_IMAGE}
COPY plugins/learning /tmp/buddy-learning
RUN pip3 install --break-system-packages --no-cache-dir --no-deps --no-build-isolation /tmp/buddy-learning && rm -rf /tmp/buddy-learning
LABEL org.opencontainers.image.title="Buddy Learning" org.opencontainers.image.version="1.0.0"
CMD ["python3", "-m", "uvicorn", "buddy_learning.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
