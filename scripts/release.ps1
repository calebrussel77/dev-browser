param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [string]$Remote = "origin",
  [string]$Branch = "main",
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Invalid semver version: $Version"
}

$Tag = "v$Version"
$Status = git status --short
if ($Status) {
  Write-Host "Working tree is not clean. The release script will include existing changes:"
  $Status | ForEach-Object { Write-Host $_ }
}

node scripts/sync-version.js $Version

git add package.json package-lock.json cli/Cargo.toml cli/Cargo.lock .claude-plugin/marketplace.json
git commit -m "chore(release): $Tag"
git tag $Tag

if ($NoPush) {
  Write-Host "Created release commit and tag $Tag locally."
  exit 0
}

git push $Remote "HEAD:$Branch"
git push $Remote $Tag
Write-Host "Pushed $Tag."

# Forks do not always fire tag-push workflows, so fall back to a manual
# dispatch when no Release run shows up for the tag.
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host "gh not found; check that the Release workflow started for $Tag."
  exit 0
}

$Started = $false
for ($i = 0; $i -lt 6 -and -not $Started; $i++) {
  Start-Sleep -Seconds 5
  $Runs = gh run list --workflow release.yml --event push --branch $Tag --limit 1 --json databaseId | ConvertFrom-Json
  $Started = $Runs.Count -gt 0
}

if ($Started) {
  Write-Host "Release workflow started from the tag push."
} else {
  Write-Host "No tag-push run detected; dispatching the Release workflow for $Tag."
  gh workflow run release.yml -f tag=$Tag
}
