# Plan d'implémentation — dev-browser 2 à 3x plus rapide pour les agents IA

> **Pour l'agent implémenteur :** ce plan est autonome. Il se lit et s'exécute depuis un clone local du dépôt, sur la machine du propriétaire, avec son Chrome d'automatisation exposé sur le port CDP **9223** (session connectée à LinkedIn et à d'autres applications). Exécute les tâches dans l'ordre, coche les cases (`- [ ]`) au fur et à mesure, et ne passe à la phase suivante que lorsque les critères d'acceptation de la phase courante sont mesurés et consignés. Chaque phase se termine par un commit et une PR distincte.

**Objectif :** qu'un agent IA qui pilote un navigateur avec `dev-browser` termine ses tâches 2 à 3 fois plus vite, sans perdre les garanties de sécurité existantes (input trusted, refs/états versionnés, tokens de confirmation, erreurs typées).

**Stack :** CLI Rust/clap (`cli/`), daemon Node/TypeScript (`daemon/`), Playwright 1.61.1, Chromium via CDP, Vitest, esbuild.

---

## 1. Diagnostic de départ (mesuré le 2026-09-17)

Le temps d'une tâche agent se décompose en trois choses : le nombre d'appels CLI (chaque appel coûte un tour d'inférence LLM, typiquement 2 à 10 s), la taille de chaque réponse (qui allonge chaque tour et remplit le contexte), et la latence du daemon par commande. Le CLI Rust lui-même est négligeable.

Mesures de référence, Chromium headless local, Playwright 1.61.1, pages locales (fixture `daemon/src/test-fixtures/agent-reliability-fixture.ts` et une page synthétique de ~1 000 éléments) :

| Commande CLI (bout en bout) | Latence | Taille de la sortie | Messages CDP envoyés |
|---|---:|---:|---:|
| `status`, `pages` (surcoût CLI + handshake + requête) | 17 à 22 ms | 0,3 KB | 11 |
| `observe` par défaut | 210 ms | 85 KB (~22 000 tokens) | 13 sans iframe, 300 avec iframes |
| `find --role button --name X --within main` | 185 ms | 12,6 KB | 3 |
| `click --ref` sans `--wait-*` | 1 100 à 1 200 ms | 89 KB (~23 000 tokens) | 191 sans iframe, 516 avec |
| `click --ref --shot` | 1 350 ms | 90 KB | 1 475 avec iframes |
| `type --ref` (12 à 40 caractères) | 1 150 à 1 330 ms | 94 KB | 1 366 avec iframes |
| `press --ref Tab` | 1 310 ms | 109 KB | 187 |
| `scroll --direction down` | 950 ms | 108 KB | 42 |
| `text --within main` | 25 ms | 11 KB | 3 |
| `shot` seul | 460 ms | 87 KB | 585 avec iframes |
| script sandbox trivial (`title()`) | 155 à 265 ms | | 1 |
| `click --ref --wait-text ...` sur une page de ~1 000 éléments | **échec `WAIT_TIMEOUT` après 3 s** | | |

Décomposition d'une réponse `observe` de 88 KB : `elements[]` = 77 KB, `tree` = 2,6 KB, le reste < 1 KB. L'arbre contient déjà refs, rôles, noms et états.

Décomposition d'un `click` de ~1,1 s sur une page sans iframe : ~700 ms d'attente `networkIdle` (idle 700 ms dans une fenêtre de 750 ms, toujours atteinte sur une page statique), + 150 ms de `setTimeout` après le `WAIT_TIMEOUT`, + 3 collectes de perception complètes (`collectPageState`) + 3 `collectLiveSnapshot` + ~160 ms de `resolveActionTarget` (159 messages CDP pour un seul ref).

Causes racines, par fichier :

| Cause | Où |
|---|---|
| `elements[]` renvoyé par défaut avec ~35 champs par élément | `daemon/src/interactive-actions.ts` `applyPerception(..., includeElements = true)` |
| Sortie JSON pretty-printed (88 KB vs 52 KB compact) | `cli/src/main.rs` `render_result`, `ResultMode::Json` |
| Plancher de 700 ms + 150 ms sur click/press | `daemon/src/interactive-actions.ts` `PRESS_SETTLE_MS = 750`, `monitoringWait` par défaut `networkIdle idleMs: 700`, `setTimeout(resolve, 150)` sur `WAIT_TIMEOUT` |
| 3 à 4 perceptions complètes par action | `validateDecisionRefs` appelé dans `clickOnce` puis dans `prepareClickInput`, `runWithWait(... collect: perceive)`, bloc final `if (!result.coordinateSpace)`, `visualPerception` pour `--shot` |
| ~90 `Runtime.callFunctionOn` pour résoudre un ref | `daemon/src/actionability.ts` `resolveActionTarget` (evaluateHandle, getAttribute ×2, setAttribute, count, evaluate hidden, evaluate tagName, boundingBox ×2, isVisible, elementHandle ×2, `inspectTarget` ×2, `validateApplicability` ×2, `offsets` ×2, `stableBox` avec budget 200 à 500 ms, hit-test, `frameToTopMatrix`) |
| `--wait-text` / `--wait-dialog` échouent sur les vraies pages | `daemon/src/live-snapshot.ts` `MAX_WORK = 1_000` rend le snapshot toujours `truncated` au-delà de 1 000 éléments ; `daemon/src/wait-engine.ts` exige `!scoped.truncated` pour `passed` |
| Poll toutes les 25 ms avec une collecte DOM complète par poll | `daemon/src/wait-engine.ts` `POLL_INTERVAL_MS = 25`, `sharedDomSnapshot`, `sharedScopedText` |
| Coût des iframes | `daemon/src/perception/collector.ts` `deterministicFrames`, `frameToTopMatrix`, `frameAncestorsVisible`, `targetObscuredAcrossFrames` refont `frameElement()` + `evaluate` par frame à chaque collecte |
| `--shot` : perception supplémentaire + décodage/encodage PNG en JS pur pour l'annotation | `daemon/src/visual-artifacts.ts` `decodePng`, `captureVisualArtifacts` ; bloc `--shot` de `executeInteractiveAction` |
| Sandbox recréée à chaque script (runtime QuickJS + bundle client 430 KB + `initializePlaywright`) | `daemon/src/sandbox/script-runner-quickjs.ts` `runScript`, `daemon/src/sandbox/quickjs-sandbox.ts` `initialize` |
| Verrou par browser : commandes sérialisées même sur des onglets différents | `daemon/src/daemon.ts` `withBrowserLock = createKeyedLock<string>()` |
| Flux documenté long (6 appels pour "Connect + note", screenshot ouvert à chaque étape), `--help` de 26 KB | `skills/dev-browser/SKILL.md`, `skills/dev-browser/references/interactive-loop.md`, `cli/llm-guide.txt`, `README.md` |

## 2. Cibles chiffrées (critères d'acceptation globaux)

Mesurées avec les outils de la phase 0, avant/après, sur la même machine. "Local" = fixture et page synthétique ; "live" = Chrome 9223 sur une page LinkedIn de messagerie et le fil d'actualité.

| Métrique | Avant (référence ci-dessus) | Cible |
|---|---:|---:|
| Taille médiane d'une réponse `observe` par défaut (local, page ~1 000 éléments) | 85 KB | ≤ 8 KB |
| Taille médiane d'une réponse `click` / `type` par défaut | 89 à 94 KB | ≤ 6 KB |
| Taille médiane d'une réponse `find` par défaut | 12,6 KB | ≤ 2 KB |
| Latence médiane `click --ref` sans wait (local, page statique) | 1 100 ms | ≤ 350 ms |
| Latence médiane `type --ref` 40 caractères (local) | 1 300 ms | ≤ 450 ms |
| Latence médiane `click --ref` sans wait (live LinkedIn messagerie) | à mesurer en phase 0 | ≤ 45 % de la valeur "avant" |
| `click --ref --wait-text "visible,body,contains,<texte présent>"` (live LinkedIn) | échec `WAIT_TIMEOUT` attendu | succès en < 1,5 s |
| Messages CDP pour un `click --ref` (local, sans iframe) | 191 | ≤ 60 |
| Messages CDP pour un `observe` (fixture avec 3 iframes) | 300 | ≤ 80 |
| Nombre d'appels CLI pour le scénario live S3 (ouvrir un fil, lire, rédiger un brouillon, effacer) | 7 à 9 | ≤ 4 |
| Suite Vitest complète, `tsc --noEmit`, `cargo test`, `cargo build` | verts | verts |
| Tests de sécurité existants (tokens de confirmation, `--require-ancestor-text`, `TARGET_DISABLED`, `INPUT_VALUE_MISMATCH`, leases) | verts | verts, sans modification de leurs assertions |

## 3. Contraintes globales

- Outils : `pnpm` pour `daemon/`, Cargo pour `cli/`. Pas de Bun. Ne pas ajouter de dépendance runtime au daemon sans justification écrite dans la PR.
- Validation obligatoire avant chaque commit touchant le runtime : `cd daemon && npx tsc --noEmit`, `cd daemon && pnpm vitest run`, `cd cli && cargo build`. Avant `cargo build`, régénérer les bundles : `cd daemon && pnpm bundle && pnpm bundle:sandbox-client` (le binaire Rust les embarque via `include_str!`).
- Compatibilité : le protocole v1 reste inchangé. Toute nouvelle option, tout nouveau champ de réponse et tout changement de valeur par défaut est déclaré dans `cli/src/discovery.rs` (`agent_schema`, `compact_capabilities`, `focused_example`), documenté dans `README.md`, `cli/llm-guide.txt`, `skills/dev-browser/`, et listé dans la section `[Unreleased]` de `CHANGELOG.md`.
- Un changement de valeur par défaut qui réduit la sortie (phase 1) est un changement de contrat : incrémenter `DISCOVERY_SCHEMA_VERSION` dans `cli/src/discovery.rs` et documenter le flag qui restaure l'ancien comportement.
- Le code de production reste agnostique du site. Aucun sélecteur LinkedIn dans `daemon/src` ou `cli/src`. Les comportements LinkedIn sont reproduits par des fixtures locales déterministes.
- Les erreurs typées et leurs codes de sortie (`daemon_error_exit_code` dans `cli/src/main.rs`) ne changent pas. Tout nouveau code d'erreur y est enregistré et couvert par `maps_typed_agent_errors_to_stable_exit_codes`.
- Pas de régression sur `daemon/src/reliability-benchmark.test.ts` ; ses seuils sont resserrés en phase 2 (voir tâche 2.9).
- La machine cible est celle du propriétaire (probablement Windows, DPR 1,25 sur le Chrome 9223 d'après `docs/field-reports/2026-07-18-linkedin-acceptance.md`). Les scripts de mesure fournis sont en Node, pas en bash, et fonctionnent en PowerShell.

## 4. Environnement de test live (Chrome 9223) — règles strictes

Le Chrome d'automatisation est lancé par le propriétaire avec `--remote-debugging-port=9223`. Il est connecté à LinkedIn et à d'autres applications. C'est une **vraie session** : tout ce qui est envoyé, publié ou modifié l'est pour de vrai.

Connexion : `dev-browser --connect http://127.0.0.1:9223 pages` (ou `--connect ws://127.0.0.1:9223/devtools/browser/...` lu dans `/json/version` si le HTTP renvoie 404). Toujours découvrir les onglets avec `pages` et sélectionner la cible par URL et titre, jamais par position.

Actions **autorisées** sur LinkedIn : `pages`, `observe`, `find`, `text`, `assert`, `shot`, `navigate` entre pages LinkedIn (`/feed/`, `/messaging/`, `/in/<profil>`, `/search/results/...`), `scroll`, `click` sur des éléments de navigation ou d'ouverture (une ligne de conversation, un onglet, un menu "..." que l'on referme avec `press Escape`, la barre de recherche), `type` dans le compositeur de message ou la recherche **suivi d'un effacement** (`press ControlOrMeta+A` puis `press Backspace`, puis `assert` que le champ est vide), `confirm --expect` (émet un token, n'agit pas), `hover`, `focus`, `press Tab` / `Escape`.

Actions **interdites** : cliquer ou déclencher "Envoyer / Send", "Se connecter / Connect", "Suivre / Follow", "J'aime / Like", "Publier / Post", "Accepter", "Retirer", "Se déconnecter", n'importe quel bouton de paiement ou de paramètres, tout `upload`, tout `click --confirm-token` sur une action réelle, `browser.closePage` ou fermeture d'un onglet que l'agent n'a pas ouvert, `--browser` géré pour les tests live (utiliser uniquement `--connect`). Même règle sur les autres applications ouvertes : lecture, navigation, brouillon effacé ; jamais d'envoi, de sauvegarde ni de suppression.

Hygiène : à la fin de chaque scénario, le compositeur et la recherche sont vides (vérifié par `assert`/`text`), aucun menu n'est resté ouvert, l'onglet est revenu sur `/feed/` ou sur sa page de départ. Les onglets ouverts par l'agent (`--page <nom>` créé pour le test) sont fermés par un script `browser.closePage("<nom>")`. Consigner chaque session live dans `docs/field-reports/<date>-speed-<phase>.md` (format de `docs/field-reports/2026-07-18-linkedin-acceptance.md`).

Cycle de build et d'exécution pour tester une modification en live :

```
cd daemon && pnpm install && pnpm bundle && pnpm bundle:sandbox-client
cd ../cli && cargo build --release
# première fois seulement : installe ~/.dev-browser/node_modules et Chromium
<repo>/cli/target/release/dev-browser install
# le CLI redémarre automatiquement un daemon inactif dont le hash a changé ; sinon :
<repo>/cli/target/release/dev-browser stop
<repo>/cli/target/release/dev-browser --connect http://127.0.0.1:9223 pages
```

Note : lancer le daemon depuis `daemon/src/daemon.ts` via `tsx` (`DEV_BROWSER_DAEMON=...daemon.ts`) casse aujourd'hui la perception (`ReferenceError: __name is not defined` dans les fonctions sérialisées vers la page, dû à `keepNames` d'esbuild dans tsx), et `DEV_BROWSER_DAEMON=daemon/dist/daemon.bundle.mjs` échoue à résoudre `playwright-core` (`resolvePlaywrightInternal` dans `daemon/src/sandbox/playwright-internals.ts` ne regarde pas `daemon/node_modules`). La tâche 0.4 corrige ce second point pour accélérer l'itération ; en attendant, utiliser le binaire release.

## 5. Phase 0 — Outillage de mesure (obligatoire avant tout changement)

Aucune optimisation n'est acceptée sans mesure avant/après produite par ces outils.

### Tâche 0.1 — Bench in-process des actions (`daemon/src/perf/bench-actions.test.ts`)

**Fichiers :** créer `daemon/src/perf/bench-actions.test.ts`, `daemon/src/perf/heavy-page.ts` (générateur de page synthétique), `scripts/count-cdp.mjs`.

- [x] Créer le test Vitest de l'annexe A. Il est ignoré sauf si `BENCH=1` (`it.skipIf(!process.env.BENCH)`), pour ne pas ralentir la CI.
- [x] Il mesure pour chaque commande : latence (ms), taille de la réponse en JSON pretty (ce que le CLI imprime aujourd'hui) et compact, tokens estimés (caractères / 4), et écrit un tableau Markdown dans le fichier `BENCH_OUT`.
- [x] Le comptage CDP se fait en lançant avec `DEBUG=pw:protocol` et en redirigeant stderr vers un fichier, puis `node scripts/count-cdp.mjs <fichier>` (annexe A) compte les `SEND ►` entre les marqueurs `@@MARK <étape> START/END` écrits par le bench.
- [x] Ajouter dans `daemon/package.json` : `"bench": "cross-env BENCH=1 vitest run src/perf/bench-actions.test.ts"` ou, sans dépendance, documenter la commande PowerShell `$env:BENCH=1; $env:BENCH_OUT="../docs/perf/local.md"; pnpm vitest run src/perf/bench-actions.test.ts`.

**Critères d'acceptation :** le bench tourne en < 60 s sur la machine du propriétaire ; il produit les colonnes latence / bytes pretty / bytes compact / tokens / messages CDP pour au moins : `observe` défaut, `observe --within main`, `find`, `click --ref`, `click --ref --shot`, `click --ref --wait-text`, `type --ref`, `press`, `scroll`, `text`, `assert`, `shot`, `navigate`, script sandbox ×2, et les primitives brutes `collectPageState`, `collectLiveSnapshot`, `resolveActionTarget`.

### Tâche 0.2 — Bench CLI de bout en bout contre le Chrome 9223 (`scripts/bench-cli.mjs`)

**Fichiers :** créer `scripts/bench-cli.mjs` (annexe B).

- [x] Script Node sans dépendance : lance N fois (défaut 5) chaque commande d'une liste, mesure le temps mur du processus `dev-browser`, la taille de stdout, le code de sortie ; imprime la médiane et l'écart par commande en Markdown.
- [x] Paramètres : `DEV_BROWSER_BIN` (chemin du binaire, défaut `dev-browser`), `CONNECT` (défaut `http://127.0.0.1:9223`), `PAGE` (target id ou nom de page), `URL_FILTER` (pour retrouver la cible via `pages` si `PAGE` est absent).
- [x] Les commandes incluent uniquement des actions autorisées (section 4) : `pages`, `observe`, `observe --within main`, `find --role button --name-mode contains --name <valeur passée en paramètre> --within main`, `text --within main`, `shot`, `click --ref <ref d'une ligne de conversation trouvée par find>`, `press --ref <ref> Escape`, `scroll --direction down --pages 1`.

**Critères d'acceptation :** exécution en PowerShell et en bash ; tableau produit avec médianes ; aucune commande interdite dans la liste.

### Tâche 0.3 — Ligne de base consignée

- [x] Exécuter 0.1 (local) et 0.2 (live : onglet `/messaging/` et onglet `/feed/` de LinkedIn, plus un onglet d'une autre application) sur la machine du propriétaire, **avant** toute modification.
- [x] Commiter `docs/perf/baseline.md` avec les trois tableaux, la version de Chrome (`/json/version`), le DPR, la date, le commit.

**Critères d'acceptation :** `docs/perf/baseline.md` existe, contient les tableaux, et la commande utilisée pour chaque tableau est reproduite dedans.

### Tâche 0.4 — Confort d'itération (petit, optionnel mais recommandé)

- [x] Dans `daemon/src/sandbox/playwright-internals.ts` `tryResolvePlaywrightInternal`, ajouter le candidat `path.resolve(currentDir, "../node_modules/playwright-core", modulePath)` pour que `DEV_BROWSER_DAEMON=<repo>/daemon/dist/daemon.bundle.mjs` fonctionne après `pnpm bundle`, sans `cargo build`.
- [x] Vérifier que `dev-browser status` puis `dev-browser --connect http://127.0.0.1:9223 pages` fonctionnent avec cette variable.

---

## 6. Phase 1 — Réduire les tokens par réponse (PR 1)

### Tâche 1.1 — `elements[]` en opt-in et forme compacte

**Fichiers :** `daemon/src/interactive-actions.ts` (`applyPerception`, `InteractiveResult`), `daemon/src/protocol.ts` (nouveau champ de requête `elements?: boolean` et `verbose?: boolean`), `cli/src/main.rs` (flag global `--elements` et `--verbose` dans `PageActionArgs` et pour `Observe`), `cli/src/interactive.rs` (`build_interactive_request`), `cli/src/discovery.rs`, `daemon/src/perception/collector.ts` (fonction `compactElement`), tests.

- [x] Ajouter `compactElement(element: PerceptionElement)` dans `daemon/src/perception/collector.ts` qui renvoie uniquement : `ref`, `role`, `name`, `box` (entiers arrondis), `landmark`, et les booléens/états **non nuls et non par défaut** (`disabled: true`, `checked`, `expanded`, `selected`, `pressed`, `scrollable: true`, `obscured: true`, `focused: true`, `inViewport: false`), `frameId` seulement si différent de `F0`, `value`/`placeholder`/`inputType` seulement pour les champs de saisie, `stableAttributes` seulement les clés non vides. Pas de `quad`, `framePath`, `frameUrl`, `frameName`, `frameDocumentId`, `semanticAncestors`, `nearby` vide, `description` vide, `shadowContext` vide, `depth`.
- [x] Dans `applyPerception`, ne pas remplir `result.elements` sauf si la requête porte `elements: true` (forme compacte) ou `verbose: true` (forme complète actuelle). `find` continue de renvoyer `matches` (voir 1.4), pas `elements`.
- [x] `tree` reste renvoyé par défaut. Les refs des conteneurs scrollables restent visibles dans l'arbre (suffixe `(scrollable)` déjà présent).
- [x] CLI : `--elements` et `--verbose` acceptés sur toutes les commandes interactives ; `observe --verbose` équivaut à l'ancien comportement.
- [x] `schema --json` : `responseGrammar.commonOptional` retire `elements` du défaut et documente `elements` (compact, sur `--elements`) et `verbose`. Incrémenter `DISCOVERY_SCHEMA_VERSION`.

**Tests :**
- `daemon/src/perception/collector.test.ts` : `compactElement` omet les champs vides/nuls et arrondit `box` ; un élément désactivé garde `disabled: true` ; un élément de frame garde `frameId`.
- `daemon/src/interactive-actions.test.ts` : `observe` par défaut n'a pas de clé `elements` ; avec `elements: true` chaque élément compact pèse < 200 caractères en JSON ; avec `verbose: true` la forme complète est identique à l'ancienne (snapshot de clés).
- `daemon/src/protocol.test.ts` : les champs `elements`/`verbose` sont acceptés et optionnels, refusés en protocole v1 s'ils sont vrais.
- `cli/src/main.rs` tests : `--elements`/`--verbose` parsent et se retrouvent dans la requête.

**Critères d'acceptation :** bench 0.1 : `observe` défaut ≤ 8 KB pretty sur la page synthétique ; `click`/`type` défaut ≤ 6 KB ; `observe --elements` ≤ 25 KB ; `observe --verbose` = taille d'avant ± 5 %.

Mesure intermédiaire 1.1 : `observe` 4,2 KB, `observe --elements` 22,6 KB, `observe --verbose` 105,9 KB contre 105,8 KB avant (+0,07 %). `click`/`type` sont à 8,0/8,1 KB ; la suppression des champs de bruit prévue en 1.3 est nécessaire pour franchir le seuil de 6 KB.

**Test live :** `observe --page <messagerie> --within main` renvoie l'arbre avec les lignes de conversation et leurs refs ; `find` puis `click --ref` sur une ligne fonctionne sans `elements` ; `observe --elements` donne les boxes nécessaires à un `--xy`.

### Tâche 1.2 — Delta systématique après une action

**Fichiers :** `daemon/src/interactive-actions.ts`, `daemon/src/page-state.ts`.

- [x] Pour `click`, `type`, `press`, `paste`, `scroll`, `select`, `check`, `uncheck`, `hover`, `drag`, `back`, `forward`, `reload`, `navigate` : la perception finale est appelée avec `delta: true` sur le track `default` (aujourd'hui seulement certains chemins). Le delta est renvoyé sous `delta: { url?, title?, focus?, added: [...], removed: [...], changed: [...] }` borné à 50 refs par liste (avec `truncated: true` au-delà).
- [x] Ajouter `delta.summary`: une ligne courte, p. ex. `"+12 −3 ~4 refs, url changed, dialog opened"`, calculée côté daemon.
- [x] `page-state.ts` : le calcul du delta ne doit pas sérialiser `semanticFingerprint` deux fois par élément (mémoïser par ref au sein d'un `recordPageState`).

**Tests :** `page-state.test.ts` ou nouveau `ref-state.test.ts` cas : delta borné ; summary correcte ; delta null sur la première observation d'un track.

**Critères d'acceptation :** réponse d'un `click` qui ouvre une modale contient `delta.added` avec les refs de la modale et `delta.summary` mentionne `dialog opened` (fixture `agent-reliability-fixture` a une modale).

### Tâche 1.3 — Sortie compacte côté CLI, arrondis, champs de bruit

**Fichiers :** `cli/src/main.rs` (`render_result`, nouveau flag global `--pretty`), `daemon/src/interactive-actions.ts`, `daemon/src/agent-protocol.ts` (`buildInteractiveSuccess`).

- [ ] `render_result` imprime `serde_json::to_string` (compact) par défaut ; `--pretty` restaure l'indentation. Une seule ligne JSON par résultat facilite aussi le parsing.
- [ ] Le daemon arrondit toutes les coordonnées et dimensions à l'entier (`box`, `point`, `scroll`, `coordinateSpace.viewport`) ; `devicePixelRatio` à 2 décimales.
- [ ] Hors `--verbose`, ne pas renvoyer : `attemptJournal`, `attempts`, `targets`, `change` (remplacé par `delta.summary`), `waitForText`, `waitSatisfied`, `coordinateSpace` (renvoyé seulement avec `--shot`, `--elements` ou `--verbose`, puisqu'il ne sert qu'aux coordonnées), `truncation` quand `truncated: false`, `warnings` vide, `focusedRef` null, `delta` null.
- [ ] Le `waitResult` reste renvoyé quand un `--wait-*` explicite a été passé, mais réduit à `{ passed: [...kinds], timedOut: [...], elapsedMs }` hors `--verbose` (la version complète avec `observations` et `events` sous `--verbose`).
- [ ] Sous `--verbose`, tout est renvoyé comme aujourd'hui.

**Tests :** `cli/src/main.rs` : `render_result` compact par défaut, pretty avec le flag ; `daemon/src/interactive-actions.test.ts` : clés absentes par défaut, présentes sous `verbose` ; `agent-protocol.test.ts` : `buildInteractiveSuccess` garde les champs requis (`protocolVersion`, `ok`, `requestId`, `browser`, `page`, `action`).

**Critères d'acceptation :** bench 0.1 : taille compact d'un `click` ≤ 4 KB ; `--verbose` ≥ taille d'avant.

### Tâche 1.4 — `find` compact

**Fichiers :** `daemon/src/interactive-actions.ts` (cas `find`), `daemon/src/targeting.ts`, `cli/src/main.rs` (défaut `--limit`).

- [ ] Par défaut `find` renvoie `matches` sous forme compacte (mêmes règles que `compactElement`, plus `score`, `confidence`, `matchedBecause` réduit à 3 raisons), `--limit` par défaut à 3 (aujourd'hui 10), `ambiguity` et `search` inchangés, pas d'arbre (`tree`) sauf `--verbose`.
- [ ] Quand `ambiguity.ambiguous` est vrai, renvoyer jusqu'à 5 candidats compacts avec `nearby.context` et `landmark` pour permettre de choisir sans nouvel appel.

**Tests :** `interactive-actions.test.ts` : `find` par défaut ≤ 3 matches, chaque match compact ; cas ambigu renvoie ≤ 5 candidats avec `landmark`.

**Critères d'acceptation :** bench : `find` ≤ 2 KB.

### Tâche 1.5 — Warnings de bruit

- [ ] Supprimer le warning permanent `"Closed shadow roots cannot be inspected..."` de `collectPageState` (le déplacer dans `schema --json` sous `limits`).
- [ ] Le warning `"Unversioned decision: ..."` de `daemon/src/ref-state.ts` n'est émis que sous `--verbose` ou quand `--strict-state` est demandé sans `--from-state` (cas contradictoire).

**Tests :** mettre à jour les assertions existantes qui attendent ces warnings ; ajouter un cas `verbose: true` qui les retrouve.

### Tâche 1.6 — Documentation de la phase 1

- [ ] `README.md`, `cli/llm-guide.txt`, `skills/dev-browser/references/interactive-loop.md`, `cli/src/discovery.rs` (`focused_example` de `observe`, `find`, `click`) : montrer la sortie compacte, `--elements`, `--verbose`, `--pretty`.
- [ ] `CHANGELOG.md` `[Unreleased]` : entrée "Compact responses by default".

---

## 7. Phase 2 — Réduire la latence par commande (PR 2 : tâches 2.1, 2.2, 2.4 ; PR 3 : 2.3, 2.5, 2.6 ; PR 4 : 2.7, 2.8, 2.9)

### Tâche 2.1 — Settle précoce pour click et press (supprimer le plancher 700 + 150 ms)

**Fichiers :** `daemon/src/interactive-actions.ts` (cas `click`, bloc primitives pour `press`), `daemon/src/wait-engine.ts`, `daemon/src/perception/realm-collector.ts` (installation d'un MutationObserver dans `__devBrowserPerceptionState`).

Conception :
- [ ] Installer une fois par realm, au premier `collectRealm`, un `MutationObserver` sur `document` (childList, attributes, characterData, subtree) qui incrémente `state.mutationEpoch` et note `state.lastMutationAt = performance.now()`. Exposer une fonction in-page `__devBrowserPerceptionState.signal()` qui renvoie `{ epoch, lastMutationAt, url: location.href, activeRef, dialogs: count, inFlightFetch }` en une seule évaluation.
- [ ] Nouvelle condition d'attente interne `settled` (non exposée dans la grammaire publique) : passe quand, sur deux polls consécutifs, `epoch` n'a pas bougé, aucune requête n'est en vol (`inFlight === 0` déjà suivi par le wait-engine), et au moins `minSettleMs = 50` ms se sont écoulées depuis le dispatch. Plafond `maxSettleMs = 700` ms si du réseau est en vol, `300` ms sinon.
- [ ] Le `monitoringWait` par défaut de `click` et `press` devient `{ conditions: [settled] }` à la place de `networkIdle 700/750`.
- [ ] Supprimer le `setTimeout(resolve, 150)` sur `WAIT_TIMEOUT` dans la boucle de click ; remplacer par une lecture immédiate du signal.
- [ ] Les `Promise.race([outerPopupArrived, setTimeout(PRESS_SETTLE_MS)])` ne s'appliquent que si un `--wait-*` explicite a été passé sans condition `popup` ; ramener ce délai à 250 ms.
- [ ] `compareSignals` reste utilisé pour `change` mais lit le signal léger (epoch, url, dialogs, focus, values des refs suivis) au lieu de deux `collectLiveSnapshot` complets ; `pageSignal` n'est appelé qu'une fois avant et une fois après.

**Tests :**
- `wait-engine.test.ts` : la condition `settled` passe après 2 polls calmes et ≥ 50 ms ; ne passe pas tant qu'une requête est en vol ; plafond respecté.
- `interactive-actions.test.ts` : `click` sur un bouton inerte de la fixture termine en < 400 ms ; `click` qui déclenche une navigation renvoie toujours `navigation`/`url` changé ; `click` qui ouvre une modale renvoie `delta.summary` contenant `dialog opened` ; `press Enter` sur un formulaire qui fait un `fetch` de 400 ms attend la réponse (mock via la fixture : ajouter une route `/slow` de 400 ms dans `agent-reliability-fixture.ts`).
- `retry-policy.test.ts` : inchangé (la politique de retry ne dépend pas du settle).

**Critères d'acceptation :** bench local `click --ref` ≤ 350 ms, `press` ≤ 350 ms ; `reliability-benchmark.test.ts` vert. Live : `click --ref` sur une ligne de conversation LinkedIn, mesuré par 0.2, à ≤ 45 % de la ligne de base, et le fil s'ouvre (vérifié par `assert --within main --text <nom>`).

### Tâche 2.2 — Une seule perception par action

**Fichiers :** `daemon/src/interactive-actions.ts` (`validateDecisionRefs`, `clickOnce`, `prepareClickInput`, `dispatchType`, bloc final `if (!result.coordinateSpace)`, bloc `--shot`), `daemon/src/ref-state.ts`, `daemon/src/perception/collector.ts`, `daemon/src/page-state.ts`.

- [ ] Revalidation ciblée : ajouter `revalidateRef(page, ref, expectedFingerprint)` qui fait **un** `evaluate` dans le realm du ref, lit l'élément via `byRef`, recalcule le fingerprint sémantique in-page (mêmes champs que `semanticFingerprint`, calculés par une fonction partagée sérialisée dans `realm-collector.ts`) et renvoie `{ attached, fingerprint }`. `validateDecisionRefs` utilise cela pour le ref cible ; la vérification de `fromState`/document reste basée sur `realmToken` (un `evaluate` léger) et non sur une collecte complète.
- [ ] Mémoïsation : `collectPageState` accepte `{ reuseIfEpoch: number }` ; si l'epoch in-page n'a pas changé depuis la dernière perception enregistrée pour cette page et le même scope, renvoyer l'état enregistré sans re-collecter (nouveau `stateId` tout de même, pointant sur le même snapshot). Le `stateId` reste monotone.
- [ ] Dans `click`/`type`/primitives : une perception `delta: true` après l'action ; supprimer les collectes intermédiaires (`clickOnce` puis `prepareClickInput` faisaient deux `validateDecisionRefs` complets).
- [ ] Bloc `--shot` : réutiliser la perception finale de l'action pour l'annotation au lieu de `visualPerception` (nouvelle collecte). Avec `--full-page`, une collecte `full` reste nécessaire mais une seule.
- [ ] Bloc final `if (!result.coordinateSpace)` : ne jamais déclencher une perception complète pour remplir `coordinateSpace` ; utiliser `coordinateSpaceOnly` quand aucune perception n'a eu lieu.

**Tests :** `scoped-action-revalidation.test.ts` et `ref-state.test.ts` : un ref dont le nom a changé est toujours refusé (`STALE_REF`) ; un ref d'un scope `--within` reste valide ; compter les appels à `collectRealm` via un espion (`vi.spyOn` sur le module) : un `click` fait au plus 1 collecte complète, un `click --shot` au plus 1, un `type` au plus 1.

**Critères d'acceptation :** bench : messages CDP `click --ref` ≤ 60 sur la page synthétique ; `type --ref` ≤ 450 ms ; `click --ref --shot` ≤ 700 ms.

### Tâche 2.3 — `resolveActionTarget` fusionné

**Fichiers :** `daemon/src/actionability.ts`.

- [ ] Remplacer la séquence de ~20 appels par au plus 3 évaluations in-page : (1) `resolveAndInspect` : trouve l'élément via `byRef`, calcule `explicitlyHidden`, `role/tag`, le descendant ou l'ancêtre interactif de repli, l'applicabilité (`validateApplicability` portée in-page), `actualRef`, `shadowContext`, la box, et pose l'attribut jeton ; (2) `scrollAndStabilize` : `scrollIntoView` si demandé, puis stabilité par deux `requestAnimationFrame` consécutifs avec la tolérance de jitter existante (1 px) et le plafond de dérive (5 px) mais un budget maximal de 120 ms au lieu de 200 à 500 ms ; (3) `hitTest` : `elementFromPoint` au centre, obstruction, box finale et sameElement (comparer l'identité in-page avec le jeton).
- [ ] Conserver `locator`, `cleanup`, `box`, `quad`, `resolvedBy`, `actual`, `scroll`, `frameId`, `framePath`, `shadowContext` dans le résultat pour ne pas toucher aux appelants.
- [ ] Les frames : `frameAncestorsVisible` est appelé une fois, pas deux.

**Tests :** `actionability.test.ts` existant doit rester vert sans changement d'assertions (hidden, disabled, obscured, ancestor/descendant fallback, stability). Ajouter : nombre de messages CDP pour un `resolveActionTarget` ≤ 25 (compter via `page.context().newCDPSession` n'est pas possible ; utiliser un compteur sur `locator.evaluate`/`page.evaluate` espionnés) ; cible qui bouge réellement (animation de translation de 200 px) toujours refusée.

**Critères d'acceptation :** bench `raw: resolveActionTarget` ≤ 50 ms local ; live : `click --ref` sur LinkedIn (micro-animations permanentes) réussit, comme documenté dans le field report du 2026-07-18.

### Tâche 2.4 — Snapshot live sans troncature aveugle ; `--wait-text` fiable

**Fichiers :** `daemon/src/live-snapshot.ts`, `daemon/src/wait-engine.ts`, `daemon/src/perception/realm-collector.ts`.

- [ ] Texte du corps : `bodyText` est lu via `document.body.innerText` (rapide, calculé par Blink) normalisé, borné à `MAX_TEXT_CHARS = 200_000` ; `dialogs`/`toasts` via `querySelectorAll('[role=dialog],dialog[open],[role=status],[role=alert],...')` puis `innerText` borné à 10 000 caractères chacun ; ces lectures ne sont plus soumises à `MAX_WORK`.
- [ ] `truncated` n'est plus global : `refsTruncated` (couverture des refs), `textTruncated` (texte tronqué en caractères). Une condition `text` passe si le texte est trouvé, même si `refsTruncated` ; elle échoue "non prouvé" seulement si `textTruncated` et non trouvé.
- [ ] Les refs suivis par une condition `ref` sont lus **directement** via `byRef` (pas de parcours) ; le parcours complet borné (`MAX_WORK`) ne sert plus qu'à `frameSignals.dom` pour `compareSignals`, remplacé par l'epoch du MutationObserver de 2.1.
- [ ] `POLL_INTERVAL_MS` passe à 50 ms, et chaque poll n'évalue que ce que les conditions demandent (texte seulement pour `text`, refs seulement pour `ref`, rien pour `url`/`navigation`/`response`).
- [ ] Optionnel : `page.exposeBinding('__devBrowserWake', ...)` appelé par le MutationObserver (debounce 16 ms) pour réveiller le poll sans attendre 50 ms.

**Tests :** `wait-engine.test.ts` et `wait-engine-regressions.test.ts` : page de 5 000 éléments, `--wait-text "visible,body,contains,<texte au fond de la page>"` passe en < 300 ms ; `--wait-dialog opened` passe quand une modale s'ouvre sur une page de 5 000 éléments ; `--wait-ref R5000,visible` fonctionne sur un ref au-delà de 1 000 éléments ; texte absent renvoie `WAIT_TIMEOUT` avec `coverage: "complete"`.

**Critères d'acceptation :** live LinkedIn messagerie : `click --ref <ligne> --wait-text "visible,body,contains,<nom du contact>"` réussit en < 1,5 s ; `click --ref <bouton "..."> --wait-dialog opened` (menu d'options d'une conversation) réussit puis `press Escape`.

### Tâche 2.5 — Géométrie des frames en une passe

**Fichiers :** `daemon/src/perception/collector.ts` (`deterministicFrames`, boucle sur `frames`), `daemon/src/frame-geometry.ts`, `daemon/src/live-snapshot.ts` (`liveFrames`).

- [ ] Dans le document parent, un seul `evaluate` liste les `iframe,frame` (ordre DOM, bornes existantes) et renvoie pour chacun : rect, `clientLeft/Top`, matrice de transform, visibilité héritée (même logique que `frameAncestorsVisible` mais calculée in-page pour tous), obstruction au centre. Associer à `frame.childFrames()` par `frameElement()` uniquement pour les frames retenus (visibles, non 0×0).
- [ ] Ignorer par défaut les frames invisibles, 0×0, ou hors viewport de plus de 2 écrans (publicités, trackers) ; les lister dans `warnings` seulement sous `--verbose`.
- [ ] `frameToTopMatrix` et `frameAncestorsVisible` deviennent des lectures du cache calculé par ce passage (invalidé par l'epoch du parent).
- [ ] `targetObscuredAcrossFrames` n'est appelé que pour les éléments d'un frame qui sont `inViewport`, et par lot (une évaluation par frame avec la liste des points).

**Tests :** `frame-shadow.test.ts`, `frame-wait.test.ts`, `frame-shadow-actions.test.ts` verts ; ajouter un test qui compte les `frameElement()` par collecte (espion) : ≤ 1 par frame retenu ; frames masqués non collectés.

**Critères d'acceptation :** bench fixture (3 iframes) : `observe` ≤ 80 messages CDP, `click --ref` ≤ 150.

### Tâche 2.6 — Screenshots moins chers

**Fichiers :** `daemon/src/visual-artifacts.ts`, `daemon/src/interactive-actions.ts` (bloc `--shot`), `cli/src/main.rs` (`--shot-format`, `--shot-scale`).

- [ ] Annotation via un overlay DOM injecté avant capture (un `<div>` par label avec `pointer-events:none`, retiré dans `finally`) au lieu de `decodePng` / réencodage. Conserver le chemin actuel derrière `--annotate-mode raster` pour compatibilité.
- [ ] Format `jpeg` qualité 80 par défaut pour les captures d'action (`--shot` sur click/type/...), `png` conservé pour `shot` explicite et `--shot-format png`. Mettre à jour `mediaType` dans `ScreenshotArtifact`.
- [ ] `--shot-scale css` (défaut) capture à `deviceScaleFactor: 1` via `Page.captureScreenshot` `clip.scale = 1 / DPR`, ce qui aligne les pixels de l'image sur les CSS px (supprime la confusion DPR 1,25 notée dans le field report) et réduit la taille du fichier.
- [ ] Réutiliser la perception de l'action (2.2) pour les labels.

**Tests :** `visual-artifacts.test.ts` : overlay retiré même en cas d'échec de capture ; image JPEG valide ; dimensions = viewport CSS quand `scale css` sur une page DPR 2 (`page.setViewportSize` + `deviceScaleFactor` via un contexte de test) ; `annotate-mode raster` inchangé.

**Critères d'acceptation :** bench : `click --ref --shot` ≤ latence de `click --ref` + 150 ms ; taille de fichier d'une capture LinkedIn ≤ 40 % de la version PNG.

### Tâche 2.7 — Verrou par page

**Fichiers :** `daemon/src/daemon.ts`, `daemon/src/lock.ts`, `daemon/src/browser-manager.ts`.

- [ ] `handleInteractive` et `handleVideo` prennent un verrou `browser:page` ; `prepareBrowser` (connexion/lancement) prend le verrou `browser` uniquement pendant la (re)connexion, puis le libère.
- [ ] `handleExecute` (scripts) garde le verrou `browser` (un script peut toucher plusieurs pages) mais n'attend pas les commandes interactives d'autres pages si un flag `--page` est fourni au script... (hors périmètre ; garder le verrou browser pour les scripts).
- [ ] `getPage` par target id ne doit pas faire de `listPageTargets` sous verrou global si la page est déjà enregistrée.

**Tests :** `lock.test.ts` : deux `interactive` sur deux pages du même browser s'exécutent en parallèle (mesurer que la durée totale ≈ max, pas somme, avec une action qui attend 300 ms) ; deux actions sur la même page restent sérialisées ; une reconnexion bloque tout.

**Critères d'acceptation :** bench live : deux `observe` lancés en parallèle (PowerShell `Start-Job` ou deux processus Node) sur deux onglets LinkedIn terminent en ≤ 1,3 × la durée d'un seul.

### Tâche 2.8 — Pool de sandboxes chaudes (optionnel, après 2.1 à 2.4)

**Fichiers :** `daemon/src/sandbox/script-runner-quickjs.ts`, `daemon/src/sandbox/quickjs-sandbox.ts`.

- [ ] Garder par browser une sandbox pré-initialisée (runtime + bundle client + `initializePlaywright`) prête à exécuter le prochain script ; après chaque script, la sandbox utilisée est détruite et une nouvelle est préparée en arrière-plan. Aucun état ne fuit d'un script à l'autre (le script s'exécute toujours dans une sandbox neuve, seulement préchauffée).
- [ ] Invalidation du pool à la fermeture/reconnexion du browser.

**Tests :** `sandbox-security.test.ts` vert (isolation) ; nouveau test : deux scripts consécutifs ne partagent aucune variable globale ; le second script démarre en < 40 ms hors exécution.

**Critères d'acceptation :** bench `script: trivial (2nd run)` ≤ 60 ms.

### Tâche 2.9 — Resserrer le benchmark de fiabilité

**Fichiers :** `daemon/src/reliability-benchmark.test.ts`.

- [ ] `Math.max(...latencies) < 10_000` devient `< 2_000` et la médiane du couple find+click `< 600` ms ; `JSON.stringify(observed).length < 100_000` devient `< 12_000` ; `actionLatencyMs < 10_000` devient `< 1_000`.

---

## 8. Phase 3 — Réduire le nombre d'appels par tâche (PR 5)

### Tâche 3.1 — Cible sémantique directement sur les actions

**Fichiers :** `daemon/src/protocol.ts`, `daemon/src/interactive-actions.ts`, `daemon/src/targeting.ts`, `cli/src/main.rs`, `cli/src/discovery.rs`.

- [ ] `click`, `type`, `focus`, `press`, `hover`, `check`, `uncheck`, `select`, `scroll --ref` acceptent, à la place de `--ref`, le groupe `--role`, `--name`, `--name-mode`, `--within`, `--near`, `--frame`, `--state` (même grammaire que `find`). Le daemon exécute `findTargets` avec `limit: 5` ; si `ambiguity.ambiguous` ou zéro match, il renvoie `AMBIGUOUS_TARGET` / `TARGET_MISSING` avec les candidats compacts (1.4) et n'agit pas ; sinon il agit sur le match unique et renvoie `resolvedBy: "find"` avec le ref utilisé.
- [ ] `--from-state` reste supporté ; sans lui, la cible est résolue sur une perception fraîche (c'est l'intérêt : un seul appel).
- [ ] `--require-ancestor-text`, `--confirm-token` et `--expect-text` restent utilisables avec la forme sémantique.

**Tests :** `interactive-actions.test.ts` : `click --role button --name Connect --within main` clique le bon bouton de la fixture et jamais le leurre de `aside` ; ambigu sans `--within` renvoie `AMBIGUOUS_TARGET` avec candidats et `decoy` non cliqué (compteurs de la fixture) ; `type --role textbox --name Note` fonctionne.

**Critères d'acceptation :** scénario live S3 réalisable en ≤ 4 appels.

### Tâche 3.2 — Commande `batch`

**Fichiers :** `daemon/src/protocol.ts` (`BatchRequest`), `daemon/src/daemon.ts` (`handleBatch`), `cli/src/main.rs` (`Batch` : lit un JSON sur stdin ou `--file`), `cli/src/discovery.rs`, `skills/dev-browser/references/interactive-loop.md`.

- [ ] Entrée : `{ "page": "...", "steps": [ { "kind": "click", ... }, { "kind": "type", ... }, { "kind": "assert", ... } ], "stopOnError": true, "observeAfter": "delta" | "tree" | "none" }`. Chaque étape est une action du protocole v2 existant (même schéma zod, réutilisé via `z.array(ActionSchema)`), max 20 étapes.
- [ ] Exécution séquentielle sous le verrou de page ; les leases, tokens de confirmation et guards s'appliquent étape par étape exactement comme en appels séparés (aucune étape ne peut contourner `--confirm-token`). Résultat : `steps: [{ index, kind, ok, ms, result | error }]` compact, puis l'état final selon `observeAfter`.
- [ ] Une étape `wait` autonome (`{ "kind": "wait", "wait": {...} }`) est ajoutée pour attendre entre deux actions.
- [ ] Code de sortie : celui de la première étape en erreur ; les étapes suivantes ne sont pas exécutées si `stopOnError`.

**Tests :** `protocol.test.ts` : schéma batch, refus de > 20 étapes ; `daemon` tests : `batch` de find + click + assert sur la fixture ; une étape `click --confirm-token` invalide arrête le batch avec `CONFIRMATION_INVALID` et l'étape suivante n'a pas tourné (compteur fixture).

**Critères d'acceptation :** live : batch `[navigate /messaging/, find ligne, click ligne, assert nom, text --within main]` en un appel.

### Tâche 3.3 — Raccourcis

- [ ] `type --press KEY` (touche envoyée après la saisie, même dispatch journalisé) ; `type` multi-champs `--fill REF=TEXTE` répétable.
- [ ] `navigate URL --observe [SCOPE]` renvoie l'arbre scopé après chargement.
- [ ] `click ... --then-text SCOPE` renvoie `textContent` du scope après le settle (remplace un appel `text`).

**Tests :** parsing CLI ; daemon : `type --press Enter` soumet le formulaire de la fixture ; `--then-text main` présent dans la réponse.

### Tâche 3.4 — Erreurs qui évitent un tour

- [ ] `STALE_REF`, `STALE_STATE`, `TARGET_MISSING`, `AMBIGUOUS_TARGET` renvoient dans `error.details` : `latest` (stateId, url, title), et `candidates` (≤ 5 éléments compacts les plus proches sémantiquement du ref/nom demandé, via `findTargets` sur le nom du ref d'origine quand il est connu). `nextCommands` propose la commande sémantique 3.1 correspondante.

**Tests :** `ref-state.test.ts` : un ref devenu obsolète après re-rendu renvoie un candidat avec le même nom et un nouveau ref.

---

## 9. Phase 4 — Guidance de l'agent (PR 6)

- [ ] `skills/dev-browser/SKILL.md` : ajouter en tête de la section boucle une sous-section **Fast path** : (1) `find`/`click` sémantique sans screenshot pour tout ce qui n'est pas irréversible ; (2) `--shot` seulement avant une action irréversible ou quand la mise en page compte ; (3) `text --within` pour lire, `observe` pour choisir une cible, jamais `observe` pour lire ; (4) `batch` pour toute séquence prévisible ; (5) scripts pour l'extraction de masse. Garder le flux long pour les actions irréversibles.
- [ ] `cli/llm-guide.txt` : réduire à ≤ 8 KB ; déplacer le détail dans `examples COMMAND`. `--help` doit tenir en ≤ 10 KB.
- [ ] `dev-browser capabilities --compact` cité en premier partout, avec la ligne « lisez `schema --json` seulement si une commande échoue pour raison de grammaire ».
- [ ] `README.md` section Benchmarks : ajouter le tableau avant/après produit par les evals (section 10), avec la commande pour le reproduire.
- [ ] `CHANGELOG.md`.

---

## 10. Evals

### E1 — Micro-bench local (bloquant pour chaque PR)

Commande : phase 0.1. Comparer à `docs/perf/baseline.md`. Seuils bloquants : ceux de la section 2 pour les métriques "local". Consigner le tableau "après" de chaque PR dans `docs/perf/<date>-pr<N>.md`.

### E2 — Suite de scénarios live sur le Chrome 9223 (bloquant pour PR 2, 3, 5 ; informatif pour les autres)

Chaque scénario est exécuté 5 fois, après la ligne de base et après chaque PR concernée, avec `scripts/bench-cli.mjs` ou à la main en notant : appels CLI, latence médiane par appel, octets par réponse, succès (l'état attendu est atteint, vérifié par `assert`), zéro effet de bord (rien d'envoyé, rien de publié, champs vides à la fin).

| Scénario | Étapes autorisées | Attendu après le plan |
|---|---|---|
| S1 Découverte | `pages` ; choisir l'onglet LinkedIn par URL | 1 appel, < 100 ms |
| S2 Fil d'actualité | `navigate /feed/` ; `observe --within main` ; `text --within main` | 3 appels ; `observe` ≤ 10 KB ; aucun appel > 600 ms |
| S3 Messagerie, brouillon effacé | `navigate /messaging/` ; `click --role listitem` ou `--name <contact autorisé>` `--within main --wait-text <nom>` ; `text --within main` ; `type --role textbox --within main --text "test dev-browser (brouillon)"` ; `press ControlOrMeta+A` ; `press Backspace` ; `assert` champ vide | ≤ 4 appels avec `batch` ou cibles sémantiques ; `click` ≤ 45 % de la ligne de base ; `--wait-text` réussit ; compositeur vide à la fin |
| S4 Menu d'options | sur `/messaging/` : `click --role button --name-mode contains --name "..."` du fil ouvert `--wait-dialog opened` ; `observe --within dialog` ; `press Escape` ; `assert` menu fermé | `--wait-dialog` réussit < 1,5 s ; 3 appels |
| S5 Recherche | `click --role combobox` ou champ de recherche ; `type --text "dev-browser" --press Enter --wait-url "contains,/search/"` ; `observe --within main` ; retour `/feed/` | 3 appels ; `--wait-url` réussit |
| S6 Profil, lecture seule | `navigate /in/<profil public>` ; `find --role button --name-mode contains --name "Se connecter"` ou "Connect" (sans cliquer) ; `text --within main` | `find` ≤ 2 KB ; aucun clic |
| S7 Liste virtualisée | `/messaging/` : `find --scroll-container <ref liste> --name <contact bas de liste> --max-steps 8` | `scrollMetrics.uniqueItems ≥ 20` ; ≤ 60 % de la latence de base |
| S8 Autre application ouverte (au choix du propriétaire) | `navigate` ; `observe --within main` ; `find` ; `click` sur un lien de navigation interne ; retour | Mêmes seuils que S2 ; aucune modification de données |
| S9 Parallélisme | deux `observe` simultanés sur deux onglets LinkedIn | durée totale ≤ 1,3 × un seul (après 2.7) |
| S10 Sécurité (non-régression) | `find --role button --name Envoyer --state disabled` avec compositeur vide ; `click --ref <ce bouton>` doit renvoyer `TARGET_DISABLED` ou `TARGET_MISSING` ; `confirm --ref <bouton Se connecter> --expect "<nom>"` émet un token **qui n'est jamais consommé** | erreurs typées, exit 3, aucune action |

Rapport : `docs/field-reports/<date>-speed-<phase>.md` avec le tableau et les anomalies.

### E3 — Eval au niveau agent (bloquant pour la clôture du plan)

Objectif : mesurer ce que voit l'utilisateur, avec un vrai agent.

- [ ] Préparer 4 tâches en langage naturel, chacune non destructive : (T1) « Ouvre ma messagerie LinkedIn et dis-moi le nom des 5 dernières conversations » ; (T2) « Ouvre la conversation avec <contact autorisé> et résume ses 3 derniers messages » ; (T3) « Cherche "dev-browser" dans LinkedIn et liste les 3 premiers résultats » ; (T4) « Sur <autre application>, va sur la page X et extrais Y ».
- [ ] Exécuter chaque tâche avec un agent Claude Code équipé du skill `skills/dev-browser` (via `dev-browser install-skill`), sur la version de base puis sur la version finale, 3 fois chacune. Instrumenter avec le hook `PostToolUse` de Claude Code (ou en lisant le transcript JSONL de la session dans `~/.claude/projects/`) pour compter : nombre d'appels `dev-browser`, octets de sortie totaux, temps mur de la tâche, succès (réponse correcte vérifiée à la main).
- [ ] Critères : médiane des appels ÷ 1,8 ou mieux ; octets de sortie ÷ 8 ou mieux ; temps mur ÷ 2 ou mieux ; succès ≥ égal à la base ; aucune action interdite dans les transcripts (grep des noms de boutons interdits dans les commandes `click`).
- [ ] Consigner dans `docs/perf/agent-eval.md` : tâches, modèle, tableaux, écarts.

### E4 — Non-régression (bloquant pour chaque PR)

- `cd daemon && pnpm vitest run` : tout vert, y compris `sandbox-security.test.ts`, `confirmation-tokens.test.ts`, `execute-policy.test.ts`, `sessions.test.ts`, `redaction.test.ts`, `reliability-benchmark.test.ts`.
- `cd daemon && npx tsc --noEmit`, `cd cli && cargo test && cargo build`.
- `dev-browser schema --json` valide et cohérent avec les tests de `discovery.rs`.
- Le format des erreurs (`ok: false`, `error.code`, `error.recoverable`, exit status) inchangé ; `protocolVersion: 1` inchangé (couvert par `protocol.test.ts`).

---

## 11. Découpage en PR, ordre, définition de « terminé »

| PR | Contenu | Bloquants |
|---|---|---|
| PR 1 | Phase 0 complète + Phase 1 (1.1 à 1.6) | E1 tailles ; E4 ; `docs/perf/baseline.md` et `docs/perf/<date>-pr1.md` |
| PR 2 | 2.1, 2.2, 2.4 | E1 latences click/type et CDP ; E2 S3, S4, S10 ; E4 |
| PR 3 | 2.3, 2.5, 2.6 | E1 CDP fixture, shot ; E2 S2, S7 ; E4 |
| PR 4 | 2.7, 2.8, 2.9 | E2 S9 ; E4 |
| PR 5 | 3.1 à 3.4 | E2 S3 ≤ 4 appels, S5 ; E4 |
| PR 6 | Phase 4 + E3 | E3 ; README benchmarks à jour |

Chaque PR : description avec le tableau avant/après, la liste des flags ajoutés, le lien vers le field report live. Commits conventionnels (`perf(daemon): ...`, `feat(cli): ...`, `docs(perf): ...`).

« Terminé » = les six PR fusionnées, toutes les cibles de la section 2 atteintes et consignées, E3 satisfait, `CHANGELOG.md` à jour, et un dernier field report live sans anomalie ni effet de bord.

---

## Annexe A — Bench in-process (`daemon/src/perf/bench-actions.test.ts`)

```ts
// BENCH=1 BENCH_OUT=../docs/perf/local.md pnpm vitest run src/perf/bench-actions.test.ts
// Pour compter les messages CDP : DEBUG=pw:protocol ... 2> cdp.log ; node ../scripts/count-cdp.mjs cdp.log
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { it } from "vitest";

import { BrowserManager } from "../browser-manager.js";
import { executeInteractiveAction } from "../interactive-actions.js";
import { collectPageState } from "../perception/collector.js";
import { collectLiveSnapshot } from "../live-snapshot.js";
import { resolveActionTarget } from "../actionability.js";
import { runScript } from "../sandbox/script-runner-quickjs.js";
import { startAgentReliabilityFixture } from "../test-fixtures/agent-reliability-fixture.js";
import { heavyPage } from "./heavy-page.js";

const browser = "bench";
const pageName = "fixture";
const rows: Array<{ step: string; ms: number; pretty: number; compact: number; tokens: number }> = [];

function mark(label: string) {
  process.stderr.write(`\n@@MARK ${label}\n`);
}

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
  mark(`${step} START`);
  const started = performance.now();
  let out: T | undefined;
  let failed = "";
  try {
    out = await fn();
  } catch (error) {
    failed = ` FAILED: ${(error as { code?: string }).code ?? (error as Error).message}`;
  }
  const ms = performance.now() - started;
  mark(`${step} END`);
  const pretty = out === undefined ? "" : JSON.stringify(out, null, 2);
  const compact = out === undefined ? "" : JSON.stringify(out);
  rows.push({ step: step + failed, ms: Math.round(ms), pretty: pretty.length, compact: compact.length, tokens: Math.round(pretty.length / 4) });
  const lines = [
    "| step | ms | pretty bytes | compact bytes | ~tokens |",
    "|---|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.step} | ${r.ms} | ${r.pretty} | ${r.compact} | ${r.tokens} |`),
  ];
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, lines.join("\n") + "\n");
  return out;
}

it.skipIf(!process.env.BENCH)("bench interactive actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-browser-bench-"));
  const executablePath = process.env.CHROME_EXE;
  const manager = new BrowserManager(path.join(root, "browsers"), executablePath
    ? { launchPersistentContext: ((dir: string, options: Record<string, unknown>) =>
        chromium.launchPersistentContext(dir, { ...options, executablePath })) as typeof chromium.launchPersistentContext }
    : {});
  await manager.ensureBrowser(browser, { headless: true });
  const fixture = await startAgentReliabilityFixture();
  const page = await manager.getPage(browser, pageName);
  await page.goto(fixture.mainUrl, { waitUntil: "domcontentloaded" });
  const req = (id: string, action: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ id, type: "interactive", protocolVersion: 2, browser, page: pageName, timeoutMs: 10_000, action, ...extra }) as never;
  const observeAction = { kind: "observe", full: false, delta: false, track: "default", maxNodes: 100, maxChars: 12_000, depth: 12, breadth: 50 };

  // Fixture (petite page avec iframes)
  await timed("fixture: observe", () => executeInteractiveAction(manager, req("o1", observeAction)));
  const found = (await timed("fixture: find button Connect within main", () =>
    executeInteractiveAction(manager, req("f1", { kind: "find", role: "button", name: "Connect", nameMode: "exact", within: "main", scope: "document", states: [], limit: 5 })))) as { matches: Array<{ ref: string }>; stateId: string };
  await timed("fixture: click --ref", () => executeInteractiveAction(manager, req("c1", { kind: "click", ref: found.matches[0]!.ref, fromState: found.stateId, method: "mouse", retry: "never" })));
  await timed("fixture: click --ref --shot", () => executeInteractiveAction(manager, req("c2", { kind: "click", ref: found.matches[0]!.ref, method: "mouse", retry: "never" }, { shot: "bench-click.png", shotTimeoutMs: 8_000 })));
  const note = (await executeInteractiveAction(manager, req("f2", { kind: "find", role: "textbox", scope: "document", states: [], limit: 5 }))) as { matches: Array<{ ref: string }> };
  if (note.matches[0]) await timed("fixture: type --ref", () => executeInteractiveAction(manager, req("t1", { kind: "type", ref: note.matches[0]!.ref, text: "hello world!", clear: true })));
  await timed("fixture: shot", () => executeInteractiveAction(manager, req("s1", { kind: "shot" }, { shot: "bench-shot.png", shotTimeoutMs: 8_000 })));
  await timed("fixture: navigate", () => executeInteractiveAction(manager, req("n1", { kind: "navigate", url: fixture.mainUrl })));
  await timed("fixture: pages", () => executeInteractiveAction(manager, req("p1", { kind: "pages" })));
  await timed("raw: collectPageState", () => collectPageState(page, {}));
  await timed("raw: collectLiveSnapshot", () => collectLiveSnapshot(page));
  const f3 = (await executeInteractiveAction(manager, req("f3", { kind: "find", role: "button", name: "Connect", nameMode: "exact", within: "main", scope: "document", states: [], limit: 5 }))) as { matches: Array<{ ref: string }> };
  await timed("raw: resolveActionTarget", async () => {
    const resolved = await resolveActionTarget(page, f3.matches[0]!.ref, { timeoutMs: 10_000, scroll: true, hitTest: true, applicability: "pointer", pageName });
    await resolved.cleanup();
  });
  const script = `const p = await browser.getPage("${pageName}"); console.log(await p.title());`;
  await timed("script: trivial (cold)", () => runScript(script, manager, browser, { onStdout: () => {}, onStderr: () => {} }, { timeout: 30_000 }));
  await timed("script: trivial (warm)", () => runScript(script, manager, browser, { onStdout: () => {}, onStderr: () => {} }, { timeout: 30_000 }));

  // Page synthétique lourde (~1 000 éléments, sans iframe, animation permanente)
  await page.setContent(heavyPage());
  await timed("heavy: observe", () => executeInteractiveAction(manager, req("ho1", observeAction)));
  await timed("heavy: observe --within main --max-nodes 300", () => executeInteractiveAction(manager, req("ho2", { ...observeAction, maxNodes: 300, within: "main" })));
  await timed("heavy: observe --delta", () => executeInteractiveAction(manager, req("ho3", { ...observeAction, delta: true })));
  const hf = (await timed("heavy: find 'More actions 77'", () =>
    executeInteractiveAction(manager, req("hf1", { kind: "find", role: "button", name: "More actions 77", nameMode: "exact", within: "main", scope: "document", states: [], limit: 5 })))) as { matches: Array<{ ref: string }>; stateId: string };
  await timed("heavy: click --ref", () => executeInteractiveAction(manager, req("hc1", { kind: "click", ref: hf.matches[0]!.ref, fromState: hf.stateId, method: "mouse", retry: "never" })));
  await timed("heavy: click --ref --wait-text", () => executeInteractiveAction(manager, req("hc2", { kind: "click", ref: hf.matches[0]!.ref, method: "mouse", retry: "never", wait: { mode: "all", timeoutMs: 3_000, conditions: [{ kind: "text", state: "visible", scope: "body", match: "contains", value: "People you may know" }] } })));
  const ht = (await executeInteractiveAction(manager, req("hf2", { kind: "find", role: "textbox", name: "Note", nameMode: "contains", scope: "document", states: [], limit: 5 }))) as { matches: Array<{ ref: string }> };
  await timed("heavy: type --ref 40 chars", () => executeInteractiveAction(manager, req("ht1", { kind: "type", ref: ht.matches[0]!.ref, text: "Bonjour, ravi de vous rencontrer hier !", clear: true })));
  await timed("heavy: raw collectPageState", () => collectPageState(page, {}));
  await timed("heavy: raw collectLiveSnapshot", () => collectLiveSnapshot(page));
  await timed("heavy: text --within main", () => executeInteractiveAction(manager, req("hx1", { kind: "text", within: "main" })));
  await timed("heavy: assert --within main", () => executeInteractiveAction(manager, req("ha1", { kind: "assert", within: "main", text: "People you may know", match: "contains" })));
  await timed("heavy: scroll down", () => executeInteractiveAction(manager, req("hs1", { kind: "scroll", direction: "down", pages: 1 })));
  await timed("heavy: press Tab", () => executeInteractiveAction(manager, req("hp1", { kind: "press", ref: hf.matches[0]!.ref, key: "Tab" })));

  await fixture.close();
  await manager.stopAll();
  await rm(root, { recursive: true, force: true });
}, 600_000);
```

`daemon/src/perf/heavy-page.ts` :

```ts
export function heavyPage(): string {
  const cards = Array.from({ length: 150 }, (_, i) => `
    <li class="card" data-testid="card-${i}">
      <img alt="avatar ${i}" src="data:," width="40" height="40">
      <div><h3>Person ${i}</h3><p>Title ${i} at Company ${i} · 2nd</p><span>Mutual ${i}</span></div>
      <button type="button">Connect</button>
      <button type="button" aria-label="More actions ${i}">…</button>
      <a href="/in/person-${i}">View profile</a>
    </li>`).join("");
  const nav = Array.from({ length: 30 }, (_, i) => `<a href="/nav/${i}">Nav ${i}</a>`).join("");
  const aside = Array.from({ length: 25 }, (_, i) => `<div class="s"><span>Suggested ${i}</span><button>Connect</button></div>`).join("");
  return `<!doctype html><html><head><title>Heavy page</title>
  <style>.card{display:flex;gap:8px;padding:8px;border-bottom:1px solid #eee} ul{list-style:none;padding:0} body{font-family:sans-serif} .sp{animation:spin 1s linear infinite} @keyframes spin{to{transform:rotate(360deg)}}</style>
  </head><body>
  <header><nav aria-label="Primary">${nav}<input type="search" placeholder="Search" aria-label="Search"></nav></header>
  <main><h1>People you may know</h1><div class="sp">⟳</div><ul id="list">${cards}</ul>
    <form><label>Note <textarea id="note" name="note"></textarea></label><button type="submit" disabled>Send</button></form>
  </main>
  <aside aria-label="Suggestions">${aside}</aside>
  <footer><a href="/about">About</a><a href="/privacy">Privacy</a></footer>
  </body></html>`;
}
```

`scripts/count-cdp.mjs` :

```js
// node scripts/count-cdp.mjs cdp.log  — compte les messages CDP envoyés entre les marqueurs @@MARK du bench
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n");
let current = null;
const counts = new Map();
const methods = new Map();
for (const line of lines) {
  const mark = /@@MARK (.*) (START|END)$/.exec(line.trim());
  if (mark) {
    current = mark[2] === "START" ? mark[1] : null;
    if (current && !counts.has(current)) { counts.set(current, 0); methods.set(current, new Map()); }
    continue;
  }
  if (current && line.includes("SEND ►")) {
    counts.set(current, counts.get(current) + 1);
    const method = /"method":"([A-Za-z.]+)"/.exec(line)?.[1];
    if (method) methods.get(current).set(method, (methods.get(current).get(method) ?? 0) + 1);
  }
}
console.log("| step | CDP messages | top methods |\n|---|---:|---|");
for (const [step, count] of counts) {
  const top = [...methods.get(step)].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, c]) => `${m}×${c}`).join(", ");
  console.log(`| ${step} | ${count} | ${top} |`);
}
```

## Annexe B — Bench CLI live (`scripts/bench-cli.mjs`)

```js
// node scripts/bench-cli.mjs [--runs 5]
// Variables : DEV_BROWSER_BIN (défaut "dev-browser"), CONNECT (défaut http://127.0.0.1:9223),
//             PAGE (target id ou nom), URL_FILTER (sous-chaîne d'URL pour choisir l'onglet via `pages`),
//             FIND_NAME (nom d'un contact/ligne à chercher, --name-mode contains)
import { spawnSync } from "node:child_process";

const bin = process.env.DEV_BROWSER_BIN ?? "dev-browser";
const connect = process.env.CONNECT ?? "http://127.0.0.1:9223";
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] || 5);

function run(args) {
  const started = performance.now();
  const result = spawnSync(bin, ["--connect", connect, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
  return { ms: performance.now() - started, bytes: Buffer.byteLength(result.stdout ?? ""), code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

let page = process.env.PAGE;
if (!page) {
  const pages = JSON.parse(run(["pages"]).stdout);
  const list = pages.pages ?? pages;
  const target = list.find((tab) => tab.url.includes(process.env.URL_FILTER ?? "linkedin.com"));
  if (!target) throw new Error("No tab matches URL_FILTER; open one or set PAGE");
  page = target.id;
}
const findName = process.env.FIND_NAME ?? "";
const commands = [
  ["pages"],
  ["observe", "--page", page],
  ["observe", "--page", page, "--within", "main"],
  ["text", "--page", page, "--within", "main"],
  ["shot", "--page", page],
  ["scroll", "--page", page, "--direction", "down", "--pages", "1"],
  ...(findName ? [["find", "--page", page, "--name", findName, "--name-mode", "contains", "--within", "main"]] : []),
];
const rows = [];
for (const args of commands) {
  const samples = Array.from({ length: runs }, () => run(args));
  rows.push({ cmd: args.join(" "), ms: median(samples.map((s) => s.ms)), max: Math.max(...samples.map((s) => s.ms)), bytes: median(samples.map((s) => s.bytes)), fails: samples.filter((s) => s.code !== 0).length });
}
// Clic non destructif : la ligne trouvée par find (une conversation), puis Escape pour refermer un éventuel menu
if (findName) {
  const found = JSON.parse(run(["find", "--page", page, "--name", findName, "--name-mode", "contains", "--within", "main"]).stdout);
  const ref = found.matches?.[0]?.ref;
  if (ref) {
    const samples = Array.from({ length: runs }, () => run(["click", "--page", page, "--ref", ref]));
    rows.push({ cmd: `click --ref ${ref}`, ms: median(samples.map((s) => s.ms)), max: Math.max(...samples.map((s) => s.ms)), bytes: median(samples.map((s) => s.bytes)), fails: samples.filter((s) => s.code !== 0).length });
    run(["press", "--page", page, "--ref", ref, "--key", "Escape"]);
  }
}
console.log(`| command | median ms | max ms | median bytes | failures/${runs} |\n|---|---:|---:|---:|---:|`);
for (const r of rows) console.log(`| ${r.cmd} | ${Math.round(r.ms)} | ${Math.round(r.max)} | ${r.bytes} | ${r.fails} |`);
```

## Annexe C — Commandes exactes des scénarios live (après phase 3 ; avant, remplacer les cibles sémantiques par `find` puis `--ref`)

```
# S1
dev-browser --connect http://127.0.0.1:9223 pages
# S3 (TARGET = id de l'onglet LinkedIn ; CONTACT = contact autorisé par le propriétaire)
dev-browser --connect http://127.0.0.1:9223 navigate --page TARGET https://www.linkedin.com/messaging/
dev-browser --connect http://127.0.0.1:9223 click --page TARGET --name "CONTACT" --name-mode contains --within main --wait-text "visible,body,contains,CONTACT" --then-text main
dev-browser --connect http://127.0.0.1:9223 type --page TARGET --role textbox --within main --text "test dev-browser (brouillon)"
dev-browser --connect http://127.0.0.1:9223 batch --page TARGET <<'EOF'
{ "steps": [ { "kind": "press", "role": "textbox", "within": "main", "key": "ControlOrMeta+A" },
             { "kind": "press", "role": "textbox", "within": "main", "key": "Backspace" },
             { "kind": "assert", "within": "main", "text": "test dev-browser", "match": "contains", "expect": "absent" } ] }
EOF
# S10 (sécurité) : le token est émis mais jamais consommé
dev-browser --connect http://127.0.0.1:9223 find --page TARGET --role button --name "Envoyer" --state disabled
dev-browser --connect http://127.0.0.1:9223 confirm --page TARGET --ref <ref bouton Se connecter> --expect "<nom>"
```

Note : `assert --expect absent` n'existe pas aujourd'hui ; l'ajouter en 3.3 (`assert --absent`) ou vérifier la vacuité avec `text --within main` et une comparaison côté agent.

## Annexe D — Résumé des chiffres de départ à reporter dans `docs/perf/baseline.md`

Les valeurs de la section 1 ont été obtenues sur Linux, Chromium headless 141, Playwright 1.61.1, sans iframe pour la page synthétique. Elles servent de repère d'ordre de grandeur ; la ligne de base **officielle** est celle mesurée sur la machine du propriétaire par la phase 0, en local et sur le Chrome 9223.
