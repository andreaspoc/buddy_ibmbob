ARG BUDDY_RUNTIME_IMAGE=bob-acp-runtime:1.1.0
# Frontend dependencies are needed to compile assets, not to run the service.
FROM node:24-bookworm AS frontend-build
WORKDIR /opt/bob-a2a
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN cd frontend && npm run build
COPY web/package*.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build
COPY decisions-buddy/package*.json ./decisions-buddy/
RUN cd decisions-buddy && npm ci --no-audit --no-fund
COPY decisions-buddy ./decisions-buddy
RUN cd decisions-buddy && npm run build

FROM ${BUDDY_RUNTIME_IMAGE}
COPY app /opt/bob-a2a/app
COPY --from=frontend-build /opt/bob-a2a/app/static/renderer.bundle.js /opt/bob-a2a/app/static/renderer.bundle.js
COPY --from=frontend-build /opt/bob-a2a/app/static/document-export.bundle.js /opt/bob-a2a/app/static/document-export.bundle.js
COPY --from=frontend-build /opt/bob-a2a/app/static/carbon-charts.bundle.js /opt/bob-a2a/app/static/carbon-charts.bundle.js
COPY --from=frontend-build /opt/bob-a2a/app/static/carbon-charts.css /opt/bob-a2a/app/static/carbon-charts.css
COPY --from=frontend-build /opt/bob-a2a/app/static/dist /opt/bob-a2a/app/static/dist
COPY --from=frontend-build /opt/bob-a2a/decisions-buddy/dist /opt/bob-a2a/app/static/decisions
COPY workspace /workspace
LABEL org.opencontainers.image.title="Buddy Core" org.opencontainers.image.version="1.1.0"
CMD ["python3", "-m", "uvicorn", "app.main:app", "--app-dir", "/opt/bob-a2a", "--host", "0.0.0.0", "--port", "8080"]
