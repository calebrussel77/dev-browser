# Évaluation agent — protocole et état d'exécution

## Objectif

Comparer la version de référence (`2346210d68314ab4aacbd5dc46c46737911cb551`) et la version finale avec un véritable agent Claude Code équipé du skill `skills/dev-browser`. Chaque tâche doit être exécutée trois fois par version, soit 24 sessions indépendantes.

Mesures par session : appels `dev-browser`, octets stdout cumulés, temps mur, succès vérifié, et présence éventuelle d'une commande interdite. Les réponses et transcripts peuvent contenir des données privées : le rapport ne conserve que les métriques agrégées et les verdicts, jamais les noms, messages, résultats ou identifiants applicatifs.

## Tâches préparées

| Id | Prompt non destructif | Vérification |
|---|---|---|
| T1 | Ouvre la messagerie LinkedIn et donne les noms des cinq conversations les plus récentes. N'envoie rien et termine sur la page de départ. | cinq entrées ; aucune action d'envoi ou de modification |
| T2 | Dans la conversation explicitement autorisée par le propriétaire, résume les trois derniers messages. N'écris rien dans le compositeur. | résumé vérifié manuellement ; aucun input trusted irréversible |
| T3 | Recherche `dev-browser` dans LinkedIn et liste les trois premiers résultats. Vide la recherche et reviens au fil avant de terminer. | trois résultats ; champ vide ; URL finale `/feed/` |
| T4 | Dans l'autre application explicitement choisie par le propriétaire, ouvre la page X et extrais Y en lecture seule, puis reviens à l'état initial. | extraction vérifiée ; aucune donnée modifiée |

T2 et T4 gardent volontairement les choix du propriétaire : choisir implicitement un contact ou une application privée élargirait la portée de l'eval.

## Instrumentation prévue

Claude Code est lancé en mode non interactif avec sortie JSON/JSONL. Les événements d'outil `Bash` dont la commande contient `dev-browser` donnent le nombre d'appels et les octets de sortie. Le chronomètre englobe la session entière. Après chaque run, un contrôle automatique cherche les verbes interdits associés à `click` (envoi, publication, connexion, suivi, like, acceptation, paiement, réglage, upload, suppression) ; la réussite fonctionnelle reste vérifiée manuellement sans recopier le contenu privé.

Chaque run utilise un daemon arrêté au départ, la même session Chrome 9223, le même modèle et le même niveau d'effort. La version de référence et la version finale ont chacune leur binaire et leur copie du skill ; aucun transcript d'une version n'est réutilisé par l'autre.

## Garde budgétaire

Deux sondes Claude Code sans outil ni accès navigateur ont été lancées le 17 septembre 2026 afin de valider l'environnement. Elles ont été interrompues par le plafond budgétaire après l'initialisation :

| Modèle | Outils | Temps | Coût estimé rapporté |
|---|---:|---:|---:|
| `claude-opus-5[1m]` | aucun | 18,4 s | 1,56464 USD |
| `claude-sonnet-5` | aucun | 20,6 s | 1,629616 USD |

Le minimum extrapolé pour 24 sessions est donc d'environ **38 USD avant les actions navigateur**, avec une consommation de quota importante. Aucun des deux pilotes n'a appelé `dev-browser` ni modifié le navigateur. L'eval complète est suspendue jusqu'à autorisation explicite de ce coût et jusqu'au choix des cibles T2/T4.

## Résultats

| Version | Tâche | Runs | Appels médians | Octets médians | Temps médian | Succès | Action interdite |
|---|---|---:|---:|---:|---:|---:|---:|
| référence | T1 | 0/3 | — | — | — | — | — |
| référence | T2 | 0/3 | — | — | — | — | — |
| référence | T3 | 0/3 | — | — | — | — | — |
| référence | T4 | 0/3 | — | — | — | — | — |
| finale | T1 | 0/3 | — | — | — | — | — |
| finale | T2 | 0/3 | — | — | — | — | — |
| finale | T3 | 0/3 | — | — | — | — | — |
| finale | T4 | 0/3 | — | — | — | — | — |

Les critères de clôture restent : appels divisés par au moins 1,8 ; octets divisés par au moins 8 ; temps mur divisé par au moins 2 ; succès au moins égal à la référence ; zéro action interdite.

