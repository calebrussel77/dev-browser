// @ts-nocheck
export const fileUploadSizeLimit = 50 * 1024 * 1024;

export async function mkdirIfNeeded() {}

export async function writeTempFile(path, data) {
  const writer = globalThis.writeFile;
  if (typeof writer !== "function")
    throw new Error("writeFile() is not available in the QuickJS sandbox");
  return await writer(path, data);
}

/** Reserves a controlled absolute path for a file the *host* will write on the
 * script's behalf (video recordings). The sandbox never learns a path it did
 * not receive from the host, and cannot escape the temp directory. */
export async function reserveVideoPath(name) {
  const reserve = globalThis.reserveVideoPath;
  if (typeof reserve !== "function")
    throw new Error("Video recording is not available in the QuickJS sandbox");
  return await reserve(name);
}
