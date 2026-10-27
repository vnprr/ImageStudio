# Buduje interfejs i kopiuje kod do zainstalowanej aplikacji. Nie dotyka danych (data/) ani modeli (models/).
#   powershell -File tools/deploy.ps1 -AppDir "D:\Apps\ImageStudio"          # albo ustaw zmienną IMAGE_STUDIO_APP
param(
  [string]$AppDir = $env:IMAGE_STUDIO_APP,
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
if (-not $AppDir) { throw "Podaj -AppDir albo ustaw IMAGE_STUDIO_APP (folder zainstalowanej aplikacji)." }
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force $AppDir | Out-Null

if (-not $SkipBuild) {
  Push-Location "$repo\frontend"
  try {
    if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { throw "npm ci nie powiodło się" } }
    npm run build; if ($LASTEXITCODE) { throw "npm run build nie powiodło się" }
  } finally { Pop-Location }
}

# /MIR: kod w folderze aplikacji ma być lustrem repozytorium (usuwa pliki, których już nie ma w kodzie)
robocopy "$repo\backend" "$AppDir\backend" /MIR /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null
robocopy "$repo\frontend\dist" "$AppDir\frontend\dist" /MIR /NFL /NDL /NJH /NJS | Out-Null
robocopy "$repo\assets" "$AppDir\assets" /E /NFL /NDL /NJH /NJS | Out-Null
foreach ($f in "launcher.pyw", "run.bat") { Copy-Item "$repo\$f" "$AppDir\$f" -Force }

if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
  Write-Warning "Aplikacja działa (port 8765): zamknij ją i uruchom ponownie, żeby załadować nowy kod."
}
Write-Host "Gotowe: $AppDir (data/ i models/ nietknięte)"
