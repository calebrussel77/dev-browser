import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { Page } from "playwright";

import type { PagePerception, PerceptionElement } from "./perception/collector.js";
import { writeDevBrowserTempFile } from "./temp-files.js";

export interface ScreenshotArtifact {
  path: string;
  mediaType: "image/png";
  width: number;
  height: number;
  coordinateSpace: {
    kind: "viewport" | "document";
    unit: "css-px";
    screenshotScale: "css";
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    zoom: number;
    scroll: { x: number; y: number };
  };
  mode: "viewport" | "full-page" | "crop";
  origin: { x: number; y: number };
}

export interface VisualArtifacts {
  screenshot: ScreenshotArtifact | null;
  annotatedScreenshot: ScreenshotArtifact | null;
  warnings: string[];
}

export interface CaptureVisualArtifactsOptions {
  screenshotName?: string;
  annotatedName?: string;
  annotate?: boolean;
  fullPage?: boolean;
  annotationElements?: PerceptionElement[];
  focus?: { box: PerceptionElement["box"]; padding: number };
}

export interface AnnotationLabel {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(left: AnnotationLabel, right: AnnotationLabel): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

export function planAnnotationLabels(
  elements: PerceptionElement[],
  bounds: { width: number; height: number }
): AnnotationLabel[] {
  const placed: AnnotationLabel[] = [];
  const ordered = [...elements].sort((left, right) => {
    const leftNumber = Number(left.ref.slice(1));
    const rightNumber = Number(right.ref.slice(1));
    return leftNumber - rightNumber || left.ref.localeCompare(right.ref);
  });
  for (const element of ordered) {
    const width = Math.max(32, element.ref.length * 9 + 12);
    const height = 22;
    const candidates = [
      { x: element.box.x, y: element.box.y - height - 3 },
      { x: element.box.x, y: element.box.y + element.box.height + 3 },
      { x: element.box.x + element.box.width + 3, y: element.box.y },
      { x: element.box.x - width - 3, y: element.box.y },
    ].map(({ x, y }) => ({
      ref: element.ref,
      x: Math.max(0, Math.min(bounds.width - width, x)),
      y: Math.max(0, Math.min(bounds.height - height, y)),
      width,
      height,
    }));
    let label = candidates.find((candidate) =>
      placed.every((other) => !overlaps(candidate, other))
    );
    if (!label) {
      for (let row = 0; !label && row * (height + 2) < bounds.height; row += 1) {
        for (let x = 0; x + width <= bounds.width; x += width + 2) {
          const candidate = { ref: element.ref, x, y: row * (height + 2), width, height };
          if (placed.every((other) => !overlaps(candidate, other))) {
            label = candidate;
            break;
          }
        }
      }
    }
    if (label) placed.push(label);
  }
  return placed;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Playwright returned an invalid PNG screenshot");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function cropPng(
  png: Buffer,
  requested: { x: number; y: number; width: number; height: number }
): Buffer {
  const { width: sourceWidth, height: sourceHeight } = pngDimensions(png);
  let offset = 8;
  let header: Buffer | undefined;
  const compressed: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = Buffer.from(data);
    if (type === "IDAT") compressed.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (!header || header[8] !== 8 || header[12] !== 0) {
    throw new Error("Unsupported PNG format for focused screenshot crop");
  }
  const bytesPerPixel = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[header[9]!];
  if (!bytesPerPixel) throw new Error("Unsupported PNG color type for focused screenshot crop");

  const stride = sourceWidth * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(sourceHeight * stride);
  let inputOffset = 0;
  for (let y = 0; y < sourceHeight; y += 1) {
    const filter = filtered[inputOffset++]!;
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[inputOffset++]!;
      const outputOffset = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[outputOffset - bytesPerPixel]! : 0;
      const above = y > 0 ? pixels[outputOffset - stride]! : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? pixels[outputOffset - stride - bytesPerPixel]! : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : -1;
      if (predictor < 0) throw new Error(`Unsupported PNG row filter ${filter}`);
      pixels[outputOffset] = (encoded + predictor) & 0xff;
    }
  }

  const x = Math.max(0, Math.floor(requested.x));
  const y = Math.max(0, Math.floor(requested.y));
  const width = Math.min(sourceWidth - x, Math.ceil(requested.width));
  const height = Math.min(sourceHeight - y, Math.ceil(requested.height));
  if (width <= 0 || height <= 0) throw new Error("Focused screenshot crop is empty");
  const croppedStride = width * bytesPerPixel;
  const cropped = Buffer.alloc(height * (croppedStride + 1));
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (croppedStride + 1);
    cropped[outputOffset] = 0;
    pixels.copy(
      cropped,
      outputOffset + 1,
      (y + row) * stride + x * bytesPerPixel,
      (y + row) * stride + (x + width) * bytesPerPixel
    );
  }
  const croppedHeader = Buffer.from(header);
  croppedHeader.writeUInt32BE(width, 0);
  croppedHeader.writeUInt32BE(height, 4);
  return Buffer.concat([
    png.subarray(0, 8),
    pngChunk("IHDR", croppedHeader),
    pngChunk("IDAT", deflateSync(cropped)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function captureVisualArtifacts(
  page: Page,
  perception: PagePerception,
  options: CaptureVisualArtifactsOptions
): Promise<VisualArtifacts> {
  const zoom = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  const documentSize = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));
  const sourceKind = options.fullPage ? "document" : "viewport";
  const sourceBounds =
    sourceKind === "document" ? documentSize : perception.coordinateSpace.viewport;
  const focusBox = options.focus
    ? {
        x:
          options.focus.box.x +
          (sourceKind === "document" ? perception.coordinateSpace.scroll.x : 0),
        y:
          options.focus.box.y +
          (sourceKind === "document" ? perception.coordinateSpace.scroll.y : 0),
        width: options.focus.box.width,
        height: options.focus.box.height,
      }
    : null;
  const padding = Math.max(0, options.focus?.padding ?? 0);
  const origin = focusBox
    ? {
        x: Math.max(0, focusBox.x - padding),
        y: Math.max(0, focusBox.y - padding),
      }
    : { x: 0, y: 0 };
  const crop = focusBox
    ? {
        x: origin.x + (sourceKind === "viewport" ? perception.coordinateSpace.scroll.x : 0),
        y: origin.y + (sourceKind === "viewport" ? perception.coordinateSpace.scroll.y : 0),
        width: Math.min(
          sourceBounds.width - origin.x,
          focusBox.x + focusBox.width + padding - origin.x
        ),
        height: Math.min(
          sourceBounds.height - origin.y,
          focusBox.y + focusBox.height + padding - origin.y
        ),
      }
    : null;
  const mode: ScreenshotArtifact["mode"] = focusBox
    ? "crop"
    : options.fullPage
      ? "full-page"
      : "viewport";
  const screenshotOptions = crop
    ? { scale: "css" as const, clip: crop }
    : options.fullPage
      ? { scale: "css" as const, fullPage: true }
      : {
          scale: "css" as const,
          clip: {
            x: 0,
            y: 0,
            width: perception.coordinateSpace.viewport.width,
            height: perception.coordinateSpace.viewport.height,
          },
        };
  const makeArtifact = async (name: string, png: Buffer): Promise<ScreenshotArtifact> => ({
    path: await writeDevBrowserTempFile(name, png),
    mediaType: "image/png" as const,
    ...pngDimensions(png),
    coordinateSpace: {
      kind: sourceKind,
      unit: "css-px" as const,
      screenshotScale: "css" as const,
      viewport: perception.coordinateSpace.viewport,
      devicePixelRatio: perception.coordinateSpace.devicePixelRatio,
      zoom,
      scroll: perception.coordinateSpace.scroll,
    },
    mode,
    origin,
  });
  const takeScreenshot = async (): Promise<Buffer> => {
    if (crop && sourceKind === "document") {
      const fullPage = Buffer.from(await page.screenshot({ scale: "css", fullPage: true }));
      return cropPng(fullPage, crop);
    }
    return Buffer.from(await page.screenshot(screenshotOptions));
  };
  let screenshot: ScreenshotArtifact | null = null;
  if (options.screenshotName) {
    screenshot = await makeArtifact(options.screenshotName, await takeScreenshot());
  }

  let annotatedScreenshot: ScreenshotArtifact | null = null;
  const warnings: string[] = [];
  if (options.annotate) {
    const annotationElements = (options.annotationElements ?? perception.elements)
      .filter(
        (element) =>
          element.actionable && element.visible && (sourceKind === "document" || element.inViewport)
      )
      .map((element) => ({
        ...element,
        box: {
          ...element.box,
          x: element.box.x + (sourceKind === "document" ? perception.coordinateSpace.scroll.x : 0),
          y: element.box.y + (sourceKind === "document" ? perception.coordinateSpace.scroll.y : 0),
        },
      }));
    const labels = planAnnotationLabels(annotationElements, sourceBounds);
    const labeledRefs = new Set(labels.map((label) => label.ref));
    const omittedRefs = annotationElements
      .map((element) => element.ref)
      .filter((ref) => !labeledRefs.has(ref));
    if (omittedRefs.length > 0) {
      warnings.push(`Omitted annotation labels for refs: ${omittedRefs.join(", ")}`);
    }
    const overlayId = randomUUID();
    await page.evaluate(
      ({ elements, labels, documentMode, bounds, overlayId }) => {
        const host = document.createElement("div");
        host.setAttribute("data-dev-browser-visual-overlay", overlayId);
        host.setAttribute("aria-hidden", "true");
        host.inert = true;
        Object.assign(host.style, {
          all: "initial",
          contain: "strict",
          display: "block",
          position: documentMode ? "absolute" : "fixed",
          inset: "0",
          width: documentMode ? `${bounds.width}px` : "100vw",
          height: documentMode ? `${bounds.height}px` : "100vh",
          pointerEvents: "none",
          zIndex: "2147483647",
        });
        const shadow = host.attachShadow({ mode: "open" });
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("aria-hidden", "true");
        svg.style.pointerEvents = "none";
        const byRef = new Map(elements.map((element) => [element.ref, element]));
        for (const element of elements) {
          const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          outline.setAttribute("x", String(element.box.x));
          outline.setAttribute("y", String(element.box.y));
          outline.setAttribute("width", String(element.box.width));
          outline.setAttribute("height", String(element.box.height));
          outline.setAttribute("fill", "none");
          outline.setAttribute("stroke", "#ff2d55");
          outline.setAttribute("stroke-width", "3");
          svg.append(outline);
        }
        for (const label of labels) {
          const element = byRef.get(label.ref)!;
          const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          background.setAttribute("x", String(label.x));
          background.setAttribute("y", String(label.y));
          background.setAttribute("width", String(label.width));
          background.setAttribute("height", String(label.height));
          background.setAttribute("rx", "4");
          background.setAttribute("fill", "#ff2d55");
          svg.append(background);
          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", String(label.x + 6));
          text.setAttribute("y", String(label.y + 16));
          text.setAttribute("fill", "white");
          text.setAttribute("font-family", "ui-monospace, monospace");
          text.setAttribute("font-size", "13");
          text.setAttribute("font-weight", "700");
          text.textContent = label.ref;
          svg.append(text);
        }
        shadow.append(svg);
        document.documentElement.append(host);
      },
      {
        elements: annotationElements,
        labels,
        documentMode: sourceKind === "document",
        bounds: sourceBounds,
        overlayId,
      }
    );
    try {
      const name =
        options.annotatedName ??
        options.screenshotName?.replace(/(\.png)?$/i, "-annotated.png") ??
        `interactive/${Date.now()}-annotated.png`;
      annotatedScreenshot = await makeArtifact(name, await takeScreenshot());
    } finally {
      await page
        .locator(`[data-dev-browser-visual-overlay="${overlayId}"]`)
        .evaluateAll((elements) => elements.forEach((element) => element.remove()));
    }
  }
  return { screenshot, annotatedScreenshot, warnings };
}
