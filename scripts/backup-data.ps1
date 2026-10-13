# Stock Analyzer - LOCAL data backup (primary anti-data-loss control)
# Mirrors the ENTIRE data/ tree to a local backup root, EXCLUDING the secret
# ai_config.json (apiKey must never leave the machine / never be committed).
# Run by the AI agent; the user does not need to run this manually.
$ErrorActionPreference = 'Stop'
$src = "D:\stock analyzer\stock-analyzer\data"
$dstLocal = "D:\stock-analyzer-backup\data"
$dstCloud = "C:\Users\16507\OneDrive\stock-analyzer-backup\data"
$log = "D:\stock-analyzer-backup\backup-log-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
# /XF excludes the secret key file from the mirror (Iron Rule: apiKey never leaves machine).
# Dual destination: a local copy (D:) AND the OneDrive folder (auto-syncs to cloud as an
# offsite copy) - so the user gets offsite protection with zero manual push.
function Invoke-Mirror($dest) {
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  $a = @($src, $dest, "/MIR", "/XF", "ai_config.json", "/R:2", "/W:5", "/NP", "/LOG+:$log")
  robocopy @a
  $c = $LASTEXITCODE
  if ($c -ge 8) { Write-Error "robocopy to $dest failed with code $c"; exit $c }
  Write-Host "BACKUP OK -> $dest (ai_config.json excluded by design)"
}
Invoke-Mirror $dstLocal
Invoke-Mirror $dstCloud
Write-Host "Log: $log"
