# MemexOS one-line installer — native Windows (Phase 15 G2).
#
#   iex (irm https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.ps1)
#
# Idempotent: re-running updates the existing checkout and never overwrites
# an existing ~/.memex/config.json. Targets Windows PowerShell 5.1+ (no && / ternary).

$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:MEMEX_REPO_URL) { $env:MEMEX_REPO_URL } else { 'https://github.com/ClydeShen/graph-enginerring.git' }
$InstallDir = if ($env:MEMEX_INSTALL_DIR) { $env:MEMEX_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.memex\app' }
$MemexHome  = Join-Path $env:USERPROFILE '.memex'

function Fail([string]$msg) { Write-Error "install: $msg"; exit 1 }

# -- 1. Dependency checks (detect, never silently install system-level deps) --
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'git is required. Install from https://git-scm.com and re-run.'
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail 'Node 22+ is required. Install via winget (winget install OpenJS.NodeJS.LTS) or https://nodejs.org, then re-run.'
}
$nodeMajor = [int]((node -v) -replace '^v','' -split '\.')[0]
if ($nodeMajor -lt 22) { Fail "Node >= 22 required (found $(node -v))." }

# -- 2. PostgreSQL: reuse a reachable server, otherwise point at Docker -------
$pgHint = ''
$pgReady = Get-Command pg_isready -ErrorAction SilentlyContinue
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
$pgLocal = $false
if ($pgReady) {
  & pg_isready -q 2>$null
  if ($LASTEXITCODE -eq 0) { $pgLocal = $true }
}
if ($pgLocal) {
  Write-Host '[ok] local PostgreSQL detected - reusing it (ensure pgvector + pgcrypto are installed)'
} elseif ($dockerCmd) {
  $pgHint = 'docker'
  Write-Host '[!] no local PostgreSQL - will use the bundled Docker compose (pgvector image)'
} else {
  Write-Host '[!] no PostgreSQL and no Docker found.'
  Write-Host '    Install Docker Desktop (https://docs.docker.com/get-docker/) or PostgreSQL 16+ with pgvector+pgcrypto, then re-run.'
  exit 1
}

# -- 3. Clone or update --------------------------------------------------------
if (Test-Path (Join-Path $InstallDir '.git')) {
  Write-Host "[ok] existing install at $InstallDir - updating"
  git -C $InstallDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Fail 'git pull failed' }
} else {
  New-Item -ItemType Directory -Force (Split-Path $InstallDir) | Out-Null
  git clone --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
}

Set-Location $InstallDir
Write-Host 'installing npm dependencies...'
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }

# -- 4. Database bring-up + migrations ------------------------------------------
if ($pgHint -eq 'docker') {
  Write-Host 'starting PostgreSQL via docker compose...'
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed' }
  if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgres://postgres:password@localhost:5432/graph_test' }
} else {
  if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgres://localhost:5432/memex' }
}
Write-Host 'running migrations...'
npx tsx scripts/migrate.ts
if ($LASTEXITCODE -ne 0) { Fail 'migrations failed' }

# -- 5. Install stamp (managed-mode marker for onboarding) -----------------------
New-Item -ItemType Directory -Force $MemexHome | Out-Null
$version = node -p "require('./package.json').version"
$stamp = @{
  method       = 'git'
  version      = $version
  installed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  install_dir  = $InstallDir
} | ConvertTo-Json
Set-Content -Path (Join-Path $MemexHome 'install.json') -Value $stamp -Encoding utf8

# -- 6. Hand off to onboarding ----------------------------------------------------
Write-Host ''
Write-Host "MemexOS installed at $InstallDir (v$version)"
Write-Host "next: cd $InstallDir; npx tsx packages/cli/src/index.ts onboard"
Write-Host 'diagnose anytime: npx tsx packages/cli/src/index.ts doctor'
