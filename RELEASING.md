# Releasing dev-browser

This fork releases Windows x64 first. A tag push creates a GitHub Release, marks it as the latest release, uploads the Windows binary plus installer, then publishes the scoped npm package as `latest`.

## First-Time Setup

### GitHub

The workflow uses the built-in `GITHUB_TOKEN` to create releases. In the repository settings, make sure:

- **Settings -> Actions -> General -> Workflow permissions** is set to **Read and write permissions**.
- Tags matching `v*` are allowed to run Actions.

### npm

The package is published as:

```text
@calebrussel77/dev-browser
```

Create an npm automation token, then add it as a GitHub Actions secret:

```text
NPM_TOKEN
```

## Publish A Version

From a clean working tree:

```powershell
.\scripts\release.ps1 -Version 0.2.8
```

The release workflow triggers from the tag.

## What The Release Workflow Does

See `.github/workflows/release.yml`. On tag push (`v*`):

| Step | What happens |
| --- | --- |
| Build Windows | Bundles the daemon and sandbox client, then builds `x86_64-pc-windows-msvc` |
| GitHub Release | Uploads `dev-browser-windows-x64.exe`, its SHA256 file, and `install-windows.ps1` |
| npm latest | Publishes `@calebrussel77/dev-browser` with the `latest` dist-tag |

The npm publish happens after the GitHub Release exists because npm `postinstall` downloads the native binary from the release assets.

## Install From Latest

Windows PowerShell:

```powershell
irm https://github.com/calebrussel77/dev-browser/releases/latest/download/install-windows.ps1 | iex
dev-browser install
dev-browser --help
```

npm:

```powershell
npm install -g @calebrussel77/dev-browser
dev-browser install
dev-browser --help
```

## Verify A Published Version

```powershell
npm view @calebrussel77/dev-browser version
npm view @calebrussel77/dev-browser dist-tags
```

The `latest` dist-tag should point at the version from the pushed tag.
