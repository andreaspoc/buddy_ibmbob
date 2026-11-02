ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
FROM ${BUDDY_RUNTIME_IMAGE}
COPY plugins/office /tmp/buddy-office
RUN pip3 install --break-system-packages --no-cache-dir --no-deps --no-build-isolation /tmp/buddy-office && rm -rf /tmp/buddy-office
LABEL org.opencontainers.image.title="Buddy Office" org.opencontainers.image.version="1.1.0"
CMD ["python3", "-m", "uvicorn", "buddy_office.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
