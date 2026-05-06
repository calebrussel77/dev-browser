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

git push $Remote $Branch
git push $Remote $Tag
Write-Host "Pushed $Tag. GitHub Actions will publish the release."
