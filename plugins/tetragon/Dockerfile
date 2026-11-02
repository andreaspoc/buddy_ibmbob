# Both daemon and CLI must use the same reviewed Tetragon release/digest.
ARG TETRAGON_IMAGE=quay.io/cilium/tetragon:v1.7.1@sha256:afc9458ba4bc3f2795da3df6b03d88ce50e175ac3903027de8036e2046b84a02
ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
FROM ${TETRAGON_IMAGE} AS tetra

FROM node:24-bookworm AS ui
WORKDIR /build
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web --no-audit --no-fund
COPY plugins/tetragon/ui ./plugins/tetragon/ui
RUN node plugins/tetragon/ui/build.mjs

FROM ${BUDDY_RUNTIME_IMAGE}
COPY --from=tetra /usr/bin/tetra /usr/local/bin/tetra
# Older 1.1.0 runtime images predate this shared HTTP provenance middleware.
COPY app/browser_security.py /opt/bob-a2a/app/browser_security.py
COPY plugins/tetragon /tmp/buddy-tetragon
COPY --from=ui /build/plugins/tetragon/buddy_tetragon/static /tmp/buddy-tetragon/buddy_tetragon/static
RUN pip3 install --break-system-packages --no-cache-dir --no-deps --no-build-isolation /tmp/buddy-tetragon \
    && rm -rf /tmp/buddy-tetragon \
    && mkdir -p /data
ENV BUDDY_TETRA_BIN=/usr/local/bin/tetra \
    BUDDY_TETRAGON_ADDRESS=unix:///var/run/tetragon/tetragon.sock \
    BUDDY_TETRAGON_DB=/data/rules.sqlite
LABEL org.opencontainers.image.title="Buddy Tetragon" org.opencontainers.image.version="1.0.0"
WORKDIR /data
CMD ["python3", "-m", "uvicorn", "buddy_tetragon.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080"]
