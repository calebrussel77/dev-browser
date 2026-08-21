import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { getDevBrowserBaseDir } from "./local-endpoint.js";

const SAFE_PATH_SEGMENT_PATTERN = /[^A-Za-z0-9._-]/g;
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export const DEV_BROWSER_BASE_DIR = getDevBrowserBaseDir();
export const DEV_BROWSER_TMP_DIR = path.join(DEV_BROWSER_BASE_DIR, "tmp");
export const MAX_UPLOAD_BYTES = 10_000_000;

export interface ReservedDownloadFile {
  path: string;
  filename: string;
  handle: FileHandle;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  if (candidatePath === rootDir) {
    return true;
  }

  const rootWithSeparator = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  return candidatePath.startsWith(rootWithSeparator);
}

function normalizedForContainment(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithinControlledRoot(rootDir: string, candidatePath: string): boolean {
  return isWithinDirectory(normalizedForContainment(rootDir), normalizedForContainment(candidatePath));
}

function hasTraversalSegment(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").includes("..");
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  return expected.isFile() && actual.isFile() && expected.dev === actual.dev &&
    expected.ino === actual.ino && expected.mode === actual.mode && expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function sanitizePathSegment(segment: string): string {
  if (segment.length === 0) {
    throw new Error("File paths must not contain empty path segments");
  }
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error("File paths must not contain '.' or '..' segments");
  }

  const sanitized = segment.replace(SAFE_PATH_SEGMENT_PATTERN, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    throw new Error("File paths must resolve to a valid filename");
  }

  return sanitized;
}

function sanitizeRelativePath(fileName: unknown): string[] {
  const rawPath = requireNonEmptyString(fileName, "File name");
  if (rawPath.includes("\0")) {
    throw new Error("File names must not contain null bytes");
  }
  if (path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    throw new Error(
      `Absolute paths are not allowed; pass a relative path and the file is written under ${DEV_BROWSER_TMP_DIR} (the result reports the absolute path)`
    );
  }

  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error(
      `Absolute paths are not allowed; pass a relative path and the file is written under ${DEV_BROWSER_TMP_DIR} (the result reports the absolute path)`
    );
  }

  return normalized.split("/").map(sanitizePathSegment);
}

async function assertControlledDirectory(directoryPath: string, label: string): Promise<void> {
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
}

async function assertSafeParentDirectories(
  rootDir: string,
  destinationPath: string,
  createParents: boolean
): Promise<void> {
  const relativeParent = path.relative(rootDir, path.dirname(destinationPath));
  if (relativeParent.length === 0) {
    return;
  }

  const segments = relativeParent.split(path.sep).filter((segment) => segment.length > 0);
  let currentPath = rootDir;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (createParents) {
      await mkdir(currentPath, {
        recursive: true,
      });
    }

    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Temp path parent must not be a symlink: ${currentPath}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Temp path parent must be a directory: ${currentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !createParents) {
        return;
      }
      throw error;
    }
  }
}

function normalizeSymlinkError(error: unknown, destinationPath: string): Error {
  if ((error as NodeJS.ErrnoException).code === "ELOOP") {
    return new Error(`Refusing to follow symlinked temp file: ${destinationPath}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function assertDestinationIsNotSymlink(destinationPath: string): Promise<void> {
  try {
    const stats = await lstat(destinationPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlinked temp file: ${destinationPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export async function ensureDevBrowserTempDir(): Promise<string> {
  await mkdir(DEV_BROWSER_BASE_DIR, {
    recursive: true,
  });
  await assertControlledDirectory(DEV_BROWSER_BASE_DIR, "Dev Browser base directory");

  await mkdir(DEV_BROWSER_TMP_DIR, {
    recursive: true,
  });
  await assertControlledDirectory(DEV_BROWSER_TMP_DIR, "Dev Browser temp directory");

  return path.resolve(DEV_BROWSER_TMP_DIR);
}

export async function resolveDevBrowserTempPath(
  fileName: unknown,
  options: {
    createParents?: boolean;
  } = {}
): Promise<string> {
  const rootDir = await ensureDevBrowserTempDir();
  const segments = sanitizeRelativePath(fileName);
  const destinationPath = path.resolve(rootDir, ...segments);

  if (!isWithinDirectory(rootDir, destinationPath)) {
    throw new Error("Resolved temp file path escapes the controlled temp directory");
  }

  await assertSafeParentDirectories(rootDir, destinationPath, options.createParents ?? false);
  return destinationPath;
}

export async function writeDevBrowserTempFile(
  fileName: unknown,
  data: string | Uint8Array
): Promise<string> {
  const destinationPath = await resolveDevBrowserTempPath(fileName, {
    createParents: true,
  });
  await assertDestinationIsNotSymlink(destinationPath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW_FLAG,
      0o600
    );
    await handle.writeFile(data);
  } catch (error) {
    throw normalizeSymlinkError(error, destinationPath);
  } finally {
    await handle?.close();
  }

  return destinationPath;
}

export async function readDevBrowserTempFile(fileName: unknown): Promise<string> {
  const destinationPath = await resolveDevBrowserTempPath(fileName);
  await assertDestinationIsNotSymlink(destinationPath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(destinationPath, constants.O_RDONLY | NOFOLLOW_FLAG);
    return await handle.readFile({
      encoding: "utf8",
    });
  } catch (error) {
    throw normalizeSymlinkError(error, destinationPath);
  } finally {
    await handle?.close();
  }
}

export async function resolveControlledUploadFile(fileName: unknown): Promise<{
  filename: string;
  bytes: number;
  buffer: Buffer;
}> {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.includes("\0")) {
    throw new Error("Upload source must be a controlled regular file");
  }
  if (hasTraversalSegment(fileName)) throw new Error("Upload source must not contain traversal segments");
  const root = await realpath(await ensureDevBrowserTempDir());
  const requested = path.resolve(fileName);
  if (!isWithinControlledRoot(root, requested) || requested === root)
    throw new Error("Upload source is outside the controlled temp directory");
  let sourceStats;
  try {
    sourceStats = await lstat(requested);
  } catch {
    throw new Error("Upload source must be an existing controlled regular file");
  }
  if (sourceStats.isSymbolicLink()) throw new Error("Upload source must not be a symlink");
  if (!sourceStats.isFile()) throw new Error("Upload source must be a regular file");
  if (sourceStats.size > MAX_UPLOAD_BYTES) throw new Error("Upload source exceeds the size limit");
  const canonical = await realpath(requested);
  if (!isWithinControlledRoot(root, canonical) || canonical === root) {
    throw new Error("Upload source is outside the controlled temp directory");
  }
  const canonicalStats = await lstat(canonical);
  if (canonicalStats.isSymbolicLink() || !canonicalStats.isFile() ||
      !sameFileIdentity(sourceStats, canonicalStats))
    throw new Error("Upload source canonical identity is invalid");
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | NOFOLLOW_FLAG);
    const openedStats = await handle.stat();
    if (!sameFileIdentity(canonicalStats, openedStats) || openedStats.size > MAX_UPLOAD_BYTES)
      throw new Error("Upload source changed before it could be read safely");
    const buffer = await handle.readFile();
    const postReadStats = await handle.stat();
    if (!sameFileIdentity(openedStats, postReadStats) || buffer.byteLength !== postReadStats.size ||
        buffer.byteLength > MAX_UPLOAD_BYTES)
      throw new Error("Upload source changed while it was being read");
    return { filename: path.basename(canonical), bytes: buffer.byteLength, buffer };
  } catch (error) {
    throw normalizeSymlinkError(error, canonical);
  } finally {
    await handle?.close();
  }
}

export async function reserveUniqueDownloadFile(suggestedFilename: unknown): Promise<ReservedDownloadFile> {
  if (typeof suggestedFilename !== "string" || suggestedFilename.length === 0 ||
      suggestedFilename.includes("\0") || path.posix.isAbsolute(suggestedFilename) ||
      path.win32.isAbsolute(suggestedFilename) || suggestedFilename.includes("/") ||
      suggestedFilename.includes("\\") || suggestedFilename.includes("..")) {
    throw new Error("Download filename is unsafe");
  }
  const sanitized = suggestedFilename.replace(SAFE_PATH_SEGMENT_PATTERN, "_");
  const extension = path.extname(sanitized);
  const stem = path.basename(sanitized, extension) || "download";
  for (let index = 0; index < 10_000; index += 1) {
    const name = index === 0 ? `${stem}${extension}` : `${stem}-${index}${extension}`;
    const candidate = await resolveDevBrowserTempPath(path.join("downloads", name), { createParents: true });
    let reservation: FileHandle | undefined;
    let keepOpen = false;
    try {
      reservation = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG, 0o600);
      keepOpen = true;
      return { path: candidate, filename: name, handle: reservation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw normalizeSymlinkError(error, candidate);
    } finally {
      if (reservation && !keepOpen) await reservation.close().catch(() => undefined);
    }
  }
  throw new Error("Could not allocate a collision-safe download path");
}
