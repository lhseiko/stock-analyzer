# Stock Analyzer - GITHUB backup of the pure-text core only.
# NO secret (ai_config.json), NO 98MB db, NO 612MB reports (GitHub limits + daily churn).
# Stages the safe subset into an independent git repo and commits locally.
# Push happens only AFTER the agent sets the remote (user creates the private repo first).
$ErrorActionPreference = 'Stop'
$proj = "D:\stock analyzer\stock-analyzer"
$staging = "D:\stock-analyzer-backup\github-staging"
if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }
$safe = @(
  (Join-Path $proj "data\notes.json"),
  (Join-Path $proj "data\judgments"),
  (Join-Path $proj "data\valuation"),
  (Join-Path $proj "data\fund_holdings"),
  (Join-Path $proj "data\companies")
)
foreach ($s in $safe) {
  if (-not (Test-Path $s)) { Write-Warning "skip missing: $s"; continue }
  $name = Split-Path $s -Leaf
  $d = Join-Path $staging $name
  robocopy $s $d /MIR /R:2 /W:5 /NP | Out-Null
}
Set-Location $staging
if (-not (Test-Path ".git")) {
  git init -q
  git config user.email "backup@stock-analyzer.local"
  git config user.name "Stock Analyzer Backup"
  git branch -M main
}
git add -A
$ts = Get-Date -Format "yyyy-MM-dd HH:mm"
$out = git commit -q -m "backup: $ts" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "GITHUB STAGING OK -> committed locally at $ts"
} else {
  Write-Host "GITHUB STAGING: nothing new to commit (already up to date)"
}
git -C $staging log --oneline -1
$hasRemote = git -C $staging remote -v
if ([string]::IsNullOrWhiteSpace($hasRemote)) {
  Write-Host "REMOTE NOT SET: agent will run 'git remote add origin <private-repo-url>' and 'git push -u origin main' after the user creates the private repo."
}
