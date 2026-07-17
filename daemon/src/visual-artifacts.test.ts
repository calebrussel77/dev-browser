import { readFile, rm } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BrowserManager } from "./browser-manager.js";
import { collectPageState } from "./perception/collector.js";
import { removeDirectoryWithRetries } from "./test-cleanup.js";
import { captureVisualArtifacts, planAnnotationLabels } from "./visual-artifacts.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe.sequential("visual artifacts", () => {
  let manager: BrowserManager;
  let browserRoot = "";

  beforeAll(async () => {
    browserRoot = await mkdtemp(path.join(os.tmpdir(), "dev-browser-visual-"));
    manager = new BrowserManager(path.join(browserRoot, "browsers"));
    await manager.ensureBrowser("visual", { headless: true });
  }, 180_000);

  afterAll(async () => {
    await manager.stopAll();
    await removeDirectoryWithRetries(browserRoot);
  }, 180_000);

  it("captures the scrolled viewport in CSS pixels rather than document origin", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 320, height: 180 });
    await page.setContent(`
      <style>body{margin:0}.origin{height:240px;background:#f00}.target{height:180px;background:#00f}</style>
      <div class="origin"></div><button class="target">Scrolled target</button>
    `);
    await page.evaluate(() => scrollTo(0, 240));
    const state = await collectPageState(page);

    const result = await captureVisualArtifacts(page, state, {
      screenshotName: `visual-tests/scrolled-${Date.now()}.png`,
    });
    const artifact = result.screenshot!;
    const png = await readFile(artifact.path);

    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({
      width: 320,
      height: 180,
    });
    expect(artifact).toMatchObject({
      width: 320,
      height: 180,
      mode: "viewport",
      origin: { x: 0, y: 0 },
      coordinateSpace: { kind: "viewport", scroll: { x: 0, y: 240 } },
    });
    const pixel = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(10, 10, 1, 1).data);
      },
      `data:image/png;base64,${png.toString("base64")}`
    );
    expect(pixel.slice(0, 3)).toEqual([0, 0, 255]);
    await rm(artifact.path, { force: true });
  });

  it("uses bounded CDP captures for animated viewport, document, crop, and annotated screenshots", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 320, height: 180 });
    await page.setContent(`
      <style>
        body { margin: 0; height: 720px; }
        .animated { width: 80px; height: 80px; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <input autofocus value="blinking caret"><div class="animated"></div><button style="position:absolute;top:360px">Target</button>
    `);
    await page.evaluate(() => {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { ready: new Promise(() => {}) },
      });
    });
    const state = await collectPageState(page, { full: true });
    const onePixel = await page.screenshot({ scale: "css", clip: { x: 0, y: 0, width: 1, height: 1 } });
    const session = {
      send: vi.fn().mockResolvedValue({ data: onePixel.toString("base64") }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const newSession = vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(session as never);
    const screenshot = vi.spyOn(page, "screenshot").mockImplementation(() => new Promise(() => {}));

    try {
      const started = Date.now();
      const captureWithin = <T>(capture: Promise<T>) =>
        Promise.race([
          capture,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("screenshot did not complete before its deadline")), 250)
          ),
        ]);
      const viewport = await captureWithin(captureVisualArtifacts(page, state, {
        screenshotName: `visual-tests/bounded-viewport-${Date.now()}.png`,
        timeoutMs: 250,
      }));
      const fullPage = await captureWithin(captureVisualArtifacts(page, state, {
        screenshotName: `visual-tests/bounded-full-${Date.now()}.png`,
        fullPage: true,
        timeoutMs: 250,
      }));
      const crop = await captureWithin(captureVisualArtifacts(page, state, {
        screenshotName: `visual-tests/bounded-crop-${Date.now()}.png`,
        fullPage: true,
        focus: { box: { x: 0, y: 360, width: 80, height: 40 }, padding: 8 },
        timeoutMs: 250,
      }));
      const annotated = await captureWithin(captureVisualArtifacts(page, state, {
        annotatedName: `visual-tests/bounded-annotated-${Date.now()}.png`,
        annotate: true,
        timeoutMs: 250,
      }));

      expect(Date.now() - started).toBeLessThan(1_000);
      for (const artifact of [viewport.screenshot, fullPage.screenshot, crop.screenshot, annotated.annotatedScreenshot]) {
        expect(artifact).toMatchObject({ captureMode: "cdp" });
        await rm(artifact!.path, { force: true });
      }
      expect(session.send).toHaveBeenCalledWith("Page.captureScreenshot", expect.objectContaining({ format: "png", fromSurface: true }));
    } finally {
      screenshot.mockRestore();
      newSession.mockRestore();
    }
  });

  it("shares one deadline across CDP session creation and capture", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setContent("<button>Deadline target</button>");
    const state = await collectPageState(page);
    const session = {
      send: vi.fn().mockImplementation(() => new Promise(() => {})),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const newSession = vi
      .spyOn(page.context(), "newCDPSession")
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(session as never), 300))
      );
    const screenshot = vi.spyOn(page, "screenshot").mockImplementation(() => new Promise(() => {}));
    try {
      const started = Date.now();
      await expect(
        captureVisualArtifacts(page, state, {
          screenshotName: `visual-tests/deadline-${Date.now()}.png`,
          timeoutMs: 500,
        })
      ).rejects.toThrow(/Screenshot capture timed out/);
      expect(Date.now() - started).toBeLessThan(700);
      expect(screenshot).not.toHaveBeenCalled();
    } finally {
      screenshot.mockRestore();
      newSession.mockRestore();
    }
  });

  it("never falls back to Playwright after a CDP capture deadline", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setContent("<button>No fallback target</button>");
    const state = await collectPageState(page);
    const session = {
      send: vi.fn().mockImplementation(() => new Promise(() => {})),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const newSession = vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(session as never);
    const screenshot = vi.spyOn(page, "screenshot").mockImplementation(() => new Promise(() => {}));
    try {
      await expect(
        captureVisualArtifacts(page, state, {
          screenshotName: `visual-tests/no-fallback-${Date.now()}.png`,
          timeoutMs: 250,
        })
      ).rejects.toThrow(/Screenshot capture timed out/);
      expect(screenshot).not.toHaveBeenCalled();
    } finally {
      screenshot.mockRestore();
      newSession.mockRestore();
    }
  });

  it("draws deterministic non-overlapping labels and cleans the temporary overlay", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 320, height: 180 });
    await page.setContent(`
      <style>body{margin:0;background:#fff}button{position:absolute;left:80px;width:100px;height:30px}#a{top:50px}#b{top:72px}</style>
      <button id="a">Alpha</button><button id="b">Beta</button>
    `);
    const state = await collectPageState(page);
    const actionable = state.elements.filter((element) => element.actionable);
    const labels = planAnnotationLabels(actionable, { width: 320, height: 180 });
    expect(labels).toHaveLength(2);
    expect(
      labels[0]!.x + labels[0]!.width <= labels[1]!.x ||
        labels[1]!.x + labels[1]!.width <= labels[0]!.x ||
        labels[0]!.y + labels[0]!.height <= labels[1]!.y ||
        labels[1]!.y + labels[1]!.height <= labels[0]!.y
    ).toBe(true);

    const names = {
      screenshotName: `visual-tests/raw-${Date.now()}.png`,
      annotatedName: `visual-tests/annotated-${Date.now()}.png`,
    };
    const result = await captureVisualArtifacts(page, state, {
      ...names,
      annotate: true,
      annotationElements: actionable,
    });
    const [raw, annotated] = await Promise.all([
      readFile(result.screenshot!.path),
      readFile(result.annotatedScreenshot!.path),
    ]);
    const changedPixels = await page.evaluate(
      async ([rawUrl, annotatedUrl]: [string, string]) => {
        const decode = async (url: string) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        };
        const [before, after] = await Promise.all([decode(rawUrl), decode(annotatedUrl)]);
        let changed = 0;
        for (let index = 0; index < before.length; index += 4) {
          if (
            before[index] !== after[index] ||
            before[index + 1] !== after[index + 1] ||
            before[index + 2] !== after[index + 2]
          ) {
            changed += 1;
          }
        }
        return changed;
      },
      [
        `data:image/png;base64,${raw.toString("base64")}`,
        `data:image/png;base64,${annotated.toString("base64")}`,
      ] as [string, string]
    );
    expect(changedPixels).toBeGreaterThan(500);
    expect(result.annotatedScreenshot).toMatchObject({ width: 320, height: 180 });
    await expect(page.locator("[data-dev-browser-visual-overlay]").count()).resolves.toBe(0);
    await Promise.all([
      rm(result.screenshot!.path, { force: true }),
      rm(result.annotatedScreenshot!.path, { force: true }),
    ]);
  });

  it("omits saturated labels deterministically instead of overlapping them", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 80, height: 60 });
    await page.setContent(`
      <style>html,body{margin:0}button{position:absolute;inset:20px auto auto 20px;width:35px;height:20px}</style>
      ${Array.from({ length: 12 }, (_, index) => `<button>Dense ${index}</button>`).join("")}
    `);
    const state = await collectPageState(page, { full: true });
    const actionable = state.elements.filter((element) => element.actionable);
    const first = planAnnotationLabels(actionable, { width: 80, height: 60 });
    const second = planAnnotationLabels(actionable, { width: 80, height: 60 });

    expect(second).toEqual(first);
    expect(first.length).toBeLessThan(actionable.length);
    for (let left = 0; left < first.length; left += 1) {
      for (let right = left + 1; right < first.length; right += 1) {
        const a = first[left]!;
        const b = first[right]!;
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y
        ).toBe(true);
      }
    }

    const result = await captureVisualArtifacts(page, state, {
      annotate: true,
      annotatedName: `visual-tests/dense-${Date.now()}.png`,
      annotationElements: actionable,
    });
    expect(result.warnings).toEqual([
      expect.stringMatching(/^Omitted annotation labels for refs: R\d/),
    ]);
    await rm(result.annotatedScreenshot!.path, { force: true });
  });

  it("cleans the annotation overlay when Playwright screenshot fails", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setContent(
      '<div id="site-overlay" data-dev-browser-visual-overlay>Site content</div><button>Failure target</button>'
    );
    const state = await collectPageState(page);
    const originalScreenshot = page.screenshot.bind(page);
    const newSession = vi
      .spyOn(page.context(), "newCDPSession")
      .mockRejectedValue(new Error("Method not found"));
    page.screenshot = (async () => {
      expect(await page.locator("[data-dev-browser-visual-overlay]").count()).toBe(2);
      throw new Error("induced screenshot failure");
    }) as typeof page.screenshot;
    try {
      await expect(
        captureVisualArtifacts(page, state, {
          annotate: true,
          annotatedName: `visual-tests/failure-${Date.now()}.png`,
          annotationElements: state.elements.filter((element) => element.actionable),
        })
      ).rejects.toThrow("induced screenshot failure");
    } finally {
      page.screenshot = originalScreenshot;
      newSession.mockRestore();
    }
    await expect(page.locator("[data-dev-browser-visual-overlay]").count()).resolves.toBe(1);
    await expect(page.locator("#site-overlay").textContent()).resolves.toBe("Site content");
  });

  it("preserves a site-owned colliding overlay marker after successful annotation", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setContent(
      '<div id="site-overlay" data-dev-browser-visual-overlay>Site content</div><button>Success target</button>'
    );
    const state = await collectPageState(page);
    const result = await captureVisualArtifacts(page, state, {
      annotate: true,
      annotatedName: `visual-tests/site-overlay-${Date.now()}.png`,
    });
    await expect(page.locator("[data-dev-browser-visual-overlay]").count()).resolves.toBe(1);
    await expect(page.locator("#site-overlay").textContent()).resolves.toBe("Site content");
    await rm(result.annotatedScreenshot!.path, { force: true });
  });

  it("captures full-page document CSS pixels at DPR 2 and retains current scroll", async () => {
    const page = await manager.getPage("visual", "main");
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 300,
      height: 160,
      deviceScaleFactor: 2,
      mobile: false,
    });
    try {
      await page.setContent(`
        <style>html,body{margin:0}.top{height:220px;background:#f00}.bottom{height:380px;background:#00f}</style>
        <div class="top"></div><button class="bottom">Bottom</button>
      `);
      await page.evaluate(() => scrollTo(0, 200));
      const state = await collectPageState(page, { full: true });
      const result = await captureVisualArtifacts(page, state, {
        screenshotName: `visual-tests/full-${Date.now()}.png`,
        fullPage: true,
      });
      const artifact = result.screenshot!;
      const png = await readFile(artifact.path);
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({
        width: 300,
        height: 600,
      });
      expect(artifact).toMatchObject({
        width: 300,
        height: 600,
        mode: "full-page",
        origin: { x: 0, y: 0 },
        coordinateSpace: {
          kind: "document",
          devicePixelRatio: 2,
          scroll: { x: 0, y: 200 },
        },
      });
      await rm(artifact.path, { force: true });
    } finally {
      await session.send("Emulation.clearDeviceMetricsOverride");
      await session.detach();
    }
  });

  it("keeps screenshot refs and direct coordinates aligned at browser zoom", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 320, height: 180 });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
    try {
      await page.setContent(`
        <style>html,body{margin:0}button{position:absolute;left:80px;top:60px;width:100px;height:40px;background:#00f}</style>
        <button>Zoom target</button><output>clicks:0</output>
        <script>let clicks=0;document.querySelector('button').onclick=()=>document.querySelector('output').textContent='clicks:'+ ++clicks</script>
      `);
      const state = await collectPageState(page);
      const target = state.elements.find((element) => element.name === "Zoom target")!;
      const result = await captureVisualArtifacts(page, state, {
        screenshotName: `visual-tests/zoom-${Date.now()}.png`,
      });
      expect(result.screenshot!.coordinateSpace.zoom).toBeCloseTo(1.5, 1);
      const png = await readFile(result.screenshot!.path);
      const targetPixel = await page.evaluate(
        async ({ url, x, y }) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data).slice(0, 3);
        },
        { url: `data:image/png;base64,${png.toString("base64")}`, x: target.box.x + 5, y: target.box.y + 5 }
      );
      expect(targetPixel).toEqual([0, 0, 255]);
      await page.mouse.click(target.box.x + target.box.width / 2, target.box.y + target.box.height / 2);
      await expect(page.locator("output").textContent()).resolves.toBe("clicks:1");
      await rm(result.screenshot!.path, { force: true });
    } finally {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await session.detach();
    }
  });

  it("crops around a ref with padding and clamps to document bounds", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 300, height: 160 });
    await page.setContent(`
      <style>html,body{margin:0}.spacer{height:220px}.target{display:block;width:60px;height:40px;margin-left:5px;background:#00f;border:0}</style>
      <div class="spacer"></div><button class="target">Crop target</button><div style="height:140px"></div>
    `);
    await page.evaluate(() => scrollTo(0, 180));
    const state = await collectPageState(page, { full: true });
    const target = state.elements.find((element) => element.name === "Crop target")!;
    expect({ box: target.box, scroll: state.coordinateSpace.scroll }).toEqual({
      box: { x: 5, y: 40, width: 60, height: 40 },
      scroll: { x: 0, y: 180 },
    });
    const result = await captureVisualArtifacts(page, state, {
      screenshotName: `visual-tests/crop-${Date.now()}.png`,
      fullPage: true,
      focus: { box: target.box, padding: 32 },
    });
    const artifact = result.screenshot!;
    expect(artifact).toMatchObject({
      width: 97,
      height: 104,
      mode: "crop",
      origin: { x: 0, y: 188 },
      coordinateSpace: { kind: "document" },
    });
    const cropPng = await readFile(artifact.path);
    const targetPixel = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(10, 40, 1, 1).data).slice(0, 3);
      },
      `data:image/png;base64,${cropPng.toString("base64")}`
    );
    expect(targetPixel).toEqual([0, 0, 255]);
    await rm(artifact.path, { force: true });
  });

  it("aligns sticky and fixed pixels and reports real hit-test obscuration after scroll", async () => {
    const page = await manager.getPage("visual", "main");
    await page.setViewportSize({ width: 300, height: 160 });
    await page.setContent(`
      <style>
        html,body{margin:0}.spacer{height:400px}.sticky{position:sticky;top:0;width:300px;height:40px;background:#f00;border:0;color:transparent;z-index:2}
        .fixed{position:fixed;right:0;top:0;width:40px;height:40px;background:#ff0;border:0;color:transparent;z-index:3}
        button{display:block;width:100px;height:40px}
      </style>
      <button class="sticky">Sticky action</button><div class="spacer"></div><button>Covered target</button><div style="height:200px"></div><button class="fixed">Fixed action</button>
    `);
    await page.evaluate(() => scrollTo(0, 440));
    const state = await collectPageState(page, { full: true });
    const target = state.elements.find((element) => element.name === "Covered target")!;
    expect(target.box.y).toBe(0);
    expect(target.obscured).toBe(true);
    const hit = await page.evaluate(() => document.elementFromPoint(10, 10)?.className);
    expect(hit).toBe("sticky");

    const result = await captureVisualArtifacts(page, state, {
      screenshotName: `visual-tests/overlay-${Date.now()}.png`,
    });
    const png = await readFile(result.screenshot!.path);
    const pixels = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return [
          Array.from(context.getImageData(150, 30, 1, 1).data).slice(0, 3),
          Array.from(context.getImageData(280, 10, 1, 1).data).slice(0, 3),
        ];
      },
      `data:image/png;base64,${png.toString("base64")}`
    );
    expect(pixels).toEqual([
      [255, 0, 0],
      [255, 255, 0],
    ]);
    const annotated = await captureVisualArtifacts(page, state, {
      annotate: true,
      annotatedName: `visual-tests/overlay-annotated-${Date.now()}.png`,
    });
    const annotatedPng = await readFile(annotated.annotatedScreenshot!.path);
    const annotationPixels = await page.evaluate(
      async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return [
          Array.from(context.getImageData(150, 38, 1, 1).data).slice(0, 3),
          Array.from(context.getImageData(260, 20, 1, 1).data).slice(0, 3),
        ];
      },
      `data:image/png;base64,${annotatedPng.toString("base64")}`
    );
    for (const [red, green, blue] of annotationPixels) {
      expect(red).toBe(255);
      expect(green).toBeLessThanOrEqual(45);
      expect(blue).toBeLessThanOrEqual(85);
      expect(blue).toBeGreaterThan(0);
    }
    await rm(result.screenshot!.path, { force: true });
    await rm(annotated.annotatedScreenshot!.path, { force: true });
  });
});
