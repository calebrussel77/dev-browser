import type { Frame } from "playwright";

export interface Point { x: number; y: number }
export interface AffineMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

export const IDENTITY_MATRIX: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export async function frameAncestorsVisible(frame: Frame): Promise<boolean> {
  let child = frame;
  while (child.parentFrame()) {
    const handle = await child.frameElement();
    try {
      const visible = await handle.evaluate((node) => {
        const element = node as Element;
        let current: Element | null = element;
        let opacity = 1;
        const initial = element.getBoundingClientRect();
        if (initial.width <= 0 || initial.height <= 0) return false;
        let clipLeft = initial.left, clipTop = initial.top, clipRight = initial.right, clipBottom = initial.bottom;
        for (let depth = 0; current && depth < 100; depth += 1) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden") return false;
          const localOpacity = Number.parseFloat(style.opacity || "1");
          opacity *= Number.isFinite(localOpacity) ? localOpacity : 1;
          if (opacity <= 0.001) return false;
          const rect = current.getBoundingClientRect();
          const clips = [style.overflow, style.overflowX, style.overflowY].some((value) => /hidden|clip|scroll|auto/.test(value));
          if (clips && style.display !== "contents") {
            const left = Math.max(clipLeft, rect.left), top = Math.max(clipTop, rect.top);
            const right = Math.min(clipRight, rect.right), bottom = Math.min(clipBottom, rect.bottom);
            if (right <= left || bottom <= top) return false;
            clipLeft = left; clipTop = top; clipRight = right; clipBottom = bottom;
          }
          const root = current.getRootNode();
          current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return current === null;
      });
      if (!visible) return false;
    } finally { await handle.dispose(); }
    child = child.parentFrame()!;
  }
  return true;
}
export function projectPoint(matrix: AffineMatrix, point: Point): Point {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
}
export function composeAffine(outer: AffineMatrix, inner: AffineMatrix): AffineMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export async function frameContentMatrix(frame: Frame): Promise<AffineMatrix> {
  if (!frame.parentFrame()) return IDENTITY_MATRIX;
  const handle = await frame.frameElement();
  try {
    return await handle.evaluate((node) => {
      const element = node as HTMLElement, style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const parsed = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
      const origin = style.transformOrigin.split(/\s+/).map((value) => Number.parseFloat(value));
      const ox = origin[0] || 0, oy = origin[1] || 0;
      const baseE = parsed.e + ox - parsed.a * ox - parsed.c * oy;
      const baseF = parsed.f + oy - parsed.b * ox - parsed.d * oy;
      const points = [[0, 0], [element.offsetWidth, 0], [element.offsetWidth, element.offsetHeight], [0, element.offsetHeight]].map(([x, y]) => ({ x: parsed.a * x! + parsed.c * y! + baseE, y: parsed.b * x! + parsed.d * y! + baseF }));
      const shiftX = rect.left - Math.min(...points.map((point) => point.x));
      const shiftY = rect.top - Math.min(...points.map((point) => point.y));
      return { a: parsed.a, b: parsed.b, c: parsed.c, d: parsed.d,
        e: baseE + shiftX + parsed.a * element.clientLeft + parsed.c * element.clientTop,
        f: baseF + shiftY + parsed.b * element.clientLeft + parsed.d * element.clientTop };
    });
  } finally { await handle.dispose(); }
}

export async function frameToTopMatrix(frame: Frame): Promise<AffineMatrix> {
  let matrix = IDENTITY_MATRIX, child: Frame = frame;
  while (child.parentFrame()) {
    matrix = composeAffine(await frameContentMatrix(child), matrix);
    child = child.parentFrame()!;
  }
  return matrix;
}

export function projectRect(matrix: AffineMatrix, box: { x: number; y: number; width: number; height: number }) {
  const quad = [
    projectPoint(matrix, { x: box.x, y: box.y }),
    projectPoint(matrix, { x: box.x + box.width, y: box.y }),
    projectPoint(matrix, { x: box.x + box.width, y: box.y + box.height }),
    projectPoint(matrix, { x: box.x, y: box.y + box.height }),
  ];
  const xs = quad.map((point) => point.x), ys = quad.map((point) => point.y);
  return { quad, box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
}
