#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OpsPM360 — from-scratch installer for Linux, macOS, and WSL.
#
#   curl -fsSL https://<your-host>/install.sh | bash            # or:
#   ./install.sh [--mode docker|native] [--no-seed] [--start] [--cron] [--yes]
#
# What it does:
#   1. Detects the OS and package manager (apt/dnf/yum/pacman/zypper/apk/brew).
#   2. Installs missing prerequisites (git, curl, and per mode: Docker, or
#      Node.js 20+ and PostgreSQL 16).
#   3. Generates strong secrets and writes .env (never overwrites an existing one).
#   4. Docker mode: builds and starts db + app + SLA cron sidecar.
#      Native mode: npm ci → prisma migrate deploy → seed → production build.
#   5. Optionally installs cron entries (native) for the SLA sweep and audit
#      retention, and can start the app.
#
# Idempotent: safe to re-run; every step checks before it acts.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── UI helpers ───────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GRN="$(printf '\033[32m')"; YLW="$(printf '\033[33m')"; BLU="$(printf '\033[34m')"
  RST="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi
step()  { printf '%s\n' "${BLU}${BOLD}==>${RST}${BOLD} $*${RST}"; }
ok()    { printf '%s\n' "${GRN}  ✓${RST} $*"; }
warn()  { printf '%s\n' "${YLW}  !${RST} $*"; }
fail()  { printf '%s\n' "${RED}  ✗ $*${RST}" >&2; exit 1; }
trap 'printf "%s\n" "${RED}Installer aborted. Re-running is safe — completed steps are skipped.${RST}" >&2' ERR

# ── Arguments ────────────────────────────────────────────────────────────────
MODE="auto"          # auto | docker | native
SEED=1
START=0
CRON=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)    MODE="${2:?--mode needs docker|native}"; shift 2 ;;
    --no-seed) SEED=0; shift ;;
    --start)   START=1; shift ;;
    --cron)    CRON=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s' "${YLW}  ?${RST} $1 [Y/n] "
  read -r reply || reply=""
  case "$reply" in n|N|no|NO) return 1 ;; *) return 0 ;; esac
}

# ── Platform detection ───────────────────────────────────────────────────────
step "Detecting platform"
OS="$(uname -s)"
PKG=""
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

case "$OS" in
  Darwin)
    PKG="brew"
    command -v brew >/dev/null 2>&1 || fail "Homebrew is required on macOS. Install it from https://brew.sh then re-run."
    ok "macOS with Homebrew"
    ;;
  Linux)
    if   command -v apt-get >/dev/null 2>&1; then PKG="apt"
    elif command -v dnf     >/dev/null 2>&1; then PKG="dnf"
    elif command -v yum     >/dev/null 2>&1; then PKG="yum"
    elif command -v pacman  >/dev/null 2>&1; then PKG="pacman"
    elif command -v zypper  >/dev/null 2>&1; then PKG="zypper"
    elif command -v apk     >/dev/null 2>&1; then PKG="apk"
    else fail "No supported package manager found (apt/dnf/yum/pacman/zypper/apk)."
    fi
    if grep -qi microsoft /proc/version 2>/dev/null; then
      ok "WSL ($PKG) — Docker Desktop integration is used if available"
    else
      ok "Linux ($PKG)"
    fi
    ;;
  *) fail "Unsupported OS: $OS. On Windows, run install.ps1 in PowerShell instead." ;;
esac

pkg_install() {
  case "$PKG" in
    apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@" ;;
    dnf)    $SUDO dnf install -y -q "$@" ;;
    yum)    $SUDO yum install -y -q "$@" ;;
    pacman) $SUDO pacman -Sy --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    apk)    $SUDO apk add --no-progress "$@" ;;
    brew)   brew install "$@" ;;
  esac
}

need() { # need <command> <package-name...>
  local cmd="$1"; shift
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd present"; return 0; fi
  confirm "Install missing dependency '$cmd'?" || fail "'$cmd' is required."
  pkg_install "$@"
  command -v "$cmd" >/dev/null 2>&1 || fail "Failed to install $cmd"
  ok "$cmd installed"
}

step "Checking base tools"
need git git
need curl curl

# ── Locate / fetch the repository ────────────────────────────────────────────
if [ -f package.json ] && grep -q '"name": "opspm360"' package.json 2>/dev/null; then
  ok "Running inside the OpsPM360 repository"
else
  REPO_URL="${OPSPM360_REPO:-}"
  [ -n "$REPO_URL" ] || fail "Not inside the repo. Set OPSPM360_REPO=<git-url> or run from a checkout."
  step "Cloning repository"
  git clone "$REPO_URL" opspm360
  cd opspm360
  ok "Cloned into ./opspm360"
fi

# ── Mode resolution ──────────────────────────────────────────────────────────
if [ "$MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    MODE="docker"
  else
    MODE="native"
  fi
fi
step "Install mode: ${BOLD}${MODE}${RST}"

# ── Secrets / .env ───────────────────────────────────────────────────────────
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 48 | tr -d '\n='
  else head -c 48 /dev/urandom | base64 | tr -d '\n='
  fi
}

step "Configuring environment (.env)"
if [ -f .env ]; then
  ok ".env already exists — keeping it (delete it to regenerate)"
else
  SESSION_SECRET="$(gen_secret)"
  CRON_SECRET="$(gen_secret)"
  if [ "$MODE" = "docker" ]; then
    DB_URL="postgresql://opspm:opspm@db:5432/opspm360?schema=public"
  else
    DB_URL="postgresql://opspm:opspm@localhost:5432/opspm360?schema=public"
  fi
  cat > .env <<ENV
DATABASE_URL="$DB_URL"
SESSION_SECRET="$SESSION_SECRET"
CRON_SECRET="$CRON_SECRET"
APP_URL="http://localhost:3000"
AUDIT_RETENTION_DAYS="90"
ENV
  chmod 600 .env
  ok "Generated .env with strong random secrets (chmod 600)"
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

# ═════════════════════════════════════════════════════════════════════════════
if [ "$MODE" = "docker" ]; then
  # ── DOCKER PATH ────────────────────────────────────────────────────────────
  step "Ensuring Docker"
  if ! command -v docker >/dev/null 2>&1; then
    case "$OS" in
      Darwin) fail "Install Docker Desktop (https://docker.com/products/docker-desktop) or re-run with --mode native." ;;
      Linux)
        confirm "Docker is missing. Install via get.docker.com?" || fail "Docker required for docker mode."
        curl -fsSL https://get.docker.com | $SUDO sh
        $SUDO usermod -aG docker "$USER" 2>/dev/null || true
        warn "You may need to log out/in for docker group membership."
        ;;
    esac
  fi
  docker info >/dev/null 2>&1 || $SUDO systemctl start docker 2>/dev/null || true
  docker info >/dev/null 2>&1 || fail "Docker daemon is not running."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin missing (docker-compose-plugin package)."
  ok "Docker + Compose ready"

  step "Building and starting the stack (db + app + SLA cron sidecar)"
  docker compose up -d --build
  ok "Stack started"

  step "Waiting for the application"
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null http://localhost:3000/login 2>/dev/null; then
      ok "Application answering on http://localhost:3000"
      break
    fi
    [ "$i" = 60 ] && fail "App did not become healthy in 120s — check: docker compose logs app"
    sleep 2
  done

  if [ "$SEED" = 1 ]; then
    step "Seeding demo data (sites, users, sample portfolio)"
    docker compose exec -T app npx tsx prisma/seed.ts || warn "Seed failed or already applied — check: docker compose logs app"
    ok "Seed step finished"
  fi

else
  # ── NATIVE PATH ────────────────────────────────────────────────────────────
  step "Ensuring Node.js >= 20"
  NODE_OK=0
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 20 ] && NODE_OK=1
  fi
  if [ "$NODE_OK" = 1 ]; then
    ok "node $(node -v)"
  else
    confirm "Install Node.js 20 LTS?" || fail "Node.js >= 20 required."
    case "$PKG" in
      brew)   brew install node@20 && brew link --overwrite node@20 ;;
      apt)    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - && $SUDO apt-get install -y -qq nodejs ;;
      dnf|yum) curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - && pkg_install nodejs ;;
      pacman) pkg_install nodejs npm ;;
      zypper) pkg_install nodejs20 npm20 || pkg_install nodejs npm ;;
      apk)    pkg_install nodejs npm ;;
    esac
    command -v node >/dev/null 2>&1 || fail "Node.js installation failed"
    ok "node $(node -v) installed"
  fi

  step "Ensuring PostgreSQL server"
  if command -v psql >/dev/null 2>&1 && (pg_isready -q 2>/dev/null || $SUDO pg_isready -q 2>/dev/null); then
    ok "PostgreSQL is running"
  else
    confirm "Install and start PostgreSQL 16?" || fail "PostgreSQL required for native mode."
    case "$PKG" in
      brew)
        brew install postgresql@16
        brew services start postgresql@16
        export PATH="$(brew --prefix)/opt/postgresql@16/bin:$PATH"
        ;;
      apt)    pkg_install postgresql postgresql-contrib && $SUDO systemctl enable --now postgresql ;;
      dnf|yum)
        pkg_install postgresql-server postgresql
        $SUDO postgresql-setup --initdb 2>/dev/null || true
        $SUDO systemctl enable --now postgresql
        ;;
      pacman)
        pkg_install postgresql
        $SUDO -u postgres initdb -D /var/lib/postgres/data 2>/dev/null || true
        $SUDO systemctl enable --now postgresql
        ;;
      zypper) pkg_install postgresql-server && $SUDO systemctl enable --now postgresql ;;
      apk)
        pkg_install postgresql postgresql-contrib
        $SUDO rc-update add postgresql default 2>/dev/null || true
        $SUDO rc-service postgresql start 2>/dev/null || $SUDO su postgres -c 'pg_ctl start -D /var/lib/postgresql/data' || true
        ;;
    esac
    ok "PostgreSQL installed and started"
  fi

  step "Provisioning database role + database (idempotent)"
  PSQL_AS_ADMIN="psql"
  if [ "$OS" = "Linux" ]; then PSQL_AS_ADMIN="$SUDO -u postgres psql"; fi
  $PSQL_AS_ADMIN -v ON_ERROR_STOP=1 -d postgres <<'SQL' >/dev/null 2>&1 || warn "Role/DB may already exist — continuing"
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opspm') THEN
    CREATE ROLE opspm LOGIN PASSWORD 'opspm';
  END IF;
END $$;
SQL
  $PSQL_AS_ADMIN -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'opspm360'" 2>/dev/null | grep -q 1 \
    || $PSQL_AS_ADMIN -d postgres -c "CREATE DATABASE opspm360 OWNER opspm" >/dev/null
  ok "Role 'opspm' and database 'opspm360' present"

  step "Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
  ok "Dependencies installed"

  step "Applying database migrations"
  npx prisma generate >/dev/null
  npx prisma migrate deploy
  ok "Schema (incl. Row-Level Security policies) applied"

  if [ "$SEED" = 1 ]; then
    step "Seeding demo data"
    npm run db:seed || warn "Seed failed or already applied"
    ok "Seed step finished"
  fi

  step "Building the production bundle"
  npm run build
  ok "Build complete"

  if [ "$CRON" = 1 ]; then
    step "Installing cron entries (SLA sweep every 15 min, audit retention nightly)"
    CRON_LINES="*/15 * * * * curl -fsS -X POST -H 'Authorization: Bearer ${CRON_SECRET}' http://localhost:3000/api/escalations >/dev/null 2>&1
15 2 * * * curl -fsS -X POST -H 'Authorization: Bearer ${CRON_SECRET}' http://localhost:3000/api/audit-retention >/dev/null 2>&1"
    ( crontab -l 2>/dev/null | grep -v 'api/escalations\|api/audit-retention' ; printf '%s\n' "$CRON_LINES" ) | crontab -
    ok "Cron installed for current user"
  else
    warn "Remember to schedule the SLA sweep: POST /api/escalations every 15 min (re-run with --cron to do it now)"
  fi

  if [ "$START" = 1 ]; then
    step "Starting OpsPM360"
    ok "Launching: npm run start  (Ctrl+C to stop)"
    exec npm run start
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
printf '\n%s\n' "${GRN}${BOLD}OpsPM360 installed successfully.${RST}"
printf '%s\n'   "  URL:        ${BOLD}http://localhost:3000${RST}"
if [ "$SEED" = 1 ]; then
  printf '%s\n' "  Login:      amara.kone@endeavourmining.com / Endeavour#2026 ${DIM}(change in production!)${RST}"
fi
if [ "$MODE" = "docker" ]; then
  printf '%s\n' "  Manage:     docker compose logs -f app · docker compose down"
else
  printf '%s\n' "  Start:      npm run start   ${DIM}(or re-run installer with --start)${RST}"
fi
printf '%s\n'   "  Secrets:    .env ${DIM}(kept out of git; rotate for production)${RST}"
printf '%s\n'   "  Next steps: configure OIDC_* for SSO, NOTIFY/EMAIL webhooks — see .env.example"
