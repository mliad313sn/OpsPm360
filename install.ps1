<#
.SYNOPSIS
  OpsPM360 — from-scratch installer for Windows (PowerShell 5.1+ / 7+).

.DESCRIPTION
  Installs prerequisites via winget (fallback: choco), generates secrets,
  and stands the platform up in one of two modes:
    docker  — Docker Desktop stack (db + app + SLA cron sidecar)   [default if Docker present]
    native  — Node.js 20 + PostgreSQL 16 installed on this machine

  Idempotent: safe to re-run; every step checks before acting.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode native -NoSeed -Start
#>
[CmdletBinding()]
param(
  [ValidateSet("auto", "docker", "native")] [string]$Mode = "auto",
  [switch]$NoSeed,
  [switch]$Start,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "  + $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }
function Confirm-Step($q) {
  if ($Yes) { return $true }
  $r = Read-Host "$q [Y/n]"
  return ($r -ne "n" -and $r -ne "N" -and $r -ne "no")
}

function Install-Package($wingetId, $chocoName, $display) {
  if (-not (Confirm-Step "Install missing dependency '$display'?")) { Fail "$display is required." }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install $chocoName -y
  } else {
    Fail "Neither winget nor chocolatey found. Install $display manually, then re-run."
  }
  # Refresh PATH for the current session.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

function New-Secret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([Convert]::ToBase64String($bytes)) -replace "=", ""
}

# ── Repository check ─────────────────────────────────────────────────────────
Step "Checking repository"
if (-not (Test-Path "package.json") -or -not (Select-String -Path "package.json" -Pattern '"name": "opspm360"' -Quiet)) {
  if ($env:OPSPM360_REPO) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-Package "Git.Git" "git" "Git" }
    git clone $env:OPSPM360_REPO opspm360
    Set-Location opspm360
    Ok "Cloned into .\opspm360"
  } else {
    Fail "Run from the OpsPM360 checkout, or set OPSPM360_REPO=<git-url> first."
  }
} else { Ok "Inside the OpsPM360 repository" }

# ── Mode resolution ──────────────────────────────────────────────────────────
if ($Mode -eq "auto") {
  $dockerReady = $false
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null; if ($LASTEXITCODE -eq 0) { $dockerReady = $true }
  }
  $Mode = if ($dockerReady) { "docker" } else { "native" }
}
Step "Install mode: $Mode"

# ── Secrets / .env ───────────────────────────────────────────────────────────
Step "Configuring environment (.env)"
if (Test-Path ".env") {
  Ok ".env already exists - keeping it (delete it to regenerate)"
} else {
  $dbHost = if ($Mode -eq "docker") { "db" } else { "localhost" }
  @"
DATABASE_URL="postgresql://opspm:opspm@$dbHost`:5432/opspm360?schema=public"
SESSION_SECRET="$(New-Secret)"
CRON_SECRET="$(New-Secret)"
APP_URL="http://localhost:3000"
AUDIT_RETENTION_DAYS="90"
"@ | Set-Content -Path ".env" -Encoding UTF8
  Ok "Generated .env with strong random secrets"
}
$cronSecret = (Select-String -Path ".env" -Pattern 'CRON_SECRET="([^"]+)"').Matches[0].Groups[1].Value

if ($Mode -eq "docker") {
  # ── DOCKER PATH ────────────────────────────────────────────────────────────
  Step "Ensuring Docker Desktop"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Install-Package "Docker.DockerDesktop" "docker-desktop" "Docker Desktop"
    Fail "Docker Desktop installed - start it once (WSL2 backend), then re-run this installer."
  }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker daemon not running. Start Docker Desktop, then re-run." }
  Ok "Docker ready"

  Step "Building and starting the stack (db + app + SLA cron sidecar)"
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { Fail "docker compose failed - see output above." }
  Ok "Stack started"

  Step "Waiting for the application"
  $healthy = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      Invoke-WebRequest -Uri "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $healthy = $true; break
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $healthy) { Fail "App did not become healthy in 120s - check: docker compose logs app" }
  Ok "Application answering on http://localhost:3000"

  if (-not $NoSeed) {
    Step "Seeding demo data"
    docker compose exec -T app npx tsx prisma/seed.ts
    if ($LASTEXITCODE -ne 0) { Warn "Seed failed or already applied - check: docker compose logs app" }
    Ok "Seed step finished"
  }
} else {
  # ── NATIVE PATH ────────────────────────────────────────────────────────────
  Step "Ensuring Node.js >= 20"
  $nodeOk = $false
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int]((node -p "process.versions.node.split('.')[0]"))
    if ($major -ge 20) { $nodeOk = $true }
  }
  if ($nodeOk) { Ok "node $(node -v)" }
  else {
    Install-Package "OpenJS.NodeJS.LTS" "nodejs-lts" "Node.js 20 LTS"
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node install failed - open a new terminal and re-run." }
    Ok "node $(node -v) installed"
  }

  Step "Ensuring PostgreSQL 16"
  $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pgService) {
    Install-Package "PostgreSQL.PostgreSQL.16" "postgresql16" "PostgreSQL 16"
    $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pgService) { Fail "PostgreSQL service not found after install - re-run from a new terminal." }
  }
  if ($pgService.Status -ne "Running") { Start-Service $pgService.Name }
  Ok "PostgreSQL service running ($($pgService.Name))"

  Step "Provisioning database role + database (idempotent)"
  $psql = Get-Command psql -ErrorAction SilentlyContinue
  if (-not $psql) {
    $pgBin = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
             Sort-Object FullName -Descending | Select-Object -First 1
    if ($pgBin) { $env:Path += ";" + $pgBin.DirectoryName } else { Fail "psql.exe not found on PATH." }
  }
  Warn "If prompted for a password, enter the 'postgres' superuser password chosen during PostgreSQL setup."
  psql -U postgres -d postgres -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='opspm') THEN CREATE ROLE opspm LOGIN PASSWORD 'opspm'; END IF; END `$`$;"
  $dbExists = psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='opspm360'"
  if ($dbExists -notmatch "1") { psql -U postgres -d postgres -c "CREATE DATABASE opspm360 OWNER opspm" }
  Ok "Role 'opspm' and database 'opspm360' present"

  Step "Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }

  Step "Applying database migrations"
  npx prisma generate | Out-Null
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { Fail "Migrations failed." }
  Ok "Schema (incl. Row-Level Security policies) applied"

  if (-not $NoSeed) {
    Step "Seeding demo data"
    npm run db:seed
    if ($LASTEXITCODE -ne 0) { Warn "Seed failed or already applied" }
  }

  Step "Building the production bundle"
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "Build failed." }
  Ok "Build complete"

  Step "Registering scheduled tasks (SLA sweep / audit retention)"
  $sweep = "Invoke-WebRequest -UseBasicParsing -Method POST -Headers @{Authorization='Bearer $cronSecret'} -Uri http://localhost:3000/api/escalations"
  $retain = "Invoke-WebRequest -UseBasicParsing -Method POST -Headers @{Authorization='Bearer $cronSecret'} -Uri http://localhost:3000/api/audit-retention"
  try {
    schtasks /Create /F /SC MINUTE /MO 15 /TN "OpsPM360 SLA Sweep" /TR "powershell -NoProfile -Command `"$sweep`"" | Out-Null
    schtasks /Create /F /SC DAILY /ST 02:15 /TN "OpsPM360 Audit Retention" /TR "powershell -NoProfile -Command `"$retain`"" | Out-Null
    Ok "Scheduled tasks registered"
  } catch { Warn "Could not register scheduled tasks (needs admin) - schedule POST /api/escalations every 15 min manually." }

  if ($Start) {
    Step "Starting OpsPM360 (Ctrl+C to stop)"
    npm run start
  }
}

Write-Host ""
Write-Host "OpsPM360 installed successfully." -ForegroundColor Green
Write-Host "  URL:    http://localhost:3000"
if (-not $NoSeed) { Write-Host "  Login:  amara.kone@endeavourmining.com / Endeavour#2026  (change in production!)" }
if ($Mode -eq "docker") { Write-Host "  Manage: docker compose logs -f app | docker compose down" }
else { Write-Host "  Start:  npm run start   (or re-run with -Start)" }
Write-Host "  Next:   configure OIDC_* for SSO and notification webhooks - see .env.example"
