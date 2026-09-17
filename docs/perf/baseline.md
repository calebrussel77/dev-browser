# Baseline de performance — 17 septembre 2026

Référence avant optimisation, mesurée au commit `2346210d68314ab4aacbd5dc46c46737911cb551` (outils 0.1 et 0.2). Les deux passes locales et les trois passes live ont été exécutées. La passe WhatsApp est **partiellement invalide** : ses commandes ciblant `main` échouent, faute de ce landmark. Les résultats réussis et les échecs sont conservés séparément dans les tableaux.

## Environnement et protocole

- Date : 2026-09-17, mesures locales à 12:49–12:50, live à environ 12:52–12:59, fuseau Africa/Lagos (UTC+01:00).
- OS : Microsoft Windows 11 Professionnel, 10.0.26200, x64.
- Node.js : 24.14.1 ; pnpm exécuté : 9.15.4 (le package déclare 10.30.1) ; Playwright / playwright-core : 1.61.1 ; Vitest : 4.1.0.
- Rust : rustc 1.90.0 (1159e78c4, 2025-09-14), build `release`, cible `x86_64-pc-windows-msvc`. Substitution explicite au target GNU inutilisable sur cette machine à cause de MinGW/dlltool.
- Binaire : `cli/target/x86_64-pc-windows-msvc/release/dev-browser.exe`, version package 0.2.8. SHA-256 : `5f42b24179223e0f48ca9e1d7b625ac2e13435a508d561abc62eeb4f7cdd618a`.
- Chrome live : **152.0.7977.83**, protocole CDP 1.3, V8 15.2.124.21, relevés sur `http://127.0.0.1:9223/json/version`.
- Navigateur local distinct : **HeadlessChrome/149.0.7827.55**, fourni par Playwright ; viewport 1280×720, deviceScaleFactor 1, confirmés par le journal CDP. `CHROME_EXE` non défini.
- DPR live : **1,25**, lu sans mutation avec `page.evaluate(() => window.devicePixelRatio)` ; viewport 1536×730 CSS px sur messagerie, feed et WhatsApp.
- Live : Chrome existant, daemon préchauffé par les observations préparatoires, cinq lancements CLI par commande, sans `DEBUG`. Le bench utilise le timeout CLI par défaut de 30 s. Les commandes préparatoires utilisent explicitement 10 ou 20 s.
- Local : un échantillon par ligne. Latences et tailles issues uniquement de la passe non instrumentée ; compteurs CDP issus d'une deuxième passe et fusionnés avec `scripts/count-cdp.mjs`. Le test comprend fixture locale, iframe/shadow DOM et page lourde synthétique.
- Les tailles locales sont des octets UTF-8 du résultat sérialisé ; `~tokens` = arrondi(longueur du JSON pretty / 4), une estimation, pas une tokenisation. Les lignes script ont zéro octet car le helper n'enregistre pas leur stdout. Les compteurs CDP désignent les messages **SEND** entre marqueurs, pas des allers-retours réseau.
- Live : médiane, quartiles interpolés p25/p75, maximum et médiane des octets stdout, échecs inclus dans les statistiques. Les captures PNG ne sont pas incluses dans les octets stdout ; seules leurs métadonnées JSON le sont.

## Local — référence non instrumentée et compteurs CDP séparés

Passe non instrumentée : **27 696 ms** pour `pnpm bench`, test 25,47 s, sortie 0. Passe CDP : **26 801 ms**, test 25,01 s, sortie 0. Les deux sont sous 60 s. Les 29 étapes réussissent ; aucune colonne CDP `n/a`.

| step | status | latency ms | pretty bytes | compact bytes | ~tokens | CDP messages | top CDP methods |
|---|---|---:|---:|---:|---:|---:|---|
| fixture: observe | ok | 1055 | 90335 | 54814 | 22584 | 300 | Runtime.callFunctionOn×113, Runtime.releaseObject×70, DOM.resolveNode×41, DOM.getFrameOwner×36 |
| fixture: find button Connect within main | ok | 98 | 5660 | 4756 | 1415 | 3 | Runtime.callFunctionOn×3 |
| fixture: click --ref | ok | 1680 | 93393 | 56527 | 23348 | 512 | Runtime.callFunctionOn×243, Runtime.releaseObject×117, DOM.resolveNode×61, DOM.getFrameOwner×42 |
| fixture: click --ref --shot | ok | 2972 | 94067 | 57098 | 23517 | 1473 | Runtime.callFunctionOn×619, Runtime.releaseObject×346, DOM.resolveNode×202, DOM.getFrameOwner×168 |
| fixture: click --ref --wait-text | ok | 2691 | 94307 | 57273 | 23577 | 1211 | Runtime.callFunctionOn×520, Runtime.releaseObject×281, DOM.resolveNode×167, DOM.getFrameOwner×138 |
| setup: find fixture textbox | ok | 384 | 12875 | 9417 | 3219 | 288 | Runtime.callFunctionOn×113, Runtime.releaseObject×70, DOM.resolveNode×41, DOM.getFrameOwner×36 |
| fixture: type --ref | ok | 2168 | 94187 | 57076 | 23547 | 1366 | Runtime.callFunctionOn×567, Runtime.releaseObject×336, DOM.resolveNode×183, DOM.getFrameOwner×144 |
| fixture: shot | ok | 915 | 91147 | 55358 | 22787 | 585 | Runtime.callFunctionOn×230, Runtime.releaseObject×141, DOM.resolveNode×82, DOM.getFrameOwner×72 |
| fixture: navigate | ok | 601 | 90291 | 54770 | 22573 | 301 | Runtime.callFunctionOn×113, Runtime.releaseObject×70, DOM.resolveNode×41, DOM.getFrameOwner×36 |
| fixture: pages | ok | 32 | 357 | 257 | 89 | 11 | Runtime.callFunctionOn×2, Runtime.runIfWaitingForDebugger×2, Target.attachToTarget×2, Target.detachFromTarget×2 |
| raw: collectPageState | ok | 362 | 291695 | 172685 | 72924 | 287 | Runtime.callFunctionOn×112, Runtime.releaseObject×70, DOM.resolveNode×41, DOM.getFrameOwner×36 |
| raw: collectLiveSnapshot | ok | 70 | 33290 | 23100 | 8323 | 36 | Runtime.callFunctionOn×18, DOM.getFrameOwner×6, DOM.resolveNode×6, Runtime.releaseObject×6 |
| setup: find resolveActionTarget target | ok | 55 | 5659 | 4755 | 1415 | 3 | Runtime.callFunctionOn×3 |
| raw: resolveActionTarget | ok | 242 | 157 | 113 | 39 | 159 | Runtime.callFunctionOn×88, Runtime.releaseObject×41, DOM.describeNode×14, DOM.resolveNode×14 |
| script: trivial (cold) | ok | 280 | 0 | 0 | 0 | 1 | Runtime.callFunctionOn×1 |
| script: trivial (warm) | ok | 166 | 0 | 0 | 0 | 1 | Runtime.callFunctionOn×1 |
| heavy: observe | ok | 501 | 105821 | 63237 | 26452 | 13 | Runtime.callFunctionOn×6, Runtime.releaseObject×4, Runtime.getProperties×3 |
| heavy: observe --within main --max-nodes 300 | ok | 372 | 77082 | 46797 | 19266 | 3 | Runtime.callFunctionOn×3 |
| heavy: observe --delta | ok | 414 | 106661 | 63645 | 26662 | 13 | Runtime.callFunctionOn×6, Runtime.releaseObject×4, Runtime.getProperties×3 |
| heavy: find More actions 77 | ok | 356 | 5519 | 4624 | 1376 | 3 | Runtime.callFunctionOn×3 |
| heavy: click --ref | ok | 1604 | 110446 | 66195 | 27608 | 190 | Runtime.callFunctionOn×107, Runtime.releaseObject×45, DOM.describeNode×14, DOM.resolveNode×14 |
| setup: find heavy note | ok | 402 | 5992 | 5126 | 1494 | 13 | Runtime.callFunctionOn×6, Runtime.releaseObject×4, Runtime.getProperties×3 |
| heavy: type --ref 40 chars | ok | 1743 | 110951 | 66777 | 27734 | 266 | Runtime.callFunctionOn×139, Runtime.releaseObject×72, DOM.describeNode×19, DOM.resolveNode×19 |
| heavy: raw collectPageState | ok | 391 | 1345938 | 793261 | 336439 | 12 | Runtime.callFunctionOn×5, Runtime.releaseObject×4, Runtime.getProperties×3 |
| heavy: raw collectLiveSnapshot | ok | 62 | 147063 | 93829 | 36727 | 1 | Runtime.callFunctionOn×1 |
| heavy: text --within main | ok | 21 | 9716 | 9566 | 2348 | 3 | Runtime.callFunctionOn×3 |
| heavy: assert --within main | ok | 15 | 9642 | 9513 | 2329 | 3 | Runtime.callFunctionOn×3 |
| heavy: scroll down | ok | 1175 | 108411 | 65344 | 27099 | 42 | Runtime.callFunctionOn×20, Runtime.releaseObject×12, Runtime.getProperties×9, Input.dispatchMouseEvent×1 |
| heavy: press Tab | ok | 1581 | 109116 | 65511 | 27275 | 202 | Runtime.callFunctionOn×108, Runtime.releaseObject×52, DOM.describeNode×13, DOM.resolveNode×13 |

## Live — LinkedIn messagerie

Onglet choisi par URL LinkedIn et titre « Fil d’actualité | LinkedIn », puis navigation interne autorisée vers `https://www.linkedin.com/messaging/`. LinkedIn sélectionne automatiquement un fil ; son identifiant et son contenu sont omis du rapport. Titre observé : « Messagerie | LinkedIn » avec compteur variable.

`FIND_NAME` non défini : les lignes de conversation sont exposées comme `div`, tandis que le bench 0.2 impose `--role button`. Les boutons contenant les noms ouvrent des menus d'options et ne constituent pas la cible d'ouverture de conversation demandée. Aucun clic ni Escape mesuré. Pour une future cible admissible, le nom doit être consigné sous `<conversation redacted>`.

La passe complète ci-dessous, réalisée après récupération du daemon décrite plus bas, a duré **16 302 ms**, sortie 0 : **30 échantillons**, cinq par commande, tous réussis.

| command | median ms | dispersion ms (p25–p75) | max ms | median stdout bytes | failures/5 |
|---|---:|---:|---:|---:|---:|
| pages | 56.6 | 51.4–57.2 | 57.6 | 756 | 0 |
| observe --page $linkedinPage | 484.1 | 431.1–492.9 | 539.8 | 92274 | 0 |
| observe --page $linkedinPage --within main | 320.3 | 317.1–331.3 | 364.0 | 114693 | 0 |
| text --page $linkedinPage --within main | 70.6 | 69.0–80.4 | 87.8 | 9103 | 0 |
| shot --page $linkedinPage | 1079.7 | 1078.7–1085.4 | 1086.9 | 93063 | 0 |
| scroll --page $linkedinPage --direction down --pages 1 | 1253.1 | 1236.8–1275.3 | 1292.9 | 93611 | 0 |

## Live — LinkedIn feed

Même onglet, navigation vers sa page initiale `https://www.linkedin.com/feed/foryou/`, titre « Fil d’actualité | LinkedIn ». `FIND_NAME` non défini. Durée **39 989 ms**, sortie 0 : **30 échantillons**, tous réussis.

| command | median ms | dispersion ms (p25–p75) | max ms | median stdout bytes | failures/5 |
|---|---:|---:|---:|---:|---:|
| pages | 54.4 | 49.2–59.6 | 68.4 | 696 | 0 |
| observe --page $linkedinPage | 1044.9 | 969.3–1064.4 | 1339.7 | 17376 | 0 |
| observe --page $linkedinPage --within main | 281.5 | 276.9–282.1 | 326.8 | 5931 | 0 |
| text --page $linkedinPage --within main | 61.6 | 61.6–65.2 | 77.1 | 9309 | 0 |
| shot --page $linkedinPage | 2481.5 | 2457.0–2689.6 | 3234.7 | 18165 | 0 |
| scroll --page $linkedinPage --direction down --pages 1 | 3787.3 | 3412.2–3804.1 | 5329.5 | 18713 | 0 |

## Live — WhatsApp Business

Onglet existant choisi par URL `https://web.whatsapp.com/` et titre « WhatsApp Business ». Page conservée en lecture seule, sans navigation, sans sélection de conversation, sans clic et sans saisie. Une recherche déjà présente avant le bench est préservée ; sa valeur et les noms/contenus sont omis. `FIND_NAME` non défini.

Durée **10 506 ms**, sortie **1** : **30 échantillons**, dont dix échecs attendus de portée. Il n'existe ni `main` ni `[role="main"]` sur cette page. `observe --within main` et `text --within main` échouent chacun 5/5, code CLI 3, diagnostic exact : `No element matched scope "main"`. Le harness signale `invalid benchmark: no successful samples for observe-main, text-main`. Leurs latences décrivent une erreur rapide, pas le coût d'une observation/lecture réussie.

| command | median ms | dispersion ms (p25–p75) | max ms | median stdout bytes | failures/5 |
|---|---:|---:|---:|---:|---:|
| pages | 56.4 | 47.6–59.5 | 61.3 | 696 | 0 |
| observe --page $otherPage | 208.6 | 207.1–229.3 | 332.6 | 145927 | 0 |
| observe --page $otherPage --within main | 52.9 | 49.5–56.7 | 57.8 | 0 | 5 |
| text --page $otherPage --within main | 47.4 | 45.4–49.3 | 51.9 | 0 | 5 |
| shot --page $otherPage | 1008.0 | 928.4–1123.3 | 1143.1 | 157255 | 0 |
| scroll --page $otherPage --direction down --pages 1 | 675.4 | 570.5–703.6 | 961.1 | 147264 | 0 |

## Commandes reproductibles

PowerShell, depuis `C:\Labs\dev-browser-agent-speed`. Les variables d'identifiants se résolvent depuis `pages` à chaque nouvelle session, par URL **et** titre, jamais par position. Aucun nom privé n'est nécessaire dans cette exécution.

```powershell
Set-Location C:\Labs\dev-browser-agent-speed
git rev-parse HEAD
Push-Location daemon
pnpm bundle
pnpm bundle:sandbox-client
Pop-Location
Push-Location cli
cargo build --release --target x86_64-pc-windows-msvc
Pop-Location

$baselineTemp = Join-Path $env:TEMP 'dev-browser-baseline-20260917-2346210'
New-Item -ItemType Directory -Path $baselineTemp
$env:BENCH = '1'
$env:BENCH_OUT = Join-Path $baselineTemp 'local.md'
Remove-Item Env:DEBUG -ErrorAction SilentlyContinue
Push-Location daemon
pnpm bench > (Join-Path $baselineTemp 'local.stdout.log') 2> (Join-Path $baselineTemp 'local.stderr.log')
$env:DEBUG = 'pw:protocol'
$env:BENCH_CDP_OUT = Join-Path $baselineTemp 'local.cdp.md'
pnpm bench > (Join-Path $baselineTemp 'cdp.stdout.log') 2> (Join-Path $baselineTemp 'cdp.log')
Pop-Location
Remove-Item Env:DEBUG -ErrorAction SilentlyContinue
node scripts/count-cdp.mjs (Join-Path $baselineTemp 'cdp.log') (Join-Path $baselineTemp 'local.md')

$env:DEV_BROWSER_BIN = 'C:\Labs\dev-browser-agent-speed\cli\target\x86_64-pc-windows-msvc\release\dev-browser.exe'
$env:CONNECT = 'http://127.0.0.1:9223'
Remove-Item Env:FIND_NAME -ErrorAction SilentlyContinue
$tabs = (& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT pages | ConvertFrom-Json).pages
$linkedinMatches = @($tabs | Where-Object {
  $_.url -like 'https://www.linkedin.com/feed/*' -and $_.title -like '*Fil d*actualité*LinkedIn*'
})
$otherMatches = @($tabs | Where-Object {
  $_.url -eq 'https://web.whatsapp.com/' -and $_.title -eq 'WhatsApp Business'
})
if ($linkedinMatches.Count -ne 1 -or $otherMatches.Count -ne 1) {
  throw 'Reinspect pages: missing or ambiguous URL/title target'
}
$linkedinPage = $linkedinMatches[0].id
$otherPage = $otherMatches[0].id

& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT navigate --page $linkedinPage --url https://www.linkedin.com/messaging/
& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT observe --page $linkedinPage --within main --max-nodes 100 --max-chars 14000
$env:PAGE = $linkedinPage
node scripts/bench-cli.mjs --runs 5 > (Join-Path $baselineTemp 'messaging.md') 2> (Join-Path $baselineTemp 'messaging.stderr.log')

& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT navigate --page $linkedinPage --url https://www.linkedin.com/feed/foryou/
node scripts/bench-cli.mjs --runs 5 > (Join-Path $baselineTemp 'feed.md') 2> (Join-Path $baselineTemp 'feed.stderr.log')

$env:PAGE = $otherPage
node scripts/bench-cli.mjs --runs 5 > (Join-Path $baselineTemp 'other.md') 2> (Join-Path $baselineTemp 'other.stderr.log')

& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT navigate --page $linkedinPage --url https://www.linkedin.com/feed/foryou/
& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT pages
& $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT assert --page $linkedinPage --within main --text 'Pour vous'
```

Après l'essai messagerie avorté de cette session : arrêt des seuls processus CLI/harness de cet essai, puis `dev-browser.exe --timeout 10 stop`, `--timeout 10 --connect http://127.0.0.1:9223 pages`, et `--timeout 10 --connect http://127.0.0.1:9223 scroll --page $linkedinPage --direction down --pages 1`. Le daemon ne gérait alors que la connexion externe `default`. Le scroll de contrôle a réussi en 3,9 s. La même commande de benchmark a ensuite été relancée vers `messaging-retry.md` et `messaging-retry.stderr.log` ; c'est cette passe complète qui figure dans le tableau.

Métadonnées, sans mutation de page :

```powershell
Invoke-RestMethod http://127.0.0.1:9223/json/version
Get-Date -Format o
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture
node --version
pnpm --version
rustc --version
Push-Location daemon
node -p "require('playwright/package.json').version"
Pop-Location
Get-FileHash -Algorithm SHA256 $env:DEV_BROWSER_BIN
# Remplacer TARGET_FROM_PAGES par l'identifiant vérifié, pour chaque page.
@'
const page = await browser.getPage("TARGET_FROM_PAGES");
console.json(await page.evaluate(() => ({
  dpr: window.devicePixelRatio,
  viewport: { width: innerWidth, height: innerHeight }
})));
'@ | & $env:DEV_BROWSER_BIN --timeout 20 --connect $env:CONNECT
```

Conserver tous les fichiers de sortie dans le répertoire temporaire. Les captures automatiques du bench se trouvent dans `%USERPROFILE%\.dev-browser\tmp\interactive` : inventorier les fichiers avant/après et ne supprimer que les captures créées par cette exécution, après validation des chemins absolus. Extraire les agrégats expurgés, puis supprimer le répertoire temporaire exact. Ne jamais supprimer l'ensemble de `.dev-browser\tmp`.

## Anomalies, limites et hygiène

1. **Premier essai messagerie avorté.** Les cinq captures ont échoué, code 6 : `Screenshot capture timed out after 7997ms (the browser window may be minimized; restore it or use a headless browser)`. La commande scroll suivante est restée bloquée plus de 90 s malgré le timeout CLI par défaut de 30 s. Le harness n'a pas émis de tableau avant son interruption ; ses latences partielles ne sont pas récupérables et ne sont pas présentées comme des résultats valides. La cause précise (occlusion, état du daemon ou autre) n'est pas démontrée. Après récupération, captures et scroll ont réussi dans la passe complète.
2. Un autre onglet d'application initialement envisagé était une page d'erreur Chrome. Le premier attachement échouait avec `targetId could not be resolved` malgré sa présence dans `pages` ; une seconde observation a révélé `chrome-error://chromewebdata/`. Aucun chargement forcé ni navigation n'a été tenté sur cette application. WhatsApp a été sélectionné à sa place.
3. Les dix erreurs WhatsApp liées à l'absence de `main` restent visibles. Ces lignes ne permettent aucune comparaison de performance avec un landmark réussi sur LinkedIn. Les mesures sans clic sont valides pour les autres commandes ; aucun coût de `find`, clic ou Escape live n'est établi.
4. Ce sont des pages connectées changeantes, avec caches, compteurs et chargements propres aux sites. Les scrolls sont exécutés successivement sans remise à zéro entre échantillons. Un succès de `scroll` mesure l'exécution du CLI et sa réponse ; il ne garantit pas un déplacement utile du contenu. Les contrôles finaux ont trouvé les scrolls de document à zéro et les conteneurs WhatsApp observables à `scrollTop=0`.
5. Les erreurs préparatoires d'assertion ne sont pas des échantillons : sans cible, le CLI refuse les arguments ; `--within body` ne correspond à aucune portée disponible. L'assertion finale LinkedIn `--within main --text 'Pour vous'` réussit. WhatsApp est vérifié par `pages`, observation et lectures DOM.
6. LinkedIn est revenu à son URL initiale `/feed/foryou/`. WhatsApp est resté à son URL et à son état initial, y compris sa recherche préexistante. Aucun champ n'a été saisi ou effacé par le bench. Les compositeurs étaient vides. Aucun menu contextuel ouvert : zéro contrôle visible `[aria-haspopup="menu"][aria-expanded="true"]` sur les deux pages ; les deux éléments LinkedIn portant le rôle `menu` sont les blocs permanents de la barre latérale, pas des popups. Les trois onglets existants sont conservés.
7. Aucune action d'envoi, sauvegarde applicative, suppression applicative, upload, paiement, réglage ou consommation de token n'a été exécutée. Les actions live se limitent aux observations, lectures, captures, scrolls, navigation interne LinkedIn et vérifications.
8. **Nettoyage vérifié** : 15 captures live réussies supprimées ; les cinq captures du premier essai avaient échoué sans produire de fichier. Les 134 captures préexistantes sont toutes préservées. Les 16 fichiers temporaires de cette tâche (dont le log CDP de 31 842 547 octets) et leur répertoire ont été supprimés après extraction. Les deux fixtures locales ont nettoyé leurs profils et captures ; aucun répertoire `dev-browser-bench-*` résiduel. Aucun log, capture, nom de conversation, identifiant de fil ou contenu privé n'est commité.
