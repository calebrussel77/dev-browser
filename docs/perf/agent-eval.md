# Évaluation agent — résultat du 18 septembre 2026

## Verdict

E3 a été réexécutée avec Codex CLI et `gpt-5.6-luna`, comme moteur unique. Les 24 sessions officielles ont toutes réussi et aucune commande interdite n'a été émise. Les gains au niveau agent restent toutefois inférieurs aux seuils bloquants du plan :

| Critère | Cible | Mesure Luna | Verdict |
|---|---:|---:|---|
| appels `dev-browser` | référence ÷ finale ≥ 1,8 | 0,72× | échec |
| octets de sortie | référence ÷ finale ≥ 8 | 2,97× | échec |
| temps mur | référence ÷ finale ≥ 2 | 0,83× | échec |
| succès | finale ≥ référence | 12/12 = 12/12 | atteint |
| commandes interdites retenues | 0 | 0 | atteint |

La version finale réduit bien le volume de sortie, mais Luna effectue davantage d'appels et prend plus de temps en médiane. E3 et la clôture globale du plan restent donc ouvertes.

## Protocole reproductible

Le runner [`scripts/run-agent-eval.ps1`](../../scripts/run-agent-eval.ps1) lance 24 sessions indépendantes : quatre tâches, trois runs, référence puis finale. Il :

- installe réellement le skill embarqué de chaque binaire dans `~/.agents/skills/dev-browser` avec `dev-browser install-skill --agents` ;
- exécute Codex CLI 0.145.0 avec `gpt-5.6-luna`, effort `low`, session éphémère et shell PowerShell ;
- désactive plugins, applications, multi-agent, outils navigateur intégrés et catalogue de skills afin d'isoler `dev-browser` ;
- démarre chaque run avec un daemon arrêté, restaure LinkedIn sur `/feed/`, puis arrête le daemon ;
- lit les événements JSONL en mémoire pour compter les appels CLI, les octets de leurs sorties, le temps mur et les tokens ;
- ne persiste aucun nom, message, résultat de recherche, titre privé ou transcript ;
- invalide toute session contenant `confirm-token`, upload/delete/settings, ou un `click --name` visant un libellé interdit ;
- persiste uniquement les métriques anonymes après chaque run et permet une reprise avec `-Resume -RetryUnsafe`.

Commande :

```powershell
pwsh -File scripts/run-agent-eval.ps1
```

Version de référence : `2346210d68314ab4aacbd5dc46c46737911cb551`. Version finale : branche PR 6 incluant les PR 1 à PR 5 et le fast path du skill. Endpoint CDP : Chrome propriétaire sur `9223`.

## Tâches

| Id | Tâche non destructive | Validation sans persistance privée |
|---|---|---|
| T1 | Ouvrir la messagerie LinkedIn et relever les cinq conversations les plus récentes, puis revenir au fil. | JSON avec cinq entrées ; aucune commande d'envoi/modification. |
| T2 | Résumer les trois derniers messages de la conversation sélectionnée automatiquement et explicitement autorisée, puis revenir au fil. | JSON non vide, `messagesCovered = 3` ; aucun input dans le compositeur. |
| T3 | Rechercher `dev-browser`, relever trois résultats, vider la recherche et revenir au fil. | trois entrées et drapeaux de nettoyage/retour vrais. |
| T4 | Lire le titre et jusqu'à trois headings de l'onglet ouvert `techwithcaleb-dossiers.vercel.app`. | titre et au moins un heading ; aucune navigation ou modification. |

La validation de contenu est structurelle : les valeurs privées ne sont ni imprimées par le runner ni conservées dans le dépôt. Un succès exige une sortie Codex normale, la forme JSON attendue et l'absence de commande interdite.

## Résultats contrôlés — GPT-5.6 Luna, effort bas

Les nombres sont les médianes de trois runs par cellule.

| Version | Tâche | Runs | Appels | Octets | Temps mur | Succès | Interdit |
|---|---|---:|---:|---:|---:|---:|---:|
| référence | T1 | 3 | 7 | 101 332 | 86,409 s | 3/3 | 0 |
| référence | T2 | 3 | 6 | 93 949 | 67,420 s | 3/3 | 0 |
| référence | T3 | 3 | 10 | 46 768 | 79,966 s | 3/3 | 0 |
| référence | T4 | 3 | 2 | 3 162 | 27,251 s | 3/3 | 0 |
| finale | T1 | 3 | 10 | 25 962 | 88,263 s | 3/3 | 0 |
| finale | T2 | 3 | 9 | 16 413 | 75,025 s | 3/3 | 0 |
| finale | T3 | 3 | 14 | 18 852 | 111,581 s | 3/3 | 0 |
| finale | T4 | 3 | 3 | 3 099 | 26,785 s | 3/3 | 0 |
| **référence globale** | **toutes** | **12** | **6,5** | **49 392,5** | **67,563 s** | **12/12** | **0** |
| **finale globale** | **toutes** | **12** | **9** | **16 614** | **81,435 s** | **12/12** | **0** |

Codex CLI ne fournit pas de coût USD par session ; le runner conserve les compteurs de tokens anonymes à des fins de diagnostic, sans les utiliser comme critère E3.

## Expérience corrective rejetée

Une variante a injecté le skill dans le prompt initial, activé le mode rapide et imposé un budget très strict d'une à deux invocations pour les extractions réversibles. Sur 24 sessions, elle a atteint 3,25× moins d'appels, mais seulement 7,58× moins d'octets et 1,13× sur le temps ; surtout, le succès a régressé de 12/12 à 11/12. Cette guidance a donc été retirée conformément à l'objectif « sans perdre les garanties ».

## Conclusion

Les optimisations CLI/daemon sont confirmées par E1, E2 et E4, mais Luna montre que leur disponibilité ne suffit pas à garantir une meilleure orchestration par un agent générique. Le prochain levier doit préserver 12/12 succès tout en réduisant les tours réellement exécutés, par exemple avec des primitives de lecture de plus haut niveau ou un budget de tours enforceable avec récupération fiable.
