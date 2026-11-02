# Buddy / Bob ACP - Quick Start Guide

This repository contains the application stack. It includes no credentials.

---

## Prerequisites
- **Docker Engine** (version 24.0 or newer)
- **Docker Compose** (`docker compose` or `docker-compose`)
- Internet connection during first startup (to pull base images like `postgres:17-alpine` and `node:24-bookworm`)

---

## 1. Quick Launch (Automated)

After cloning the repository on your target machine:

```bash
cd bob-acp
./start.sh
```

The script will automatically detect Docker, check `.env`, build any local image layers, and launch all services in detached mode.

To stop the stack at any time:
```bash
./stop.sh
```

---

## 2. Manual Launch via Docker Compose

```bash
# Build and run containers in background
docker compose up -d --build

# View logs in real-time
docker compose logs -f

# Check container health status
docker compose ps
```

---

## 3. Configuration & Parameters (`.env`)

All runtime settings and parameters are stored in `.env`.
`./start.sh` creates it on first run and generates the passwords and signing keys. Then open the app: a setup wizard creates the administrator, sets the assistant name and logo, and asks for a Bob API key, which you can skip and add later under Administration.

| Parameter | Description |
| :--- | :--- |
| `BOB_API_KEY` | Bob Shell / ACP authentication API key |
| `BOB_TEAM_ID` | Team ID for Bob |
| `POSTGRES_PASSWORD` | Database password for local PostgreSQL 17 container |
| `BOB_BIND_IP` | Host IP binding (default `0.0.0.0` to allow remote access) |
| `BOB_PORT` | Main Web UI port (default `3000`) |
| `BOB_ALT_PORT` | Secondary API port (default `8080`) |
| `PUBLIC_BASE_URL` | Base URL used for links & callbacks (default `http://localhost:3000`) |
| `BRAVE_API_KEY` | Live web search integration |
| `KEYCLOAK_*` | Buddy Keycloak SSO credentials & realm |
| `AZURE_*` / `GRAPH_*` | Microsoft 365 / Graph integration |
| `BOB_FILE_STORAGE` | Storage mode (`s3` for Wasabi or `postgres` for internal DB) |
| `BOB_S3_*` | Wasabi S3 bucket credentials, endpoint, and region |

If you deploy to a server with a specific domain or IP address, update `PUBLIC_BASE_URL`:
```bash
PUBLIC_BASE_URL=http://<YOUR_SERVER_IP>:3000
```

---

## 4. Accessing the Application

- **Web Application**: Open [http://localhost:3000](http://localhost:3000) (or `http://<SERVER_IP>:3000`)
- **Interactive API Docs**: [http://localhost:3000/docs](http://localhost:3000/docs)
- **Direct A2A JSON-RPC**: `http://localhost:3000/a2a`

---

## 5. Troubleshooting & Useful Commands

- **Restart a single service**:
  ```bash
  docker compose restart bob-agent
  ```
- **Rebuild after making code changes**:
  ```bash
  docker compose up -d --build
  ```
- **Inspect database**:
  ```bash
  docker compose exec postgres psql -U bob -d bob
  ```
