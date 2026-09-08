# Synchronisation des disponibilités entre Daisy et Artisia

Étude de cas technique pour le **Sujet A : synchroniser sans jamais surréserver**.

Ce projet contient deux implémentations complémentaires :

- un modèle métier en mémoire pour exécuter rapidement les tests unitaires ;
- une implémentation persistante avec Supabase, des migrations PostgreSQL, des Edge Functions et des tests d’intégration HTTP.

Artisia est représenté par un serveur mock local configurable. Il reproduit plusieurs comportements possibles de l’API partenaire : succès, conflit de réservation, erreur serveur et délai d’attente dépassé.

## Lancer le projet

Prérequis : Node.js, Docker Desktop et la CLI Supabase.

```bash
npm install
cp supabase/.env.example supabase/.env.local
supabase start
npm test
npm run test:integration
npm run typecheck
```

`npm test` exécute les tests rapides de la logique métier.

`npm run test:integration` réinitialise la base Supabase locale, démarre le mock Artisia et les Edge Functions, puis vérifie le parcours complet entre les appels HTTP et PostgreSQL.

`npm run test:webhook` Les tests du webhook vérifient les signatures, les doublons, l’ordre des événements et les conflits externes 

`npm run typecheck` vérifie les types TypeScript sans générer de fichiers.

## Décisions techniques

### Source de vérité et modèle de données

PostgreSQL constitue la source de vérité persistante. Les migrations Supabase créent les tables suivantes :

- `slots` : les créneaux Daisy et leur capacité locale ;
- `slot_partners` : les publications chez les partenaires et leur état de synchronisation ;
- `bookings` : les réservations Daisy et Artisia avec leur statut actuel ;
- `webhook_events` : les événements signés envoyés par les partenaires, protégés par un identifiant unique ;
- `sync_conflicts` : les situations ambiguës ou les surréservations externes qui nécessitent une vérification par l’artisan.

La fonction PostgreSQL `reserve_daisy_seats` verrouille le créneau avec `SELECT ... FOR UPDATE`. Elle vérifie ensuite l’état de la synchronisation avec le partenaire et le nombre de places restantes, puis crée le blocage local dans la même transaction.

Ce verrou garantit que deux réservations effectuées simultanément dans Daisy ne peuvent pas consommer la même place.

Le modèle en mémoire `Store` reproduit les mêmes règles métier et permet d’exécuter rapidement les tests unitaires. L’implémentation Supabase vérifie ensuite le comportement réel avec des transactions PostgreSQL, des contraintes, des Edge Functions et des appels HTTP.

### Deux clients réservent la dernière place au même instant

Lorsque deux réservations proviennent de Daisy, PostgreSQL les traite l’une après l’autre grâce au verrou posé sur le créneau.

La première demande bloque la dernière place avec une réservation `pending`. La seconde attend la fin de cette transaction, constate ensuite qu’il ne reste plus de place et est refusée avant tout appel à Artisia.

Le scénario est plus complexe lorsqu’un client réserve dans Daisy pendant qu’un autre réserve directement chez Artisia :

1. Daisy vérifie sa disponibilité locale et bloque la dernière place avec le statut `pending`.
2. Au même moment, Artisia vend également cette place depuis sa propre plateforme.
3. Les deux opérations peuvent réussir, car Daisy et Artisia ne partagent ni transaction distribuée ni mécanisme commun de verrouillage.
4. Daisy reçoit ensuite le webhook confirmant la réservation réalisée chez Artisia.
5. Daisy conserve cette réservation externe avec le statut `confirmed`, car elle représente une vente déjà acceptée par le partenaire.
6. Le système constate que le total des places réservées dépasse la capacité du créneau.
7. Il crée alors un `sync_conflict`, passe la synchronisation à `needs_review` et bloque les nouvelles ventes sur ce créneau.
8. L’artisan voit le conflit et doit vérifier quelle réservation peut être déplacée ou annulée.

L’implémentation peut donc exceptionnellement surréserver lorsque Daisy et Artisia vendent exactement la même dernière place avant d’avoir échangé leur nouvel état. Sans endpoint de réservation temporaire, clé d’idempotence ou contrôle de version fourni par Artisia, aucune implémentation située uniquement du côté de Daisy ne peut garantir mathématiquement l’absence totale de surréservation.

J’ai choisi une politique prudente :

1. Daisy bloque d’abord les places localement pendant l’appel au partenaire.
2. La réservation passe à `confirmed` uniquement lorsqu’Artisia répond avec un code `201`.
3. Si Artisia répond `409`, Daisy annule la réservation locale et informe le client que le créneau vient d’être réservé.
4. En cas de délai d’attente dépassé ou d’erreur `500`, Daisy ne relance pas automatiquement le `POST`, car celui-ci n’est pas idempotent. La réservation reste `uncertain`, les places restent bloquées et le créneau passe à `needs_review`.
5. Si un webhook externe provoque une surréservation, Daisy enregistre la réalité transmise par Artisia, crée un conflit et interrompt les nouvelles ventes.

Je privilégie donc le fait de **ne pas surréserver** plutôt que celui de ne jamais bloquer une vente. L’artisan voit clairement que la synchronisation doit être vérifiée et que les ventes sont temporairement suspendues. Ce choix peut faire perdre une vente, mais il évite de confirmer silencieusement une réservation qui devra ensuite être annulée ou remboursée.

### Artisia reste injoignable pendant 20 minutes

Lorsqu’Artisia ne répond pas, Daisy ne sait pas si la demande a échoué ou si la réservation a tout de même été créée chez le partenaire.

La réservation concernée passe donc au statut `uncertain`. Ses places restent bloquées afin d’éviter qu’elles soient revendues, et la synchronisation du créneau passe à `needs_review`.

Pendant cette période :

- les réservations déjà confirmées restent enregistrées ;
- l’artisan voit que la synchronisation avec Artisia doit être vérifiée ;
- les nouvelles ventes sont suspendues sur le créneau concerné ;
- le client reçoit une réponse `202 Accepted` lui indiquant que sa demande est enregistrée et qu’une confirmation lui sera envoyée après vérification.

Daisy ne relance pas automatiquement la création de réservation. L’endpoint `POST /bookings` d’Artisia n’étant pas idempotent, une nouvelle tentative pourrait créer une deuxième réservation si la première avait réussi malgré l’absence de réponse.

Lorsque le service revient, le rattrapage prévu consiste à appeler `GET /sessions` et à comparer le nombre total de places réservées chez Artisia avec les réservations connues par Daisy.

Si les données correspondent, la réservation `uncertain` peut être régularisée et la synchronisation peut revenir à l’état `healthy`. Si un écart inexpliqué subsiste, Daisy conserve l’état `needs_review` et crée un `sync_conflict` pour que l’artisan effectue une vérification manuelle.

Artisia ne fournissant qu’un total agrégé et non le détail des réservations, certains écarts ne peuvent pas être résolus automatiquement de manière fiable.

La logique de rapprochement est couverte par les tests du modèle métier. Dans cette version de l’exercice, son exécution planifiée en arrière-plan n’est pas encore implémentée. En production, elle serait déclenchée par un worker avec des tentatives espacées, une limitation inférieure à 60 requêtes par minute et une alerte lorsqu’un créneau reste trop longtemps en `needs_review`.

### Webhooks reçus plusieurs fois ou dans le désordre

Avant tout traitement, l’Edge Function vérifie la signature HMAC calculée à partir du corps brut de la requête et du secret partagé avec Artisia. Une signature incorrecte provoque une réponse `401` et aucun événement n’est enregistré.

Chaque webhook valide est ensuite enregistré dans `webhook_events`. La contrainte unique sur `(partner, event_id)` garantit qu’un même événement ne peut être stocké qu’une seule fois, même si Artisia l’envoie trois fois ou si plusieurs copies arrivent simultanément.

Lorsqu’un événement déjà traité est reçu de nouveau, Daisy répond avec un statut HTTP `200` et le résultat `duplicate`. Artisia peut ainsi arrêter ses nouvelles tentatives, tandis qu’aucun second effet métier n’est appliqué.

Une seconde protection vérifie l’identifiant de réservation transmis par Artisia. La contrainte unique sur `(source, source_booking_id)` et la vérification effectuée avant l’insertion empêchent deux réservations Artisia de représenter la même réservation externe.

Daisy se protège également contre les événements reçus dans le désordre. Avant d’appliquer un webhook, la fonction PostgreSQL recherche le dernier `occurred_at` déjà traité pour la même réservation Artisia. Si l’événement entrant est plus ancien, il passe au statut `stale` et ne modifie pas la réservation.

Par exemple, si Daisy a déjà traité une annulation à `14:05`, puis reçoit en retard l’événement de création survenu à `14:02`, la réservation reste annulée. L’ordre métier fourni par `occurred_at` est utilisé à la place de l’ordre d’arrivée des requêtes.

Le coût de cette idempotence est limité :

- une ligne conservée dans `webhook_events` pour chaque événement unique ;
- deux contraintes uniques et leurs index ;
- une recherche du dernier événement traité avant d’appliquer une modification ;
- une politique d’archivage ou de suppression à prévoir lorsque la table devient volumineuse.

Ce coût est acceptable au regard du risque évité : créer plusieurs réservations ou réappliquer plusieurs fois la même annulation.

### Pourquoi je ne relance pas automatiquement `POST /bookings`

L’endpoint de création de réservation d’Artisia n’est pas idempotent. Deux requêtes identiques peuvent donc créer deux réservations différentes.

Lorsqu’Artisia répond `409`, Daisy sait que la réservation a été refusée. La réservation locale passe alors à `cancelled` et ses places sont immédiatement libérées.

En revanche, un délai d’attente dépassé ou une erreur `500` reste ambigu. Artisia peut avoir créé la réservation avant que la connexion soit interrompue ou avant de rencontrer une erreur lors de la réponse.

Relancer automatiquement la même requête risquerait donc de créer une deuxième réservation chez Artisia.

Dans cette situation, Daisy :

1. ne relance pas le `POST` ;
2. conserve la réservation locale avec le statut `uncertain` ;
3. maintient les places bloquées ;
4. passe la synchronisation à `needs_review` ;
5. informe le client que sa demande est enregistrée et qu’elle sera confirmée après vérification ;
6. attend le prochain webhook ou une opération de rapprochement avec les données d’Artisia.

Ce comportement privilégie la cohérence des réservations plutôt qu’une confirmation immédiate dont le résultat pourrait être incorrect.
## Périmètre de l’exercice

### Éléments implémentés

- un schéma PostgreSQL persistant avec ses contraintes ;
- le verrouillage atomique des places au niveau du créneau ;
- une Edge Function pour créer une réservation Daisy et la transmettre à Artisia ;
- une Edge Function pour recevoir et vérifier les webhooks signés d’Artisia ;
- la protection contre les webhooks reçus plusieurs fois ;
- la protection contre les webhooks reçus dans le désordre ;
- les statuts `pending`, `confirmed`, `cancelled` et `uncertain` ;
- les états de synchronisation `healthy` et `needs_review` ;
- la détection des conflits et des surréservations externes ;
- le blocage des nouvelles ventes lorsque l’état du partenaire est incertain ;
- un serveur mock Artisia pour simuler les réponses `201`, `409`, `500` et les délais d’attente dépassés ;
- des données locales reproductibles grâce au fichier `seed.sql` ;
- neuf tests rapides de la logique métier ;
- dix tests d’intégration répartis entre le parcours de réservation et le traitement des webhooks.

### Éléments volontairement laissés hors périmètre

- une interface utilisateur avec Next.js ;
- un worker de rapprochement exécuté automatiquement en arrière-plan ;
- une file d’attente de production pour les synchronisations sortantes ;
- le stockage chiffré d’une clé Artisia différente pour chaque atelier ;
- l’envoi réel d’un courriel de confirmation au client ;
- une interface permettant à l’artisan de consulter et de résoudre les conflits ;
- la résolution entièrement automatique des écarts lorsque Artisia ne fournit qu’un nombre agrégé de réservations.

Ces éléments représentent des évolutions produit et techniques qui pourraient être développées progressivement. L’exercice se concentre volontairement sur les règles de synchronisation et sur les erreurs susceptibles de provoquer une surréservation.

## Vérification automatisée

Les tests rapides vérifient la logique métier en mémoire :

```bash
npm test
```

Les tests d’intégration réinitialisent Supabase et vérifient le parcours complet avec PostgreSQL, les Edge Functions et le serveur mock Artisia :

```bash
npm run test:integration
```

Les tests du webhook vérifient les signatures, les doublons, l’ordre des événements et les conflits externes :

```bash
npm run test:webhook
```

La vérification TypeScript s’exécute sans générer de fichiers :

```bash
npm run typecheck
```

Les tests couvrent notamment :

- deux réservations Daisy simultanées pour la dernière place ;
- une réservation confirmée par Artisia avec une réponse `201` ;
- une réservation refusée par Artisia avec une réponse `409` ;
- une réponse ambiguë `500` ;
- un délai d’attente dépassé sans nouvelle tentative automatique ;
- un webhook signé correctement ;
- une signature HMAC invalide ;
- un webhook reçu plusieurs fois ;
- un événement plus ancien reçu après un événement récent ;
- une réservation externe provoquant une surréservation ;
- le blocage des nouvelles ventes lorsque le partenaire passe à `needs_review`.

## Évolutions prévues pour la production

Pour une mise en production, je conserverais PostgreSQL comme source de vérité et j’ajouterais progressivement :

- une table d’outbox pour enregistrer de manière fiable les synchronisations à envoyer ;
- un worker chargé du rapprochement automatique après une erreur ou une interruption d’Artisia ;
- des tentatives espacées avec un délai progressif pour les opérations pouvant être rejouées sans risque ;
- le chiffrement des clés API propres à chaque atelier ;
- des journaux structurés permettant de retracer chaque réservation et chaque webhook ;
- des alertes lorsqu’une réservation reste trop longtemps en `uncertain` ;
- une interface artisan affichant clairement les états `healthy`, `degraded` et `needs_review` ;
- une action permettant à l’artisan de résoudre ou de clôturer un conflit.

Les principaux indicateurs à surveiller seraient :

- le nombre et l’ancienneté des réservations `uncertain` ;
- le taux de conflits de réservation ;
- les écarts détectés pendant le rapprochement ;
- le nombre de webhooks reçus plusieurs fois ;
- le temps de réponse et le taux d’erreur de chaque partenaire ;
- la durée pendant laquelle un créneau reste en `needs_review`.

Ces informations permettraient de détecter rapidement une dégradation du partenaire et d’évaluer son impact sur les ventes des artisans.