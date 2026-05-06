# Diagnostic: dev-browser attach to current Chrome session

Date: 2026-05-06

## Contexte

Objectif initial: utiliser `dev-browser` pour se connecter à la session Chrome actuelle de l'utilisateur, lire une page LinkedIn Sales Navigator déjà ouverte, qualifier des prospects Nfluenzo, puis insérer les prospects qualifiés dans Notion.

Page ciblée au moment du diagnostic:

```text
https://www.linkedin.com/sales/lists/people/7457370603965243392?sortCriteria=CREATED_TIME&sortOrder=DESCENDING
```

Environnement observé:

- Windows
- Chrome `147.0.7727.138`
- `dev-browser` daemon actif
- Chrome exposait un endpoint CDP sur `127.0.0.1:9222`

## Symptôme principal

`dev-browser --connect` ne parvient pas à rendre la session Chrome utilisable via Playwright.

La commande:

```powershell
dev-browser --connect --timeout 10 run .codex-dev-browser-connect.js
```

finissait par échouer avec:

```text
Error: Could not auto-discover a running Chrome instance with remote debugging enabled.
Enable Chrome remote debugging at chrome://inspect/#remote-debugging
or launch Chrome with: chrome.exe --remote-debugging-port=9222
Last connection error: browserType.connectOverCDP: Timeout 30000ms exceeded.
Call log:
  - <ws connecting> ws://127.0.0.1:9222/devtools/browser/767c24d8-e396-4ba0-9955-36c0a4aa3e01
  - <ws connected> ws://127.0.0.1:9222/devtools/browser/767c24d8-e396-4ba0-9955-36c0a4aa3e01
```

Même en passant explicitement le WebSocket:

```powershell
dev-browser --connect ws://127.0.0.1:9222/devtools/browser/767c24d8-e396-4ba0-9955-36c0a4aa3e01 --timeout 20 run .codex-dev-browser-connect.js
```

le résultat restait:

```text
browserType.connectOverCDP: Timeout 30000ms exceeded.
```

Point important: le log indique que le WebSocket se connecte bien. Le blocage arrive après, pendant l'attache Playwright.

## Vérifications effectuées

### 1. Le daemon dev-browser était actif

Commande:

```powershell
dev-browser status
```

Résultat observé:

```text
PID: 22080
Uptime: 290m 3s
Browsers: 1
Socket: \\.\pipe\dev-browser-daemon-dell
Managed: default (connected, connected)
```

### 2. Chrome écoutait bien sur le port 9222

Commande:

```powershell
Get-NetTCPConnection -LocalPort 9222
```

Résultat observé:

```text
LocalAddress LocalPort State  OwningProcess
127.0.0.1    9222     Listen 10608
```

Le process propriétaire était bien `chrome.exe`.

### 3. `DevToolsActivePort` confirmait l'endpoint

Fichier:

```text
C:\Users\DELL\AppData\Local\Google\Chrome\User Data\DevToolsActivePort
```

Contenu:

```text
9222
/devtools/browser/767c24d8-e396-4ba0-9955-36c0a4aa3e01
```

### 4. L'endpoint CDP brut fonctionnait

Un test Node avec WebSocket natif a envoyé:

```json
{"id":1,"method":"Browser.getVersion"}
```

Réponse observée:

```json
{
  "id": 1,
  "result": {
    "protocolVersion": "1.3",
    "product": "Chrome/147.0.7727.138",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  }
}
```

Conclusion: Chrome/CDP répond correctement. Le problème n'est pas un port fermé, un endpoint absent, ni une session Chrome inaccessible.

### 5. `Target.getTargets` fonctionnait aussi via CDP brut

Le CDP brut a listé les onglets Chrome et a retrouvé l'onglet Sales Navigator:

```json
{
  "title": "Saved on LinkedIn.com | Listes de prospects | Sales Navigator",
  "url": "https://www.linkedin.com/sales/lists/people/7457370603965243392?sortCriteria=CREATED_TIME&sortOrder=DESCENDING"
}
```

J'ai ensuite pu lire le contenu de cette page via CDP direct avec `Target.attachToTarget` + `Runtime.evaluate`.

Extrait récupéré:

```text
3 résultats
Daniela Kumassi KOFFI — Responsable marketing — CAFÉ CONTINENT — Abidjan, Côte d’Ivoire
Ella BOULINGUI — Assistante marketing commercial — BLUEBERRY TRAVEL SENEGAL — Région de Dakar, Sénégal
Michele Mballa Mekongo — Marketing Manager Rum and Liqueur — Diageo — Douala, Cameroun
```

Conclusion: une implémentation CDP directe peut piloter la session. C'est spécifiquement le chemin `dev-browser -> Playwright connectOverCDP()` qui bloque.

## Issue GitHub potentiellement liée

Issue:

```text
https://github.com/SawyerHood/dev-browser/issues/103
```

Titre:

```text
Chrome 147 built-in remote debugging can hang connectOverCDP unless PW_CHROMIUM_ATTACH_TO_OTHER=1
```

Cette issue semble très probablement liée au problème observé.

Elle décrit exactement le même pattern:

- Chrome 147
- session Chrome réelle/default profile
- remote debugging activé via le flux Chrome
- `connectOverCDP()` qui peut hang
- transport WebSocket connecté, mais navigateur non utilisable via Playwright

L'issue indique que le workaround testé est de lancer le process/daemon avec:

```text
PW_CHROMIUM_ATTACH_TO_OTHER=1
```

Note opérationnelle importante: si cette variable est ajoutée après le lancement du daemon, il faut redémarrer le daemon. Un daemon déjà lancé garde son ancien environnement.

## Hypothèse technique

Le blocage est probablement dans la phase d'auto-attach Playwright sur les targets Chrome.

D'après l'issue #103, Chrome 147 ne déclenche pas toujours les événements `Target.attachedToTarget` attendus pour certains targets pendant le parcours d'attache automatique. Playwright attend alors indéfiniment ou jusqu'au timeout.

`PW_CHROMIUM_ATTACH_TO_OTHER=1` semble forcer Playwright à considérer les targets `targetInfo.type === "other"` comme attachables, ce qui débloque le walk d'auto-attach.

## Actions mises en place pendant le diagnostic

1. Chargement du skill `dev-browser`.
2. Vérification de `dev-browser --help`.
3. Vérification de `dev-browser status`.
4. Tentative de connexion automatique:

```powershell
dev-browser --connect --timeout 10 run .codex-dev-browser-connect.js
```

5. Tentative de connexion explicite au WebSocket CDP:

```powershell
dev-browser --connect ws://127.0.0.1:9222/devtools/browser/767c24d8-e396-4ba0-9955-36c0a4aa3e01 --timeout 20 run .codex-dev-browser-connect.js
```

6. Vérification de l'endpoint Chrome via:

```powershell
Get-NetTCPConnection -LocalPort 9222
Get-Content "$env:LOCALAPPDATA\Google\Chrome\User Data\DevToolsActivePort"
```

7. Test CDP brut en Node avec `Browser.getVersion`.
8. Test CDP brut en Node avec `Target.getTargets`.
9. Attache CDP directe à l'onglet Sales Navigator et lecture du DOM via `Runtime.evaluate`.
10. Nettoyage des scripts temporaires créés pendant le diagnostic.

## Ce qu'un autre agent devrait tester en premier

### Test A: workaround environnemental

Depuis un shell propre:

```powershell
$env:PW_CHROMIUM_ATTACH_TO_OTHER = "1"
dev-browser stop
dev-browser --connect --timeout 20 run .\repro-connect.js
```

`repro-connect.js`:

```js
console.log("start");
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
```

Attendu:

- `browser.listPages()` doit retourner les onglets Chrome au lieu de timeout.
- L'onglet LinkedIn Sales Navigator doit apparaître.

### Test B: vérifier que le daemon hérite bien de la variable

Si le test A échoue, confirmer que le process daemon a bien été redémarré après l'ajout de `PW_CHROMIUM_ATTACH_TO_OTHER=1`.

Point critique: `dev-browser stop` doit être appelé avant de relancer le test, sinon l'ancien daemon reste vivant avec l'ancien environnement.

### Test C: patch natif dans dev-browser

Dans le code source de `dev-browser`, chercher la zone qui lance ou redémarre le daemon, puis injecter par défaut:

```js
PW_CHROMIUM_ATTACH_TO_OTHER: "1"
```

uniquement pour le chemin `--connect` / live Chrome attach, ou globalement si cela ne crée pas de régression.

### Test D: fallback CDP direct

Si Playwright reste instable, implémenter un fallback minimal pour `--connect`:

- lire `DevToolsActivePort` si `/json/version` échoue ou si l'auto-discovery est ambiguë;
- utiliser `Browser.getVersion` pour valider le WebSocket;
- utiliser `Target.getTargets` pour `browser.listPages()`;
- utiliser `Target.attachToTarget` + `Runtime.evaluate` pour une première capacité `getPage(targetId)` minimale.

Ce fallback ne remplace pas tout Playwright, mais il permettrait au moins de diagnostiquer et d'opérer les cas où Playwright hang pendant `connectOverCDP`.

## Fix recommandé

Priorité 1:

Ajouter `PW_CHROMIUM_ATTACH_TO_OTHER=1` à l'environnement du daemon dans le chemin `--connect`, puis documenter que le daemon doit être redémarré.

Priorité 2:

Réduire le timeout ou améliorer les logs autour de `connectOverCDP()`:

- endpoint utilisé;
- source de découverte (`DevToolsActivePort`, auto-discovery, URL explicite);
- moment exact du blocage;
- suggestion automatique si Chrome 147 est détecté.

Priorité 3:

Ajouter un test ou repro automatisé qui vérifie qu'un Chrome 147 avec remote debugging activé peut être attaché et que `browser.listPages()` retourne des tabs.

## Conclusion

Le problème observé correspond très fortement à l'issue #103.

Le CDP Chrome fonctionne: le WebSocket répond, les targets sont listables, et l'onglet LinkedIn peut être lu via CDP brut. Le point de rupture est l'attache Playwright utilisée par `dev-browser --connect`, probablement `connectOverCDP()` sur Chrome 147.

Le correctif le plus plausible à tester est:

```text
PW_CHROMIUM_ATTACH_TO_OTHER=1
```

avec redémarrage du daemon `dev-browser`.
