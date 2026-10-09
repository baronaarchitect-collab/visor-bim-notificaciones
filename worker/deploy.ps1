# Despliega el BIM Hub Visor en Cloudflare.
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
# La primera vez crea la base D1 y el bucket R2 privado; después solo re-despliega.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) { npm install --no-fund --no-audit }

# 1) Sesión de Cloudflare
npx wrangler whoami 2>&1 | Out-String | Tee-Object -Variable who | Out-Null
if ($who -match "not authenticated|Not logged in") {
  Write-Host "Inicia sesión en Cloudflare (se abre el navegador)..." -ForegroundColor Yellow
  npx wrangler login
}

# 2) Base de datos D1 (solo la primera vez)
$toml = Get-Content wrangler.toml -Raw
if ($toml -match 'database_id = "REEMPLAZAR_CON_DEPLOY"') {
  Write-Host "Creando base D1 bim_hub_visor..." -ForegroundColor Cyan
  $out = npx wrangler d1 create bim_hub_visor 2>&1 | Out-String
  $id = [regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}').Value
  if (-not $id) {
    # ya existía: buscar su id
    $list = npx wrangler d1 list --json 2>$null | Out-String | ConvertFrom-Json
    $id = ($list | Where-Object { $_.name -eq "bim_hub_visor" }).uuid
  }
  if (-not $id) { throw "No se pudo obtener el id de la base D1:`n$out" }
  $toml = $toml -replace 'REEMPLAZAR_CON_DEPLOY', $id
  [IO.File]::WriteAllText("$PSScriptRoot\wrangler.toml", $toml)
  Write-Host "D1 id: $id" -ForegroundColor Green
}

# 3) Bucket R2 privado (si ya existe, wrangler avisa y seguimos)
Write-Host "Verificando bucket R2 bim-hub-privado..." -ForegroundColor Cyan
npx wrangler r2 bucket create bim-hub-privado 2>&1 | Out-String | Write-Host

# 4) Esquema (idempotente: CREATE TABLE IF NOT EXISTS)
npx wrangler d1 execute bim_hub_visor --remote --file=schema.sql --yes

# 5) Publicar Worker + página
npx wrangler deploy
Write-Host ""
Write-Host "Listo. Recuerda en Firebase (lifecity-bim-hub): Authentication → Google habilitado," -ForegroundColor Yellow
Write-Host "y Settings → Authorized domains → agregar el dominio *.workers.dev que aparece arriba." -ForegroundColor Yellow
