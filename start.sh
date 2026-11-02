#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=================================================="
echo " Starting Buddy / Bob ACP Stack"
echo "=================================================="

# Check Docker installation
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: 'docker' is not installed or not in PATH."
  echo "Please install Docker and Docker Compose before running this script."
  exit 1
fi

# Detect compose command
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' was found."
  echo "Please install Docker Compose."
  exit 1
fi

# First run: create .env with generated secrets. Provider, name and logo are set in the web wizard.
random_secret() { LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$1"; }
set_env_value() {
  KEY="$1" VALUE="$2" awk 'BEGIN { k=ENVIRON["KEY"]; v=ENVIRON["VALUE"]; d=0 }
    index($0, k "=") == 1 { print k "=" v; d=1; next } { print }
    END { if (!d) print k "=" v }' .env > .env.tmp
  cat .env.tmp > .env
  rm -f .env.tmp
}
if [ ! -f ".env" ]; then
  if [ ! -f ".env.example" ]; then
    echo "Error: No .env or .env.example found."
    exit 1
  fi
  echo "First run: creating .env with generated passwords and signing keys..."
  (umask 077; cp .env.example .env)
  chmod 600 .env
  POSTGRES_SECRET="$(random_secret 48)"
  set_env_value POSTGRES_PASSWORD "$POSTGRES_SECRET"
  set_env_value DATABASE_URL "postgresql://bob:${POSTGRES_SECRET}@postgres:5432/bob"
  set_env_value BUDDY_MEMORY_SIGNING_KEY "$(random_secret 64)"
  set_env_value PUBLIC_BASE_URL "http://localhost:${BOB_ALT_PORT:-8080}"
fi

# Ensure workspace and directories exist
mkdir -p workspace .bob-private

echo "Building and launching containers..."
$COMPOSE_CMD up -d --build

echo ""
echo "=================================================="
echo " Buddy is starting up!"
echo "=================================================="
echo "Access the application at:"
echo "  Local:   http://localhost:${BOB_ALT_PORT:-8080}"
echo ""
echo "On first open, the setup wizard creates the administrator and sets the"
echo "assistant name, logo and provider key."
echo ""
echo "To monitor logs:    $COMPOSE_CMD logs -f"
echo "To check status:    $COMPOSE_CMD ps"
echo "To stop containers: ./stop.sh"
echo "=================================================="
