import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";
const DOWNLOAD_FILENAME = "agent-fixture.txt";

// Deterministic virtualized-list fixture: 60 logical conversation rows, only
// VIRTUAL_LIST_VISIBLE rendered at a time (DOM nodes recycled on scroll),
// each with a stable per-row identity (a unique data-testid) so a scanning
// agent can recognize the same logical row across repeated scroll steps
// even though its underlying DOM node is reused for a different index.
const VIRTUAL_LIST_ROW_COUNT = 60;
const VIRTUAL_LIST_VISIBLE = 12;
const VIRTUAL_LIST_ROW_HEIGHT = 40;
const VIRTUAL_LIST_HEIGHT = VIRTUAL_LIST_VISIBLE * VIRTUAL_LIST_ROW_HEIGHT;

// Unnamed scroll-container fixture: a plain div with overflow-y:auto and no
// role/aria-label/test-id, like the wrappers real pages put around feeds.
// Perception must still assign it a ref so `scroll --ref` and
// `find --scroll-container` can target it.
// Only one row carries a role (making it an actionable perception record the
// find pool can match); the rest stay plain text divs so the fixture adds a
// minimal number of records and does not starve default perception budgets
// for elements that come later (frame contents in particular).
const PLAIN_FEED_ROW_COUNT = 24;
const PLAIN_FEED_TARGET_ROW = 19;
const PLAIN_FEED_ROW_HEIGHT = 40;
const PLAIN_FEED_HEIGHT = 4 * PLAIN_FEED_ROW_HEIGHT;

export interface AgentReliabilityFixture {
  mainUrl: string;
  crossOriginFrameUrl: string;
  uploadRoot: string;
  downloadRoot: string;
  close(): Promise<void>;
}

function html(body: string, script = "", style = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent reliability fixture</title>
    <style>${style}</style>
  </head>
  <body>
    ${body}
    ${script ? `<script>${script}</script>` : ""}
  </body>
</html>`;
}

function sendHtml(response: Parameters<RequestListener>[1], body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function framePage(kind: string, nestedChildUrl?: string): string {
  const nested = nestedChildUrl
    ? `<div style="height:40px"></div><iframe style="margin-left:24px;border:3px solid #333" data-testid="nested-child-frame" title="Nested child frame" src="${nestedChildUrl}"></iframe>`
    : "";
  const controls = kind === "same-origin"
    ? `<button data-testid="same-frame-action">Same frame action</button><output data-testid="frame-result">idle</output>
       <input aria-label="Frame editor"><select aria-label="Frame select"><option value="a">Alpha</option><option value="b">Beta</option></select>
       <label><input type="checkbox" aria-label="Frame check">Frame check</label><button data-testid="frame-hover">Frame hover</button>
       <div draggable="true" role="button" aria-label="Frame drag source">drag</div><div role="button" aria-label="Frame drop target">drop</div>
       <input type="file" aria-label="Frame upload"><output data-testid="frame-events">idle</output>`
    : kind === "cross-origin"
      ? '<label>Cross frame input<input aria-label="Cross frame input"></label>'
      : kind === "nested-child"
        ? '<button data-testid="nested-frame-action">Nested frame action</button><output data-testid="nested-result">idle</output>'
        : kind === "initial"
          ? '<button data-testid="initial-frame-action">Initial frame action</button><output>initial-clicks:0</output>'
          : kind === "navigated"
            ? '<button data-testid="navigated-frame-action">Navigated frame action</button><output>navigated-clicks:0</output>'
            : "";
  return html(`<p data-testid="frame-kind">${kind}</p>${controls}${nested}`, `
    document.querySelector('[data-testid=same-frame-action]')?.addEventListener('click', () => document.querySelector('[data-testid=frame-result]').textContent = 'clicked');
    document.querySelector('[data-testid=frame-hover]')?.addEventListener('mouseenter', () => document.querySelector('[data-testid=frame-events]').textContent = 'hovered');
    document.querySelector('[aria-label="Frame drop target"]')?.addEventListener('dragover', event => event.preventDefault());
    document.querySelector('[aria-label="Frame drop target"]')?.addEventListener('drop', event => { event.preventDefault(); document.querySelector('[data-testid=frame-events]').textContent = 'dropped'; });
    document.querySelector('[aria-label="Frame upload"]')?.addEventListener('change', event => document.querySelector('[data-testid=frame-events]').textContent = event.target.files[0]?.name ?? 'idle');
    document.querySelector('[data-testid=nested-frame-action]')?.addEventListener('click', () => document.querySelector('[data-testid=nested-result]').textContent = 'clicked');
    let initialClicks = 0; document.querySelector('[data-testid=initial-frame-action]')?.addEventListener('click', () => document.querySelector('output').textContent = 'initial-clicks:' + (++initialClicks));
    let navigatedClicks = 0; document.querySelector('[data-testid=navigated-frame-action]')?.addEventListener('click', () => document.querySelector('output').textContent = 'navigated-clicks:' + (++navigatedClicks));
  `, 'body{margin:0;padding:8px}');
}

function mainPage(origin: string, crossOriginFrameUrl: string): string {
  const sameOriginFrameUrl = `${origin}/frame/same-origin`;
  const nestedFrameUrl = `${origin}/frame/nested`;
  const navigableFrameUrl = `${origin}/frame/initial`;

  return html(
    `<header><h1>Agent reliability fixture</h1></header>
    <div data-testid="fixed-overlay">Fixed overlay</div>
    <nav data-testid="sticky-header">Sticky fixture navigation</nav>
    <main>
      <section data-testid="duplicate-actions">
        <button data-testid="connect-main">Connect</button>
      </section>
      <section data-testid="portal-controls">
        <button data-testid="menu-trigger">Open menu</button>
        <button data-testid="dialog-trigger">Open dialog</button>
        <button data-testid="toast-trigger">Show toast</button>
      </section>
      <section data-testid="form-controls">
        <input data-testid="text-input" aria-label="Text input">
        <textarea data-testid="textarea" aria-label="Textarea"></textarea>
        <select data-testid="select" aria-label="Select"><option value="alpha">Alpha</option><option value="beta">Beta</option></select>
        <label><input data-testid="checkbox" type="checkbox"> Checkbox</label>
        <label><input data-testid="radio-a" type="radio" name="fixture-radio" checked> Radio A</label>
        <label><input data-testid="radio-b" type="radio" name="fixture-radio"> Radio B</label>
        <button data-testid="disabled-control" disabled>Disabled</button>
        <input data-testid="readonly-control" value="Readonly" readonly>
        <div data-testid="editor" contenteditable="true">Editable content</div>
        <input data-testid="file-input" type="file" aria-label="Upload fixture">
        <output data-testid="file-name">No file</output>
      </section>
      <section data-testid="async-controls">
        <button data-testid="delayed-dom-trigger">Update DOM later</button>
        <output data-testid="delayed-dom-result">Waiting</output>
        <button data-testid="fetch-trigger">Submit request</button>
        <output data-testid="fetch-result">Waiting</output>
        <button data-testid="failed-request-trigger">Trigger failed request</button>
      </section>
      <section data-testid="navigation-controls">
        <button data-testid="spa-navigation">SPA details</button>
        <output data-testid="spa-location">/</output>
        <a data-testid="document-navigation" href="/document-target">Document target</a>
        <a data-testid="popup-link" href="/popup-target" target="_blank">Open popup</a>
        <button data-testid="delayed-popup">Open delayed popup</button>
        <a data-testid="download-link" href="/download/agent-fixture.txt" download>Download fixture</a>
        <a data-testid="interrupted-download-link" href="/download/interrupted.txt" download>Interrupted download</a>
      </section>
      <section data-testid="edge-cases">
        <a href="#nested-edge"><button data-testid="nested-link-button" type="button">Nested link button</button></a>
        <div data-testid="shadow-host"></div>
        <div data-testid="closed-shadow-host"></div>
        <p data-testid="closed-shadow-marker">Closed shadow root intentionally inaccessible</p>
      </section>
      <section data-testid="frames">
        <iframe data-testid="same-origin-frame" title="Same origin frame" src="${sameOriginFrameUrl}"></iframe>
        <iframe data-testid="cross-origin-frame" title="Cross origin frame" src="${crossOriginFrameUrl}"></iframe>
        <iframe data-testid="nested-frame" title="Nested frame" src="${nestedFrameUrl}"></iframe>
        <iframe data-testid="navigable-frame" title="Navigable frame" src="${navigableFrameUrl}"></iframe>
        <button data-testid="navigate-frame">Navigate frame</button>
        <button data-testid="remove-frame">Remove frame</button>
      </section>
      <section data-testid="obscured-region">
        <button data-testid="obscured-target" data-intentionally-obscured="true">Obscured target</button>
        <div data-testid="obscuring-layer">Obscuring layer</div>
      </section>
      <section data-testid="load-more-region">
        <output data-testid="load-count">0 / 3</output>
        <div data-testid="loaded-items"></div>
        <button data-testid="load-more">Load more</button>
      </section>
      <section data-testid="virtual-list-region">
        <p>Conversations</p>
        <div data-testid="virtual-list" role="region" aria-label="Conversation list" style="height:${VIRTUAL_LIST_HEIGHT}px;overflow-y:auto;position:relative;border:1px solid #ccc">
          <div data-testid="virtual-list-spacer" style="height:${VIRTUAL_LIST_ROW_COUNT * VIRTUAL_LIST_ROW_HEIGHT}px;position:relative">
            <div data-testid="virtual-list-viewport" style="position:absolute;top:0;left:0;right:0"></div>
          </div>
        </div>
      </section>
      <div data-testid="tall-spacer"></div>
      <p data-testid="scroll-target">End of tall content</p>
      <section data-testid="plain-scroll-region">
        <p>Plain feed</p>
        <div style="height:${PLAIN_FEED_HEIGHT}px;overflow-y:auto;border:1px solid #ccc">
          ${Array.from({ length: PLAIN_FEED_ROW_COUNT }, (_, index) => `<div${index + 1 === PLAIN_FEED_TARGET_ROW ? ' role="listitem"' : ""} style="height:${PLAIN_FEED_ROW_HEIGHT}px">Feed item ${index + 1}</div>`).join("")}
        </div>
      </section>
    </main>
    <aside><button data-testid="connect-aside">Connect</button></aside>
    <div id="portal-root"></div>`,
    `const portalRoot = document.querySelector("#portal-root");
document.querySelector("[data-testid=menu-trigger]").addEventListener("click", () => {
  portalRoot.innerHTML = '<div role="menu" data-testid="portal-menu"><button role="menuitem">Profile</button></div>';
});
document.querySelector("[data-testid=dialog-trigger]").addEventListener("click", () => {
  const dialog = document.createElement("dialog");
  dialog.dataset.testid = "fixture-dialog";
  dialog.innerHTML = 'Local dialog <button data-testid="dialog-close">Close dialog</button>';
  portalRoot.append(dialog);
  dialog.querySelector("[data-testid=dialog-close]").addEventListener("click", () => dialog.close());
  dialog.showModal();
});
document.querySelector("[data-testid=toast-trigger]").addEventListener("click", () => {
  const toast = document.createElement("div");
  toast.dataset.testid = "fixture-toast";
  toast.setAttribute("role", "status");
  toast.textContent = "Saved locally";
  portalRoot.append(toast);
});
document.querySelector("[data-testid=delayed-dom-trigger]").addEventListener("click", () => {
  setTimeout(() => document.querySelector("[data-testid=delayed-dom-result]").textContent = "DOM updated", 80);
});
document.querySelector("[data-testid=fetch-trigger]").addEventListener("click", async () => {
  const response = await fetch("/api/submit", { method: "POST", body: "fixture" });
  const payload = await response.json();
  setTimeout(() => document.querySelector("[data-testid=fetch-result]").textContent = "Fetch complete: " + payload.status, 80);
});
document.querySelector("[data-testid=failed-request-trigger]").addEventListener("click", () => {
  fetch("/api/failure").catch(() => {});
});
document.querySelector("[data-testid=spa-navigation]").addEventListener("click", () => {
  history.pushState({}, "", "/spa/details");
  document.querySelector("[data-testid=spa-location]").textContent = location.pathname;
});
document.querySelector("[data-testid=delayed-popup]").addEventListener("click", () => {
  setTimeout(() => window.open("/popup-target", "_blank"), 200);
});
document.querySelector("[data-testid=file-input]").addEventListener("change", (event) => {
  document.querySelector("[data-testid=file-name]").textContent = event.target.files[0]?.name ?? "No file";
});
document.querySelector("[data-testid=navigate-frame]").addEventListener("click", () => {
  document.querySelector("[data-testid=navigable-frame]").src = "/frame/navigated";
});
document.querySelector("[data-testid=remove-frame]").addEventListener("click", () => {
  document.querySelector("[data-testid=navigable-frame]")?.remove();
});
let loadCount = 0;
document.querySelector("[data-testid=load-more]").addEventListener("click", (event) => {
  if (loadCount >= 3) return;
  loadCount += 1;
  document.querySelector("[data-testid=loaded-items]").insertAdjacentHTML("beforeend", '<p data-testid="loaded-item">Loaded item ' + loadCount + '</p>');
  document.querySelector("[data-testid=load-count]").textContent = loadCount + " / 3";
  if (loadCount === 3) event.currentTarget.disabled = true;
});
const openHost = document.querySelector("[data-testid=shadow-host]");
const openRoot = openHost.attachShadow({ mode: "open" });
openRoot.innerHTML = '<button data-testid="shadow-action">Shadow action</button><output data-testid="shadow-result">idle</output><div id="nested-shadow-host"></div>';
openRoot.querySelector('[data-testid=shadow-action]').addEventListener('click', () => openRoot.querySelector('[data-testid=shadow-result]').textContent = 'clicked');
openRoot.querySelector('#nested-shadow-host').attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Nested shadow input">';
const closedHost = document.querySelector("[data-testid=closed-shadow-host]");
closedHost.attachShadow({ mode: "closed" }).innerHTML = '<button>Closed action</button>';
(function virtualizedList() {
  const ROW_COUNT = ${VIRTUAL_LIST_ROW_COUNT};
  const VISIBLE = ${VIRTUAL_LIST_VISIBLE};
  const ROW_HEIGHT = ${VIRTUAL_LIST_ROW_HEIGHT};
  const container = document.querySelector('[data-testid=virtual-list]');
  const viewport = document.querySelector('[data-testid=virtual-list-viewport]');
  const rendered = new Map();
  function render() {
    const start = Math.max(0, Math.min(ROW_COUNT - VISIBLE, Math.floor(container.scrollTop / ROW_HEIGHT)));
    const end = Math.min(ROW_COUNT, start + VISIBLE);
    for (const [index, node] of rendered) {
      if (index < start || index >= end) { node.remove(); rendered.delete(index); }
    }
    for (let index = start; index < end; index += 1) {
      if (rendered.has(index)) continue;
      const rowNumber = index + 1;
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-testid', 'conversation-row-' + rowNumber);
      row.setAttribute('aria-label', 'Conversation ' + rowNumber);
      row.style.position = 'absolute';
      row.style.left = '0';
      row.style.right = '0';
      row.style.top = (index * ROW_HEIGHT) + 'px';
      row.style.height = ROW_HEIGHT + 'px';
      row.textContent = 'Conversation ' + rowNumber;
      viewport.appendChild(row);
      rendered.set(index, row);
    }
  }
  container.addEventListener('scroll', render);
  render();
})();`,
    `body { font-family: sans-serif; margin: 0; }
main, aside { padding: 16px; }
section { margin: 24px 0; }
[data-testid="fixed-overlay"] { position: fixed; right: 8px; top: 8px; z-index: 20; background: #ffd54f; padding: 8px; }
[data-testid="sticky-header"] { position: sticky; top: 0; z-index: 10; background: #e3f2fd; padding: 8px; }
[data-testid="obscured-region"] { position: relative; width: 220px; height: 80px; }
[data-testid="obscured-target"], [data-testid="obscuring-layer"] { position: absolute; inset: 0; }
[data-testid="obscuring-layer"] { z-index: 2; display: grid; place-items: center; background: rgba(255, 0, 0, .75); }
[data-testid="tall-spacer"] { height: 1600px; }
iframe { display: block; width: 360px; height: 260px; margin: 8px 0; }`
  );
}

export async function startAgentReliabilityFixture(): Promise<AgentReliabilityFixture> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "dev-browser-agent-reliability-"));
  const uploadRoot = path.join(tempRoot, "uploads");
  const downloadRoot = path.join(tempRoot, "downloads");
  await Promise.all([mkdir(uploadRoot), mkdir(downloadRoot)]);
  await writeFile(path.join(downloadRoot, DOWNLOAD_FILENAME), "deterministic fixture download\n");

  const crossOriginServer = createServer((_request, response) => {
    sendHtml(response, framePage("cross-origin"));
  });
  let crossOriginPort: number;
  try {
    crossOriginPort = await listen(crossOriginServer);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const crossOriginFrameUrl = `http://${LOOPBACK_HOST}:${crossOriginPort}/frame/cross-origin`;

  let origin = "";
  const mainServer = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", origin);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/spa/details") {
      sendHtml(response, mainPage(origin, crossOriginFrameUrl));
      return;
    }
    if (requestUrl.pathname === "/document-target") {
      sendHtml(response, html('<h1 data-testid="document-target">Full document target</h1>'));
      return;
    }
    if (requestUrl.pathname === "/popup-target") {
      const requestedTitle = requestUrl.searchParams.get("title");
      sendHtml(
        response,
        requestedTitle
          ? `<!doctype html><html><head><title>${requestedTitle.replace(/[<>&]/g, "")}</title></head><body><h1 data-testid="popup-target">Popup target</h1></body></html>`
          : html('<h1 data-testid="popup-target">Popup target</h1>')
      );
      return;
    }
    if (requestUrl.pathname === "/frame/same-origin") {
      sendHtml(response, framePage("same-origin"));
      return;
    }
    if (requestUrl.pathname === "/frame/nested") {
      sendHtml(response, framePage("nested-parent", `${origin}/frame/nested-child`));
      return;
    }
    if (requestUrl.pathname === "/frame/nested-child") {
      sendHtml(response, framePage("nested-child"));
      return;
    }
    if (requestUrl.pathname === "/frame/initial") {
      sendHtml(response, framePage("initial"));
      return;
    }
    if (requestUrl.pathname === "/frame/navigated") {
      sendHtml(response, framePage("navigated"));
      return;
    }
    if (requestUrl.pathname === "/api/submit" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "accepted" }));
      return;
    }
    if (requestUrl.pathname === "/api/failure") {
      request.socket.destroy();
      return;
    }
    if (requestUrl.pathname === `/download/${DOWNLOAD_FILENAME}`) {
      response.writeHead(200, {
        "content-disposition": `attachment; filename="${DOWNLOAD_FILENAME}"`,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("deterministic fixture download\n");
      return;
    }
    if (requestUrl.pathname === "/download/interrupted.txt") {
      response.writeHead(200, {
        "content-disposition": 'attachment; filename="interrupted.txt"',
        "content-length": "100000",
        "content-type": "text/plain; charset=utf-8",
      });
      response.write("partial");
      response.socket?.destroy();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  try {
    const mainPort = await listen(mainServer);
    origin = `http://${LOOPBACK_HOST}:${mainPort}`;
  } catch (error) {
    await Promise.allSettled([closeServer(crossOriginServer), rm(tempRoot, { recursive: true })]);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    mainUrl: `${origin}/`,
    crossOriginFrameUrl,
    uploadRoot,
    downloadRoot,
    close() {
      closing ??= Promise.allSettled([
        closeServer(mainServer),
        closeServer(crossOriginServer),
      ]).then(async (results) => {
        await rm(tempRoot, { recursive: true, force: true });
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      return closing;
    },
  };
}
