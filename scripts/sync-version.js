#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const cliDir = join(projectRoot, 'cli');
const marketplaceJsonPath = join(projectRoot, '.claude-plugin', 'marketplace.json');
const packageJsonPath = join(projectRoot, 'package.json');
const packageLockPath = join(projectRoot, 'package-lock.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const requestedVersion = process.argv[2];
const version = requestedVersion ?? packageJson.version;
const cargoTomlPath = join(cliDir, 'Cargo.toml');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver version: ${version}`);
  process.exit(1);
}

if (packageJson.version !== version) {
  packageJson.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Updated package.json to version ${version}.`);
} else {
  console.log(`package.json already matches version ${version}.`);
}

if (existsSync(packageLockPath)) {
  const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
  packageLock.version = version;

  if (packageLock.name !== packageJson.name) {
    packageLock.name = packageJson.name;
  }

  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = version;
    packageLock.packages[''].name = packageJson.name;
  }

  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  console.log(`Updated package-lock.json to version ${version}.`);
}

let cargoToml = readFileSync(cargoTomlPath, 'utf8');
const versionLine = `version = "${version}"`;
const versionPattern = /^version\s*=\s*"[^"]*"$/m;

if (!versionPattern.test(cargoToml)) {
  console.error('Could not find the version field in cli/Cargo.toml.');
  process.exit(1);
}

if (!cargoToml.includes(versionLine)) {
  cargoToml = cargoToml.replace(versionPattern, versionLine);
  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`Updated cli/Cargo.toml to version ${version}.`);

  try {
    execSync('cargo update -p dev-browser --offline', {
      cwd: cliDir,
      stdio: 'pipe',
    });
    console.log('Updated cli/Cargo.lock.');
  } catch {
    try {
      execSync('cargo update -p dev-browser', {
        cwd: cliDir,
        stdio: 'pipe',
      });
      console.log('Updated cli/Cargo.lock.');
    } catch (error) {
      console.warn(`Warning: Could not update cli/Cargo.lock: ${error.message}`);
    }
  }
} else {
  console.log(`cli/Cargo.toml already matches package.json version ${version}.`);
}

const marketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, 'utf8'));

if (!marketplaceJson.metadata) {
  marketplaceJson.metadata = {};
}

if (marketplaceJson.metadata.version !== version) {
  marketplaceJson.metadata.version = version;
  writeFileSync(marketplaceJsonPath, `${JSON.stringify(marketplaceJson, null, 2)}\n`);
  console.log(`Updated .claude-plugin/marketplace.json to version ${version}.`);
} else {
  console.log(`.claude-plugin/marketplace.json already matches package.json version ${version}.`);
}
