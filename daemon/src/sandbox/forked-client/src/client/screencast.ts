// @ts-nocheck
import { Artifact } from "./artifact";
import { DisposableStub } from "./disposable";
import { reserveVideoPath } from "./fileUtils";

/**
 * Sandbox screencast.
 *
 * Behaviourally this is upstream Playwright's client `Screencast`, with two
 * sandbox adaptations:
 *
 * - `start({ path })` never lets the script name a host path. The requested
 *   name is reserved by the host under `~/.dev-browser/tmp/videos`, exactly as
 *   `page.screenshot({ path })` is reserved through `writeTempFile`, and the
 *   resolved absolute path is what the finished artifact is saved to.
 * - `start({ onFrame })` is rejected: no frame data crosses the QuickJS bridge.
 */
export class Screencast {
  constructor(page) {
    this._page = page;
    this._started = false;
    this._artifact = undefined;
    this._savePath = undefined;
  }

  async start(options = {}) {
    if (options.onFrame)
      throw new Error(
        "screencast.start({ onFrame }) is not supported in the QuickJS sandbox; record to a file with { path } instead"
      );
    if (this._started) throw new Error("Screencast is already started");
    this._started = true;

    let savePath;
    try {
      if (options.path !== undefined) savePath = await reserveVideoPath(options.path);
    } catch (error) {
      this._started = false;
      throw error;
    }

    const result = await this._page._channel.screencastStart({
      size: options.size,
      quality: options.quality,
      sendFrames: false,
      record: !!options.path,
    });
    if (result.artifact) {
      this._artifact = Artifact.from(result.artifact);
      this._savePath = savePath;
    }
    return new DisposableStub(() => this.stop());
  }

  async stop() {
    await this._page._wrapApiCall(async () => {
      this._started = false;
      await this._page._channel.screencastStop();
      // The Artifact class itself is stubbed in this fork because a script must
      // not choose where a host file lands. Saving through the channel with the
      // host-reserved path keeps the recording inside the controlled temp dir.
      if (this._savePath && this._artifact)
        await this._artifact._channel.saveAs({ path: this._savePath });
      this._artifact = undefined;
      this._savePath = undefined;
    });
  }

  async showActions(options) {
    await this._page._channel.screencastShowActions({
      duration: options?.duration,
      position: options?.position,
      fontSize: options?.fontSize,
      cursor: options?.cursor,
    });
    return new DisposableStub(() => this._page._channel.screencastHideActions());
  }

  async hideActions() {
    await this._page._channel.screencastHideActions();
  }

  async showOverlay(html, options) {
    const { id } = await this._page._channel.screencastShowOverlay({
      html,
      duration: options?.duration,
    });
    return new DisposableStub(() => this._page._channel.screencastRemoveOverlay({ id }));
  }

  async showChapter(title, options) {
    await this._page._channel.screencastChapter({ title, ...options });
  }

  async showOverlays() {
    await this._page._channel.screencastSetOverlayVisible({ visible: true });
  }

  async hideOverlays() {
    await this._page._channel.screencastSetOverlayVisible({ visible: false });
  }
}
