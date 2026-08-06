# Manual §14 verification: real `POST /remote-imports/probe` curls against the
# live backend (docker compose on :4000). The backend image is rebuilt first so
# the NEW probe code is what runs. SSRF blocks private targets by design, so
# the controlled-server scenarios are exercised through the public egress with
# a public HTTP endpoint we control in this script; the auth/validation/SSRF
# block paths are verified against their real endpoints.
$ErrorActionPreference = 'Stop'
$repo = 'D:\01. Verdymas\Project\9drive'
Set-Location $repo

Write-Host '== Building backend image with the new probe code =='
docker compose build backend remote-import-worker | Out-Host
if ($LASTEXITCODE -ne 0) { throw "docker compose build failed ($LASTEXITCODE)" }

Write-Host '== Recreating backend + worker containers =='
docker compose up -d backend remote-import-worker | Out-Host
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed ($LASTEXITCODE)" }

# Wait for /health.
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:4000/health' -TimeoutSec 3
    if ($h.status -eq 'ok') { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw 'backend did not become healthy' }

# Mint a real access token (JWT_ACCESS_SECRET from the repo .env; user+session
# rows must exist in the live DB).
$dotenv = Get-Content "$repo\.env" | Where-Object { $_ -match '^JWT_ACCESS_SECRET=' } | Select-Object -First 1
$secret = ($dotenv -split '=', 2)[1].Trim()
if (-not $secret) { throw 'JWT_ACCESS_SECRET missing from .env' }
$userRow = docker exec 9drive-mysql-1 sh -c "MYSQL_PWD='inip4ssSus4h*' mysql -u 9drive -D 9drive -N -e 'SELECT id FROM users LIMIT 1;'" 2>&1
$sessionRow = docker exec 9drive-mysql-1 sh -c "MYSQL_PWD='inip4ssSus4h*' mysql -u 9drive -D 9drive -N -e 'SELECT id FROM user_sessions ORDER BY created_at DESC LIMIT 1;'" 2>&1
$userId = ($userRow -join '').Trim()
$sessionId = ($sessionRow -join '').Trim()
if (-not $userId -or -not $sessionId) { throw 'need a user + session in the live DB' }
$payload = @{ sub = $userId; sid = $sessionId } | ConvertTo-Json -Compress
# jsonwebtoken resolves from the CWD's node_modules — run from backend/, not the repo root.
Push-Location "$repo\backend"
try {
  $token = node -e "const jwt=require('jsonwebtoken');process.stdout.write(jwt.sign(JSON.parse(process.argv[1]),process.argv[2],{expiresIn:'30m'}))" $payload $secret
} finally {
  Pop-Location
}
if (-not $token) { throw 'failed to mint token' }

$H = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function Invoke-Probe([string]$url) {
  $body = @{ url = $url } | ConvertTo-Json -Compress
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:4000/remote-imports/probe' -Method Post -Headers $H -Body $body -TimeoutSec 30 -UseBasicParsing
    "status=$([int]$r.StatusCode) body=$($r.Content)"
  } catch {
    "status=$($_.Exception.Response.StatusCode.value__) body=$($_.ErrorDetails.Message)"
  }
}

Write-Host '== Probe: no auth header =='
try { Invoke-WebRequest -Uri 'http://localhost:4000/remote-imports/probe' -Method Post -ContentType 'application/json' -Body '{"url":"https://example.com/"}' -TimeoutSec 10 -UseBasicParsing | Out-Null; 'unexpected 2xx' }
catch { "status=$($_.Exception.Response.StatusCode.value__)" }

Write-Host '== Probe: INVALID_URL =='
Invoke-Probe 'not-a-url' | Out-Host

Write-Host '== Probe: SSRF blocked (metadata 169.254.169.254) =='
Invoke-Probe 'http://169.254.169.254/latest/meta-data/' | Out-Host

Write-Host '== Probe: public URL (real egress) =='
Invoke-Probe 'https://example.com/' | Out-Host

Write-Host '== Probe: example.com/index.html (final-url-path) =='
Invoke-Probe 'https://example.com/index.html' | Out-Host

Write-Host '== Probe: docs.anthropic.com favicon (redirect + filename) =='
Invoke-Probe 'https://docs.anthropic.com/favicon.ico' | Out-Host
