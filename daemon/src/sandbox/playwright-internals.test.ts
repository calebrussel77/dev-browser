import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const daemonDir = fileURLToPath(new URL("../../", import.meta.url));
const repoDir = path.resolve(daemonDir, "..");
const testId = `${process.pid}-${Date.now()}`;
const temporaryDir = path.resolve(daemonDir, `.playwright-internals-${testId}`);
const generatedFiles: string[] = [];

async function buildResolutionProbe(outfile: string): Promise<void> {
  await mkdir(path.dirname(outfile), { recursive: true });
  generatedFiles.push(outfile);

  await build({
    stdin: {
      contents: `
        import { tryResolvePlaywrightInternal } from "./src/sandbox/playwright-internals.js";
        console.log(tryResolvePlaywrightInternal("lib/coreBundle.js"));
      `,
      loader: "ts",
      resolveDir: daemonDir,
      sourcefile: "playwright-resolution-probe.ts",
    },
    bundle: true,
    format: "esm",
    outfile,
    platform: "node",
    target: "node20",
  });
}

async function runResolutionProbe(outfile: string, cwd: string): Promise<string> {
  const result = await execFileAsync(process.execPath, [outfile], { cwd });
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

async function createPlaywrightCoreFixture(packageDir: string): Promise<void> {
  await mkdir(path.resolve(packageDir, "lib"), { recursive: true });
  await writeFile(path.resolve(packageDir, "package.json"), '{"type":"commonjs"}\n');
  await writeFile(
    path.resolve(packageDir, "lib/coreBundle.js"),
    `
      module.exports = {
        inprocess: {
          playwright: {
            _connection: { constructor: class Connection {} },
            _platform: {},
          },
        },
        server: {
          createPlaywright() {},
          DispatcherConnection: class DispatcherConnection {},
          RootDispatcher: class RootDispatcher {},
          PlaywrightDispatcher: class PlaywrightDispatcher {},
        },
      };
    `
  );
}

afterAll(async () => {
  await Promise.all(generatedFiles.map((file) => rm(file, { force: true })));
  await rm(temporaryDir, { force: true, recursive: true });
});

describe("Playwright internal resolution", () => {
  it("selects the first installed playwright-core candidate for the direct daemon bundle", async () => {
    const outfile = path.resolve(daemonDir, "dist", `playwright-internals-${testId}.mjs`);
    const modulePath = "lib/coreBundle.js";
    const rootCandidate = path.resolve(repoDir, "node_modules/playwright-core", modulePath);
    const expected = [
      rootCandidate,
      path.resolve(daemonDir, "node_modules/playwright-core", modulePath),
      path.resolve(daemonDir, "dist/node_modules/playwright-core", modulePath),
      rootCandidate,
    ].find(existsSync);

    expect(expected).toBeDefined();
    await buildResolutionProbe(outfile);

    await expect(runResolutionProbe(outfile, repoDir)).resolves.toBe(expected);
  });

  it.each([
    {
      candidateIndex: 0,
      expectedPackage: "node_modules/playwright-core",
      name: "two directories above the current module",
    },
    {
      candidateIndex: 1,
      expectedPackage: "daemon/node_modules/playwright-core",
      name: "daemon/node_modules from a daemon/dist bundle",
    },
    {
      candidateIndex: 2,
      expectedPackage: "daemon/dist/node_modules/playwright-core",
      name: "below the current module directory",
    },
    {
      candidateIndex: 3,
      expectedPackage: "cwd/node_modules/playwright-core",
      name: "below the process working directory",
    },
  ])(
    "selects $name before every later fallback",
    async ({ candidateIndex, expectedPackage, name }) => {
      const fixtureDir = path.resolve(temporaryDir, name.replaceAll(" ", "-"));
      const bundleDir = path.resolve(fixtureDir, "daemon/dist");
      const cwd = path.resolve(fixtureDir, "cwd");
      const outfile = path.resolve(bundleDir, "playwright-internals.mjs");
      const candidates = [
        path.resolve(bundleDir, "../../node_modules/playwright-core"),
        path.resolve(bundleDir, "../node_modules/playwright-core"),
        path.resolve(bundleDir, "node_modules/playwright-core"),
        path.resolve(cwd, "node_modules/playwright-core"),
      ];

      await mkdir(cwd, { recursive: true });
      await Promise.all(candidates.slice(candidateIndex).map(createPlaywrightCoreFixture));
      await buildResolutionProbe(outfile);

      await expect(runResolutionProbe(outfile, cwd)).resolves.toBe(
        path.resolve(fixtureDir, expectedPackage, "lib/coreBundle.js")
      );
    }
  );
});
