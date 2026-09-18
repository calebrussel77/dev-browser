# Évaluation agent — résultat du 18 septembre 2026

## Verdict

E3 a été exécutée intégralement, mais **les critères de vitesse au niveau agent ne sont pas atteints**. La version finale conserve les garanties de sécurité et ne régresse pas sur le taux de succès mesuré, mais les médianes globales ne satisfont pas les facteurs demandés :

| Critère | Cible | Mesure finale | Verdict |
|---|---:|---:|---|
| appels `dev-browser` | référence ÷ finale ≥ 1,8 | 1,15× | échec |
| octets de sortie | référence ÷ finale ≥ 8 | 1,74× | échec |
| temps mur | référence ÷ finale ≥ 2 | 0,94× | échec |
| succès | finale ≥ référence | 0/12 = 0/12 | atteint, mais non informatif |
| commandes interdites retenues | 0 | 0 | atteint |

Le plan ne doit donc pas être déclaré terminé sur la seule base des gains CLI/daemon. Les benchmarks de commandes montrent bien les améliorations locales consignées dans les rapports PR 1 à PR 5, mais elles ne se traduisent pas encore de manière fiable en réduction de tours d'un agent générique.

## Protocole reproductible

Le runner [`scripts/run-agent-eval.ps1`](../../scripts/run-agent-eval.ps1) lance 24 sessions indépendantes : quatre tâches, trois runs, référence puis finale. Il :

- installe réellement le skill embarqué de chaque binaire avec `dev-browser install-skill --claude` ;
- démarre chaque run avec un daemon arrêté, puis restaure LinkedIn sur `/feed/` et arrête le daemon ;
- lance Claude Code en `--safe-mode`, sans sous-agent, avec uniquement `Read` et `Bash` ;
- lit les événements JSONL en mémoire pour compter les occurrences CLI, les octets des résultats d'outil, le temps mur, le coût et le résultat structuré ;
- ne persiste aucun nom, message, résultat de recherche, titre privé ou transcript ;
- invalide toute session contenant `confirm-token`, upload/delete/settings, ou un `click --name` visant un libellé interdit ;
- persiste les seules métriques anonymes après chaque run et permet une reprise sûre avec `-Resume -RetryUnsafe`.

Version de référence : `2346210d68314ab4aacbd5dc46c46737911cb551`. Version finale : branche PR 6 incluant les PR 1 à PR 5 et le fast path du skill. Endpoint CDP : Chrome propriétaire sur `9223`.

Le jeu contrôlé retenu utilise `claude-haiku-4-5-20251001`, effort `low`, 20 tours maximum, même prompt système et mêmes tâches pour les deux versions. Les sessions qui ont émis une commande interdite ont été exclues puis rejouées ; aucun transcript retenu n'en contient.

## Tâches

| Id | Tâche non destructive | Validation sans persistance privée |
|---|---|---|
| T1 | Ouvrir la messagerie LinkedIn et relever les cinq conversations les plus récentes, puis revenir au fil. | JSON avec cinq entrées ; aucune commande d'envoi/modification. |
| T2 | Résumer les trois derniers messages de la conversation sélectionnée automatiquement et explicitement autorisée, puis revenir au fil. | JSON non vide, `messagesCovered = 3` ; aucun input dans le compositeur. |
| T3 | Rechercher `dev-browser`, relever trois résultats, vider la recherche et revenir au fil. | trois entrées et drapeaux de nettoyage/retour vrais. |
| T4 | Lire le titre et jusqu'à trois headings de l'onglet ouvert `techwithcaleb-dossiers.vercel.app`. | titre et au moins un heading ; aucune navigation ou modification. |

La validation de contenu est volontairement structurelle : les valeurs privées ne sont ni imprimées dans le journal du runner ni conservées dans le dépôt. Un succès exige en plus une sortie Claude Code normale et l'absence de commande interdite.

## Résultats contrôlés — Haiku 4.5, effort bas

Les nombres sont les médianes de trois runs par cellule.

| Version | Tâche | Runs | Appels | Octets | Temps mur | Succès | Interdit |
|---|---|---:|---:|---:|---:|---:|---:|
| référence | T1 | 3 | 12 | 28 081 | 82,290 s | 0/3 | 0 |
| référence | T2 | 3 | 11 | 3 132 | 98,385 s | 0/3 | 0 |
| référence | T3 | 3 | 10 | 28 403 | 72,990 s | 0/3 | 0 |
| référence | T4 | 3 | 7 | 4 077 | 247,955 s | 0/3 | 0 |
| finale | T1 | 3 | 11 | 2 929 | 89,363 s | 0/3 | 0 |
| finale | T2 | 3 | 13 | 4 358 | 90,219 s | 0/3 | 0 |
| finale | T3 | 3 | 10 | 10 627 | 97,595 s | 0/3 | 0 |
| finale | T4 | 3 | 9 | 2 406 | 153,366 s | 0/3 | 0 |
| **référence globale** | **toutes** | **12** | **11,5** | **6 335,5** | **90,338 s** | **0/12** | **0** |
| **finale globale** | **toutes** | **12** | **10** | **3 643,5** | **95,745 s** | **0/12** | **0** |

Coût rapporté des 24 sessions retenues : 2,196497 USD (référence 1,039702 ; finale 1,156795). Les pilotes et retries invalidés ne sont pas inclus dans ce total.

## Contrôle exploratoire — Sonnet 4.6

Un premier jeu complet Sonnet standard a également été conservé pour vérifier que le constat ne dépendait pas seulement du petit modèle. Résultat global :

| Version | Runs | Appels médians | Octets médians | Temps médian | Succès | Interdit |
|---|---:|---:|---:|---:|---:|---:|
| référence | 12 | 4 | 1 543 | 105,562 s | 3/12 | 0 |
| finale | 12 | 5,5 | 1 391 | 155,824 s | 3/12 | 0 |

Ratios référence ÷ finale : appels 0,73×, octets 1,11×, temps 0,68×. Coût rapporté : 3,851 USD. Sonnet confirme donc le même échec des seuils, tout en donnant un taux de succès égal et non nul.

## Expérience corrective rejetée

Une variante de guidance imposant une extraction one-shot et un plafond de quatre appels a été testée après le premier échec. Le gabarit CLI fonctionne directement en un appel, mais l'agent ne respecte pas systématiquement le plafond (jusqu'à 18 appels observés) et la fiabilité T4 a régressé. Cette variante a été retirée ; elle ne fait pas partie du skill final.

## Conclusion et suite nécessaire

E3 met en évidence que le prochain levier n'est plus la latence du daemon mais la politique d'orchestration de l'agent : limitation de tours réellement enforceable, primitives de lecture de haut niveau ou évaluation sur fixtures déterministes avec validation de contenu. Tant qu'un nouveau changement n'obtient pas les trois facteurs demandés sur un jeu avec un taux de succès utile, la case « critères E3 » et la clôture globale du plan doivent rester ouvertes.
