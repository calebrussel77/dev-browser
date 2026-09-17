export function heavyPage(): string {
  const cards = Array.from(
    { length: 150 },
    (_, index) => `
      <li class="card" data-testid="card-${index}">
        <img alt="avatar ${index}" src="data:," width="40" height="40">
        <div>
          <h3>Person ${index}</h3>
          <p>Title ${index} at Company ${index} · 2nd</p>
          <span>Mutual ${index}</span>
        </div>
        <button type="button">Connect</button>
        <button type="button" aria-label="More actions ${index}">…</button>
        <a href="/in/person-${index}">View profile</a>
      </li>`
  ).join("");
  const navigation = Array.from(
    { length: 30 },
    (_, index) => `<a href="/nav/${index}">Nav ${index}</a>`
  ).join("");
  const suggestions = Array.from(
    { length: 25 },
    (_, index) =>
      `<div class="suggestion"><span>Suggested ${index}</span><button>Connect</button></div>`
  ).join("");

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>Heavy page</title>
        <style>
          body { font-family: sans-serif; }
          ul { list-style: none; padding: 0; }
          .card { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid #eee; }
          .spinner { animation: spin 1s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <header>
          <nav aria-label="Primary">
            ${navigation}
            <input type="search" placeholder="Search" aria-label="Search">
          </nav>
        </header>
        <main>
          <h1>People you may know</h1>
          <div class="spinner">⟳</div>
          <ul id="list">${cards}</ul>
          <form>
            <label>Note <textarea id="note" name="note"></textarea></label>
            <button type="submit" disabled>Send</button>
          </form>
        </main>
        <aside aria-label="Suggestions">${suggestions}</aside>
        <footer><a href="/about">About</a><a href="/privacy">Privacy</a></footer>
      </body>
    </html>`;
}
