# Push app code changes (docs/, tools/, README) to GitHub; Pages redeploys in about a minute.
# Data is NOT published this way — it lives in Firestore and updates live.
# Usage: tools\publish.ps1 [-Message "what changed"]
param([string]$Message = "Update app")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    if (Test-Path docs\data.json) { throw "docs\data.json (demo data) exists - delete it before publishing" }
    git add docs tools README.md firestore.rules .gitignore
    $staged = git diff --cached --name-only
    if ($staged -match 'firebase-key|backups/|data\.json') { throw "refusing: a secret or data file is staged: $staged" }
    if (-not $staged) { "nothing to publish"; return }
    git commit -q -m $Message
    git push -q
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    "published: $Message"
} finally { Pop-Location }
