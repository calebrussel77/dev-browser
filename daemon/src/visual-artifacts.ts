import { randomUUID } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { CDPSession, Page } from "playwright";

import type { PagePerception, PerceptionElement } from "./perception/collector.js";
import { writeDevBrowserTempFile } from "./temp-files.js";

export interface ScreenshotArtifact {
  path: string;
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  coordinateSpace: {
    kind: "viewport" | "document";
    unit: "css-px";
    screenshotScale: "css" | "device";
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    zoom: number;
    scroll: { x: number; y: number };
  };
  mode: "viewport" | "full-page" | "crop";
  captureMode: "cdp" | "playwright";
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
  timeoutMs?: number;
  format?: "png" | "jpeg";
  scale?: "css" | "device";
  annotateMode?: "dom" | "raster";
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

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    throw new Error("Chromium returned an invalid JPEG screenshot");
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    offset += length;
  }
  throw new Error("Chromium returned a JPEG without dimensions");
}

function imageDimensions(
  buffer: Buffer,
  format: "png" | "jpeg"
): { width: number; height: number } {
  return format === "png" ? pngDimensions(buffer) : jpegDimensions(buffer);
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isUnsupportedCdpScreenshot(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|wasn't found|not supported|not implemented|unknown method|only available in/i.test(message);
}

async function addCaptureStabilityStyle(page: Page): Promise<string> {
  const id = randomUUID();
  await page.evaluate((styleId) => {
    const style = document.createElement("style");
    style.setAttribute("data-dev-browser-capture-style", styleId);
    style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
    document.documentElement.append(style);
  }, id);
  return id;
}

async function removeCaptureStabilityStyle(page: Page, id: string): Promise<void> {
  await page.locator(`[data-dev-browser-capture-style="${id}"]`).evaluateAll((elements) =>
    elements.forEach((element) => element.remove())
  );
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

function decodePng(png: Buffer): { header: Buffer; pixels: Buffer; width: number; height: number; bytesPerPixel: number } {
  const { width, height } = pngDimensions(png);
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
  if (!header || header[8] !== 8 || header[12] !== 0) throw new Error("Unsupported PNG screenshot format");
  const bytesPerPixel = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[header[9]!];
  if (!bytesPerPixel) throw new Error("Unsupported PNG screenshot color type");
  const stride = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(height * stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset++]!;
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[inputOffset++]!;
      const outputOffset = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[outputOffset - bytesPerPixel]! : 0;
      const above = y > 0 ? pixels[outputOffset - stride]! : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[outputOffset - stride - bytesPerPixel]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : -1;
      if (predictor < 0) throw new Error(`Unsupported PNG row filter ${filter}`);
      pixels[outputOffset] = (encoded + predictor) & 0xff;
    }
  }
  return { header, pixels, width, height, bytesPerPixel };
}

function encodePng(signature: Buffer, header: Buffer, pixels: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (stride + 1);
    filtered[outputOffset] = 0;
    pixels.copy(filtered, outputOffset + 1, row * stride, (row + 1) * stride);
  }
  const outputHeader = Buffer.from(header);
  outputHeader.writeUInt32BE(width, 0);
  outputHeader.writeUInt32BE(height, 4);
  return Buffer.concat([signature, pngChunk("IHDR", outputHeader), pngChunk("IDAT", deflateSync(filtered)), pngChunk("IEND", Buffer.alloc(0))]);
}

function resizePng(png: Buffer, scale: number): Buffer {
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.001) return png;
  const decoded = decodePng(png);
  const width = Math.max(1, Math.round(decoded.width / scale));
  const height = Math.max(1, Math.round(decoded.height / scale));
  const pixels = Buffer.alloc(width * height * decoded.bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.floor(y * scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x * scale));
      const source = (sourceY * decoded.width + sourceX) * decoded.bytesPerPixel;
      const target = (y * width + x) * decoded.bytesPerPixel;
      decoded.pixels.copy(pixels, target, source, source + decoded.bytesPerPixel);
    }
  }
  return encodePng(png.subarray(0, 8), decoded.header, pixels, width, height, decoded.bytesPerPixel);
}

function annotatePng(
  png: Buffer,
  elements: Array<Pick<PerceptionElement, "ref" | "box">>,
  labels: AnnotationLabel[],
  origin: { x: number; y: number }
): Buffer {
  const decoded = decodePng(png);
  const setPixel = (x: number, y: number, red: number, green: number, blue: number) => {
    if (x < 0 || y < 0 || x >= decoded.width || y >= decoded.height) return;
    const offset = (Math.trunc(y) * decoded.width + Math.trunc(x)) * decoded.bytesPerPixel;
    if (decoded.bytesPerPixel === 1 || decoded.bytesPerPixel === 2) {
      decoded.pixels[offset] = Math.round((red + green + blue) / 3);
      return;
    }
    decoded.pixels[offset] = red;
    decoded.pixels[offset + 1] = green;
    decoded.pixels[offset + 2] = blue;
    if (decoded.bytesPerPixel === 4) decoded.pixels[offset + 3] = 255;
  };
  const fill = (x: number, y: number, width: number, height: number, color: [number, number, number]) => {
    const left = Math.max(0, Math.floor(x - origin.x));
    const top = Math.max(0, Math.floor(y - origin.y));
    const right = Math.min(decoded.width, Math.ceil(x - origin.x + width));
    const bottom = Math.min(decoded.height, Math.ceil(y - origin.y + height));
    for (let row = top; row < bottom; row += 1)
      for (let column = left; column < right; column += 1)
        setPixel(column, row, ...color);
  };
  const stroke = (box: { x: number; y: number; width: number; height: number }) => {
    fill(box.x, box.y, box.width, 3, [255, 45, 85]);
    fill(box.x, box.y + box.height - 3, box.width, 3, [255, 45, 85]);
    fill(box.x, box.y, 3, box.height, [255, 45, 85]);
    fill(box.x + box.width - 3, box.y, 3, box.height, [255, 45, 85]);
  };
  for (const element of elements) stroke(element.box);
  for (const label of labels) {
    fill(label.x, label.y, label.width, label.height, [255, 45, 85]);
    // The compatibility renderer deliberately stays dependency-free. Encode
    // the ref as deterministic white bars; DOM mode remains the legible default.
    for (let index = 0; index < label.ref.length; index += 1) {
      const bits = label.ref.charCodeAt(index);
      for (let bit = 0; bit < 7; bit += 1)
        if (bits & (1 << bit))
          fill(label.x + 6 + index * 7, label.y + 4 + bit * 2, 5, 1, [255, 255, 255]);
    }
  }
  return encodePng(
    png.subarray(0, 8),
    decoded.header,
    decoded.pixels,
    decoded.width,
    decoded.height,
    decoded.bytesPerPixel
  );
}

function cropPng(
  png: Buffer,
  clip: { x: number; y: number; width: number; height: number }
): Buffer {
  const decoded = decodePng(png);
  const x = Math.max(0, Math.min(decoded.width - 1, Math.floor(clip.x)));
  const y = Math.max(0, Math.min(decoded.height - 1, Math.floor(clip.y)));
  const width = Math.max(1, Math.min(decoded.width - x, Math.round(clip.width)));
  const height = Math.max(1, Math.min(decoded.height - y, Math.round(clip.height)));
  const pixels = Buffer.alloc(width * height * decoded.bytesPerPixel);
  const sourceStride = decoded.width * decoded.bytesPerPixel;
  const targetStride = width * decoded.bytesPerPixel;
  for (let row = 0; row < height; row += 1) {
    const source = (y + row) * sourceStride + x * decoded.bytesPerPixel;
    decoded.pixels.copy(pixels, row * targetStride, source, source + targetStride);
  }
  return encodePng(
    png.subarray(0, 8),
    decoded.header,
    pixels,
    width,
    height,
    decoded.bytesPerPixel
  );
}

export async function captureVisualArtifacts(
  page: Page,
  perception: PagePerception,
  options: CaptureVisualArtifactsOptions
): Promise<VisualArtifacts> {
  const format = options.format ?? "png";
  const screenshotScale = options.scale ?? "css";
  const annotateMode = options.annotateMode ?? "dom";
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
    ? { scale: screenshotScale, clip: crop }
    : options.fullPage
      ? { scale: screenshotScale, fullPage: true }
      : {
          scale: screenshotScale,
          clip: {
            x: 0,
            y: 0,
            width: perception.coordinateSpace.viewport.width,
            height: perception.coordinateSpace.viewport.height,
          },
        };
  const makeArtifact = async (name: string, image: Buffer): Promise<ScreenshotArtifact> => ({
    path: await writeDevBrowserTempFile(name, image),
    mediaType: format === "png" ? "image/png" : "image/jpeg",
    ...imageDimensions(image, format),
    coordinateSpace: {
      kind: sourceKind,
      unit: "css-px" as const,
      screenshotScale,
      viewport: perception.coordinateSpace.viewport,
      devicePixelRatio: perception.coordinateSpace.devicePixelRatio,
      zoom,
      scroll: perception.coordinateSpace.scroll,
    },
    mode,
    captureMode: "cdp",
    origin,
  });
  const timeoutMs = options.timeoutMs ?? 8_000;
  const takeScreenshot = async (): Promise<{ image: Buffer; captureMode: ScreenshotArtifact["captureMode"] }> => {
    const startedAt = Date.now();
    const remainingBudgetMs = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
    let session: CDPSession | undefined;
    try {
      session = await withDeadline(page.context().newCDPSession(page), timeoutMs, "Screenshot capture");
      const baseClip = crop ?? (options.fullPage
        ? { x: 0, y: 0, width: documentSize.width, height: documentSize.height }
        : {
            x: perception.coordinateSpace.scroll.x,
            y: perception.coordinateSpace.scroll.y,
            width: perception.coordinateSpace.viewport.width,
            height: perception.coordinateSpace.viewport.height,
          });
      const cropAfterCapture = Boolean(
        crop && sourceKind === "viewport" && page.frames().length > 1 && format === "png"
      );
      const captureClip = cropAfterCapture
        ? {
            x: perception.coordinateSpace.scroll.x,
            y: perception.coordinateSpace.scroll.y,
            width: perception.coordinateSpace.viewport.width,
            height: perception.coordinateSpace.viewport.height,
          }
        : baseClip;
      const response = await withDeadline(
        session.send("Page.captureScreenshot", {
          format,
          quality: format === "jpeg" ? 80 : undefined,
          fromSurface: true,
          captureBeyondViewport: options.fullPage,
          clip: cropAfterCapture ? undefined : {
            ...captureClip,
            // Chromium's CDP clip coordinates and scale are expressed in CSS
            // pixels. A scale of 1 therefore produces one output pixel per CSS
            // pixel even on DPR 2; device mode explicitly opts back into DPR.
            scale:
              screenshotScale === "css"
                ? 1
                : perception.coordinateSpace.devicePixelRatio,
          },
        }),
        remainingBudgetMs(),
        "Screenshot capture"
      ).catch((error) => {
        // fromSurface captures produce no frame while the browser window is
        // minimized, so the deadline is the only signal the agent gets —
        // annotate it with the likely cause instead of a bare timeout.
        if (error instanceof Error && /timed out after \d+ms$/.test(error.message)) {
          throw new Error(
            `${error.message} (the browser window may be minimized; restore it or use a headless browser)`
          );
        }
        throw error;
      });
      const captured = Buffer.from(response.data, "base64");
      let normalized: Buffer = captured;
      if (format === "png") {
        const dimensions = pngDimensions(captured);
        const expectedWidth = Math.max(
          1,
          Math.round(
            captureClip.width *
              (screenshotScale === "device" ? perception.coordinateSpace.devicePixelRatio : 1)
          )
        );
        const expectedHeight = Math.max(
          1,
          Math.round(
            captureClip.height *
              (screenshotScale === "device" ? perception.coordinateSpace.devicePixelRatio : 1)
          )
        );
        const widthScale = dimensions.width / expectedWidth;
        const heightScale = dimensions.height / expectedHeight;
        if (
          Math.abs(widthScale - 1) > 0.001 &&
          Math.abs(widthScale - heightScale) < 0.01
        )
          normalized = resizePng(captured, widthScale);
      }
      if (cropAfterCapture && crop) {
        const density = screenshotScale === "device" ? perception.coordinateSpace.devicePixelRatio : 1;
        normalized = cropPng(normalized, {
          x: (crop.x - perception.coordinateSpace.scroll.x) * density,
          y: (crop.y - perception.coordinateSpace.scroll.y) * density,
          width: crop.width * density,
          height: crop.height * density,
        });
      }
      return {
        image: normalized,
        captureMode: "cdp",
      };
    } catch (error) {
      if (!isUnsupportedCdpScreenshot(error)) throw error;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw error;
      const image = Buffer.from(
        await page.screenshot({
          ...screenshotOptions,
          type: format,
          quality: format === "jpeg" ? 80 : undefined,
          animations: "disabled",
          caret: "hide",
          timeout: remainingMs,
        })
      );
      return { image, captureMode: "playwright" };
    } finally {
      if (session) await session.detach().catch(() => undefined);
    }
  };
  const makeCapturedArtifact = async (name: string): Promise<ScreenshotArtifact> => {
    const captured = await takeScreenshot();
    const artifact = await makeArtifact(name, captured.image);
    artifact.captureMode = captured.captureMode;
    return artifact;
  };
  const stabilityStyleId = await addCaptureStabilityStyle(page);
  try {
  let screenshot: ScreenshotArtifact | null = null;
  if (options.screenshotName) {
    screenshot = await makeCapturedArtifact(options.screenshotName);
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
    const defaultExtension = format === "jpeg" ? "jpg" : "png";
    const name =
      options.annotatedName ??
      options.screenshotName?.replace(/(\.(?:png|jpe?g))?$/i, `-annotated.${defaultExtension}`) ??
      `interactive/${Date.now()}-annotated.${defaultExtension}`;
    if (annotateMode === "raster") {
      if (format !== "png")
        throw new Error("Raster annotation compatibility mode requires PNG output");
      const captured = await takeScreenshot();
      annotatedScreenshot = await makeArtifact(
        name,
        annotatePng(captured.image, annotationElements, labels, origin)
      );
      annotatedScreenshot.captureMode = captured.captureMode;
    } else {
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
          for (const element of elements) {
            const outline = document.createElement("div");
            Object.assign(outline.style, {
              position: "absolute",
              boxSizing: "border-box",
              left: `${element.box.x}px`,
              top: `${element.box.y}px`,
              width: `${element.box.width}px`,
              height: `${element.box.height}px`,
              border: "3px solid #ff2d55",
              pointerEvents: "none",
            });
            shadow.append(outline);
          }
          for (const label of labels) {
            const node = document.createElement("div");
            node.textContent = label.ref;
            Object.assign(node.style, {
              position: "absolute",
              boxSizing: "border-box",
              left: `${label.x}px`,
              top: `${label.y}px`,
              width: `${label.width}px`,
              height: `${label.height}px`,
              borderRadius: "4px",
              background: "#ff2d55",
              color: "white",
              font: "700 13px/22px ui-monospace, monospace",
              padding: "0 6px",
              overflow: "hidden",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            });
            shadow.append(node);
          }
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
        annotatedScreenshot = await makeCapturedArtifact(name);
      } finally {
        await page
          .locator(`[data-dev-browser-visual-overlay="${overlayId}"]`)
          .evaluateAll((elements) => elements.forEach((element) => element.remove()));
      }
    }
  }
  return { screenshot, annotatedScreenshot, warnings };
  } finally {
    await removeCaptureStabilityStyle(page, stabilityStyleId);
  }
}
