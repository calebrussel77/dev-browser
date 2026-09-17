import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const daemonDir = fileURLToPath(new URL("../../", import.meta.url));
const repoDir = path.resolve(daemonDir, "..");
const entryPoint = path.resolve(daemonDir, "src/sandbox/playwright-internals.ts");
const testId = `${process.pid}-${Date.now()}`;
const temporaryDir = path.resolve(daemonDir, `.playwright-internals-${testId}`);
const generatedFiles: string[] = [];

async function expectBundleToResolvePlaywright(outfile: string, cwd: string): Promise<void> {
  await mkdir(path.dirname(outfile), { recursive: true });
  generatedFiles.push(outfile);

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    outfile,
    platform: "node",
    target: "node20",
  });

  await expect(execFileAsync(process.execPath, [outfile], { cwd })).resolves.toMatchObject({
    stderr: "",
  });
}

afterAll(async () => {
  await Promise.all(generatedFiles.map((file) => rm(file, { force: true })));
  await rm(temporaryDir, { force: true, recursive: true });
});

describe("Playwright internal resolution", () => {
  it("resolves playwright-core from daemon/node_modules for the direct daemon bundle", async () => {
    await expectBundleToResolvePlaywright(
      path.resolve(daemonDir, "dist", `playwright-internals-${testId}.mjs`),
      repoDir
    );
  });

  it.each([
    {
      name: "two directories above the current module",
      outfile: path.resolve(temporaryDir, "sandbox", "playwright-internals.mjs"),
      cwd: repoDir,
    },
    {
      name: "below the current module directory",
      outfile: path.resolve(daemonDir, `playwright-internals-${testId}.mjs`),
      cwd: repoDir,
    },
    {
      name: "below the process working directory",
      outfile: path.resolve(repoDir, `playwright-internals-${testId}.mjs`),
      cwd: daemonDir,
    },
  ])("keeps the existing fallback $name", async ({ outfile, cwd }) => {
    await expectBundleToResolvePlaywright(outfile, cwd);
  });
});
