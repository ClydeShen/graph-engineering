#!/bin/sh
# MemexOS one-line installer — Linux / macOS / WSL2 (Phase 15 G2).
#
#   curl -fsSL https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.sh | sh
#
# Idempotent: re-running updates the existing checkout and never overwrites
# an existing ~/.memex/config.json. Pure POSIX sh — no bashisms.

set -eu

REPO_URL="${MEMEX_REPO_URL:-https://github.com/ClydeShen/graph-enginerring.git}"
INSTALL_DIR="${MEMEX_INSTALL_DIR:-$HOME/.memex/app}"
MEMEX_HOME="$HOME/.memex"

say()  { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

# ── 0. WSL2 detection (Phase 18 — first-class support) ───────────────────────
IS_WSL=0
if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
  say "✓ WSL2 detected — localhost forwarding lets the Windows browser reach the dashboard"
  if [ ! -d /run/systemd/system ]; then
    say "! systemd is off in this distro — service install will be unavailable."
    say "  enable: printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf  (then: wsl --shutdown)"
  fi
  if [ -d /mnt/c/Windows ]; then
    say "! /mnt/c is mounted: the local exec backend can reach the Windows filesystem."
    say "  prefer the docker execution backend, or disable automount (ADR-48 WSL2 appendix)."
  fi
fi

# ── 1. Dependency checks (detect, never silently install system-level deps) ──
# Minimal distros (e.g. Kali minimal under WSL) lack curl/git — give the apt path.
command -v git >/dev/null 2>&1 || {
  [ "$IS_WSL" = "1" ] && fail "git is required. apt update && apt install -y git curl, then re-run."
  fail "git is required. Install git and re-run."
}

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$NODE_MAJOR" -ge 22 ] || fail "Node >= 22 required (found $(node -v)). Use fnm/nvm: https://nodejs.org"
else
  fail "Node 22+ is required. Install via fnm/nvm or https://nodejs.org, then re-run."
fi

# ── 2. PostgreSQL: reuse a reachable server, otherwise point at Docker ───────
PG_HINT=""
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
  say "✓ local PostgreSQL detected — reusing it (ensure pgvector + pgcrypto are installed)"
elif command -v docker >/dev/null 2>&1; then
  PG_HINT="docker"
  say "! no local PostgreSQL — will use the bundled Docker compose (pgvector image)"
else
  say "! no PostgreSQL and no Docker found."
  say "  Install Docker (https://docs.docker.com/get-docker/) or PostgreSQL 16+ with pgvector+pgcrypto, then re-run."
  exit 1
fi

# ── 3. Clone or update ────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "✓ existing install at $INSTALL_DIR — updating"
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
say "installing npm dependencies…"
npm ci --no-audit --no-fund

# ── 4. Database bring-up + migrations ────────────────────────────────────────
if [ "$PG_HINT" = "docker" ]; then
  say "starting PostgreSQL via docker compose…"
  docker compose up -d postgres
  DATABASE_URL="${DATABASE_URL:-postgres://postgres:password@localhost:5432/graph_test}"
else
  DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/memex}"
fi
export DATABASE_URL
say "running migrations…"
npx tsx scripts/migrate.ts

# ── 5. Install stamp (managed-mode marker for onboarding) ─────────────────────
mkdir -p "$MEMEX_HOME"
VERSION="$(node -p "require('./package.json').version")"
cat > "$MEMEX_HOME/install.json" <<EOF
{
  "method": "git",
  "version": "$VERSION",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "install_dir": "$INSTALL_DIR"
}
EOF

# ── 6. Hand off to onboarding (skipped when piped non-interactively) ──────────
say ""
say "MemexOS installed at $INSTALL_DIR (v$VERSION)"
if [ -t 0 ]; then
  npx tsx packages/cli/src/index.ts onboard
else
  say "next: cd $INSTALL_DIR && npx tsx packages/cli/src/index.ts onboard"
fi
say "diagnose anytime: npx tsx packages/cli/src/index.ts doctor"
