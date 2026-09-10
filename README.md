# Synchronisation des disponibilités entre Daisy et Artisia

Étude de cas technique pour le **Sujet A : synchroniser sans surréserver**.

Ce projet contient deux implémentations complémentaires :

- un modèle métier en mémoire pour exécuter rapidement les tests unitaires ;
- une implémentation persistante utilisant Supabase, des migrations PostgreSQL, des Edge Functions et des tests d’intégration HTTP.

Artisia est représenté par un serveur simulé local configurable qui reproduit les réservations réussies, les conflits de réservation, les erreurs serveur et les dépassements du délai d’attente.

## Démarrage

Prérequis : Node.js, Docker Desktop et la CLI Supabase.

```bash
npm install
cp supabase/.env.example supabase/.env.local
supabase start
npm test
npm run test:integration
npm run test:webhook
npm run typecheck
```

`npm test` exécute les tests rapides de la logique métier. Ils ne nécessitent ni Docker ni Supabase.

`npm run test:integration` réinitialise la base Supabase locale, démarre le serveur simulé Artisia et l’Edge Function de réservation, puis vérifie le parcours de réservation des requêtes HTTP jusqu’à PostgreSQL.

`npm run test:webhook` vérifie les signatures, les réceptions en double, l’ordre des événements et les conflits externes.

Les deux suites d’intégration réinitialisent la base locale et effacent ses données de test. Les exécuter successivement, car elles partagent la même base.

`npm run typecheck` vérifie `src/` et les tests TypeScript sans générer de fichiers. Cette commande ne vérifie pas les Edge Functions Deno dans `supabase/functions/` ; la CI exécute également `deno check` sur les trois fonctions.

## Utiliser les API en local

Après avoir installé les dépendances et démarré Supabase comme indiqué ci-dessus, lancer le serveur simulé dans un terminal :

```bash
node scripts/artisia-mock.mjs
```

Dans un deuxième terminal, démarrer les deux fonctions avec la configuration locale :

```bash
supabase functions serve --no-verify-jwt --env-file supabase/.env.local
```

Ce mode de démonstration désactive la vérification JWT, comme les tests de réservation. Le webhook conserve la vérification de sa signature HMAC. Arrêter ces deux processus avant de lancer les tests d’intégration, qui démarrent leurs propres services.

### Configuration

| Variable | Utilisation dans cette démonstration |
| --- | --- |
| `ARTISIA_BASE_URL` | `http://host.docker.internal:4010/v1`, pour joindre le serveur simulé depuis Docker |
| `ARTISIA_API_KEY` | `test-api-key`, valeur attendue par le serveur simulé local |
| `ARTISIA_WEBHOOK_SECRET` | `test-secret`, secret HMAC local |
| `ARTISIA_RECOVERY_TOKEN` | Jeton serveur exigé par la fonction de rapprochement ; `test-recovery-token` en local |
| `SUPABASE_URL` | URL fournie à l’environnement d’exécution local des Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé serveur fournie à l’environnement local, utilisée par les fonctions pour accéder à PostgreSQL |

Les trois variables Artisia sont définies dans `supabase/.env.example` ; copier ce fichier dans `supabase/.env.local`. Ces valeurs de démonstration correspondent au serveur simulé, pas à un compte Artisia réel.

### Créer une réservation Daisy

`POST /functions/v1/create-daisy-booking` attend un objet JSON contenant `slotId` (UUID d’un créneau existant), `seats` (entier positif), `customerName` et `customerEmail` (chaînes non vides). La validation actuelle est minimale et ne vérifie pas le format de l’adresse courriel.

Le créneau créé par les données d’initialisation contient huit places et est lié à la session `art_ses_8812` :

```bash
curl -i http://127.0.0.1:54321/functions/v1/create-daisy-booking \
  -H 'Content-Type: application/json' \
  --data '{"slotId":"11111111-1111-1111-1111-111111111111","seats":1,"customerName":"Camille Example","customerEmail":"camille@example.com"}'
```

| Code HTTP Daisy | Réponse / signification |
| --- | --- |
| `200` | `{"status":"confirmed","bookingId":"<UUID Daisy>"}` après une réponse `201` d’Artisia |
| `202` | `{"status":"uncertain","message":"…"}` : les places restent bloquées en attendant une vérification |
| `409` | `{"error":"Not enough seats"}` si la capacité locale est insuffisante, ou `{"status":"cancelled","message":"…"}` après un refus d’Artisia |
| `503` | `{"status":"unavailable","message":"…"}` lorsque la publication partenaire empêche une nouvelle vente |
| `400` | `{"error":"…"}` : corps invalide ou échec de la réservation locale |
| `405` | Méthode non prise en charge (`OPTIONS` est accepté pour CORS) |
| `500` | Échec de l’enregistrement de la confirmation après acceptation par le partenaire |

Une réponse `202` ne garantit pas l’envoi ultérieur d’un courriel : le rapprochement détecte les écarts, mais l’envoi des confirmations n’est pas implémenté. Le parcours n’expose aucune clé d’idempotence client ; répéter la requête peut créer une autre réservation.

### Envoyer un webhook signé

`POST /functions/v1/artisia-webhook` attend `event_id`, `type`, `occurred_at` et `data`. Les types pris en charge sont `booking.created`, `booking.cancelled` et `session.updated`. Fournir `data.session_id` et, pour les événements de réservation, `data.booking_id`. Pour une création, fournir également `data.seats` (entier positif) ; `data.customer` est facultatif. Les mises à jour de session utilisent les champs `capacity`, `booked` et `status` dans `data`.

L’en-tête `X-Artisia-Signature` contient `sha256=` suivi du HMAC-SHA256 du corps brut, au format hexadécimal en minuscules. Le corps transmis doit correspondre exactement au corps signé, espaces et retours à la ligne compris. Exécuter cet exemple dans un troisième terminal avec le secret du fichier d’environnement d’exemple :

```bash
node --input-type=module <<'JS'
import { createHmac } from 'node:crypto';
const body = JSON.stringify({
  event_id: 'evt_demo_001',
  type: 'booking.created',
  occurred_at: '2026-09-10T12:00:00Z',
  data: { session_id: 'art_ses_8812', booking_id: 'art_demo_001', seats: 1 }
});
const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
const result = await fetch('http://127.0.0.1:54321/functions/v1/artisia-webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Artisia-Signature': signature },
  body
});
console.log(result.status, await result.json());
JS
```

La première exécution sur une base fraîchement initialisée renvoie `200` avec `{"status":"processed"}` ; répéter cet événement renvoie `{"status":"duplicate"}`. Les autres résultats métier possibles sous HTTP `200` sont `stale` et `ignored`. Une session inconnue produit `failed` avec HTTP `503`, afin de demander une nouvelle livraison. Une surréservation externe reste `processed`, avec un conflit enregistré en base.

Une signature absente ou incorrecte donne `401` ; un JSON ou une enveloppe d’événement invalide donne `400` ; une méthode autre que POST donne `405`. Un secret absent, une erreur de persistance ou une erreur d’exécution SQL donne `500`. La validation vérifie aussi les identifiants, la date, les nombres de places et les champs de session fournis. Elle ne valide pas le format du courriel client.

## Décisions techniques

### Source de vérité et modèle de données

PostgreSQL constitue la source de vérité persistante. Les migrations Supabase créent les tables suivantes :

- `slots` : les créneaux Daisy et leur capacité locale ;
- `slot_partners` : les publications chez les partenaires et leur état de synchronisation ;
- `bookings` : les réservations Daisy et Artisia avec leur statut actuel ;
- `webhook_events` : les événements signés des partenaires, protégés par un identifiant unique ;
- `sync_conflicts` : les conflits de surréservation externe nécessitant une vérification par le responsable de l’atelier.

La fonction PostgreSQL `reserve_daisy_seats` verrouille le créneau avec `SELECT ... FOR UPDATE`. Elle vérifie la synchronisation du partenaire et la capacité restante, puis crée le blocage local dans la même transaction.

Ce verrou empêche deux réservations Daisy simultanées de consommer la même place.

Le modèle en mémoire `Store` illustre les principales règles métier et permet des tests unitaires rapides. Il ne reproduit pas exactement l’implémentation Supabase. Les parcours persistants décrits ci-dessous correspondent aux migrations et aux Edge Functions.

### Organisation du code et différences entre les implémentations

| Emplacement | Rôle |
| --- | --- |
| `src/sync.ts` | Prototype métier : réservations, webhooks et rapprochement manuel |
| `src/store.ts` | État en mémoire et file d’attente par créneau |
| `src/partner.ts` | Contrat partenaire et simulation en mémoire |
| `src/types.ts` | Types du prototype |
| `supabase/migrations/` | Tables, contraintes et opérations transactionnelles ; `0004` remplace la fonction de réservation de `0002` |
| `supabase/functions/` | Points d’entrée HTTP et appels au partenaire |
| `scripts/reconcile-artisia.mjs` | Processus périodique de rapprochement, ou exécution unique avec `--once` |
| `scripts/artisia-mock.mjs` | Serveur HTTP simulé utilisé par les tests d’intégration |
| `tests/` | Tests du prototype et des parcours persistants |

| Situation | Prototype en mémoire | Implémentation Supabase |
| --- | --- | --- |
| Refus d’Artisia avec `409` | Supprime la réservation et lève une erreur | Conserve la réservation en `cancelled`, renvoie `409` |
| Résultat partenaire ambigu | Conserve `uncertain` et lève une erreur | Conserve `uncertain`, renvoie `202` |
| Réservation externe dépassant la capacité | Enregistre un conflit sans insérer la réservation externe | Insère la réservation `confirmed`, puis enregistre le conflit |
| Verrouillage | Limité à une instance de `Store` ; maintenu pendant l’appel partenaire | Verrou PostgreSQL pendant la transaction de blocage local ; l’appel HTTP intervient ensuite |
| `session.updated` | Enregistre l’événement sans mettre à jour la publication | Actualise les champs de publication fournis dans le webhook |
| Rapprochement | Méthode `reconcile()` appelable manuellement, sans confirmation automatique des cas incertains | Fonction `reconcile-artisia`, script périodique, écarts et délais de reprise persistants |

Les tests du prototype ne suffisent pas à valider les garanties PostgreSQL : les deux suites d’intégration doivent également être exécutées.

### Deux clients réservent la dernière place simultanément

Lorsque les deux réservations proviennent de Daisy, PostgreSQL les traite successivement grâce au verrou sur le créneau.

La première demande bloque la dernière place avec une réservation `pending`. La seconde attend la fin de cette transaction, constate qu’il ne reste plus de place et est refusée avant tout appel à Artisia.

Le scénario est plus complexe lorsqu’un client réserve dans Daisy pendant qu’un autre réserve directement chez Artisia :

1. Daisy vérifie sa disponibilité locale et bloque la dernière place en `pending`.
2. Au même moment, Artisia vend cette place depuis sa propre plateforme.
3. Les deux opérations peuvent réussir, car les plateformes ne partagent ni transaction distribuée ni verrou commun.
4. Daisy reçoit ensuite le webhook confirmant la réservation directe chez Artisia.
5. Daisy enregistre cette réservation externe en `confirmed`, car elle représente une vente déjà acceptée par le partenaire.
6. Le système détecte que le total des places réservées dépasse la capacité.
7. Il crée un `sync_conflict`, passe la synchronisation à `needs_review` et bloque les nouvelles ventes sur ce créneau.
8. Le responsable de l’atelier doit déterminer quelle réservation peut être déplacée ou annulée. Une interface dédiée à la vérification des conflits reste hors du périmètre de l’exercice.

Une surréservation peut donc survenir lorsque les deux plateformes vendent la même dernière place avant d’avoir échangé leur nouvel état. Sans mécanisme partagé de réservation ou de gestion de la concurrence fourni par Artisia, Daisy ne peut pas garantir seule que cela n’arrivera jamais. Une clé d’idempotence empêcherait les requêtes en double, mais ne coordonnerait pas à elle seule les ventes indépendantes des deux plateformes.

J’ai choisi une politique prudente :

1. Daisy bloque les places localement avant d’appeler le partenaire.
2. La réservation Daisy transmise au partenaire passe en `confirmed` uniquement lorsqu’Artisia renvoie `201`.
3. Un `409` d’Artisia annule la réservation locale et informe le client que le créneau n’est plus disponible.
4. Un dépassement du délai d’attente ou un `500` ne déclenche aucune nouvelle tentative automatique du POST non idempotent. La réservation reste `uncertain`, les places restent bloquées et la synchronisation passe à `needs_review`.
5. Un webhook externe provoquant une surréservation entraîne l’enregistrement de la vente acceptée par le partenaire, la création d’un conflit et l’arrêt des nouvelles ventes.

Cette politique réduit le risque de surréservation et suspend les nouvelles ventes dès qu’une incertitude est détectée. Elle n’élimine pas la concurrence entre plateformes indépendantes. L’état de synchronisation enregistré permet une vérification ; son affichage au responsable de l’atelier nécessite l’interface prévue. Bloquer des places peut faire perdre une vente, mais évite de confirmer silencieusement une réservation incertaine.

### Artisia reste injoignable pendant 20 minutes

Lorsqu’Artisia ne répond pas, Daisy ne sait pas si la demande a échoué ou si le partenaire a créé la réservation avant la perte de connexion.

La réservation passe en `uncertain`. Ses places restent bloquées pour empêcher leur revente, et la synchronisation passe à `needs_review`.

Pendant cette période :

- les réservations déjà confirmées restent enregistrées ;
- l’état de synchronisation enregistré indique qu’une vérification est nécessaire ;
- les nouvelles ventes sur le créneau concerné sont suspendues ;
- le client reçoit `202 Accepted`, indiquant que sa demande est en attente de vérification.

Daisy ne relance pas automatiquement la création de réservation. Le POST de réservation d’Artisia n’est pas idempotent : une nouvelle tentative pourrait créer une deuxième réservation si la première avait réussi sans renvoyer de réponse.

Le processus de reprise implémenté appelle `GET /sessions`, sans supposer l’existence d’un endpoint de changements par lot. Il compare les totaux et la capacité du partenaire avec les réservations connues et la capacité Daisy. Un écart crée un conflit `aggregate_discrepancy`, met à jour les valeurs observées et bloque les nouvelles ventes. Il n’invente pas les réservations absentes du webhook : l’API ne fournit pas leur détail.

Une réservation `pending` ou `uncertain` maintient le créneau en vérification et crée un conflit `uncertain_booking`, **même si les totaux correspondent**. Un résultat agrégé ne permet pas de connaître l’identité des réservations acceptées. Le modèle en mémoire suit maintenant cette même règle prudente.

En l’absence d’incertitude, si les totaux et capacités correspondent, que la session est publiée et qu’aucun autre conflit ouvert ne subsiste, le rapprochement peut rétablir `healthy`. Les conflits de rapprochement résolus sont clôturés, mais un conflit de surréservation ne disparaît pas sur une simple égalité des totaux. Si des réservations ou webhooks ont modifié le créneau pendant le GET, la comparaison est reportée grâce à une version locale. Les horodatages Artisia ne sont comparés qu’à d’autres horodatages Artisia.

Le script de reprise doit être lancé pour assurer ce suivi. Il appelle la fonction toutes les minutes. PostgreSQL conserve les échéances, les erreurs et la dernière réussite ; redémarrer le script ne réinitialise pas ces informations. Après une erreur de lecture, les publications encore saines passent en `degraded` et les nouvelles ventes sont suspendues. Le délai augmente de 1 à 2, 4, 8, 16 puis 20 minutes au maximum. Un `429` reporte la lecture à la prochaine minute pleine. Aucun de ces mécanismes ne rejoue le POST de réservation.

La panne prolongée est testée en avançant l’état de planification persistant, sans attendre réellement vingt minutes. Le retour du service reprend les lectures ; les cas ambigus restent à résoudre par une vérification humaine. L’interface artisan et les alertes automatiques restent hors périmètre.

### Lancer et exploiter le rapprochement

Copier la configuration locale mise à jour, puis servir les fonctions. La valeur d’exemple du jeton est réservée aux tests locaux :

```bash
supabase functions serve --no-verify-jwt --env-file supabase/.env.local
```

Dans un autre terminal, lancer une vérification unique :

```bash
ARTISIA_RECOVERY_TOKEN=test-recovery-token node scripts/reconcile-artisia.mjs --once
```

Ou laisser tourner le processus périodique :

```bash
ARTISIA_RECOVERY_TOKEN=test-recovery-token node scripts/reconcile-artisia.mjs
```

`SUPABASE_URL` permet de viser un autre serveur. Le jeton `ARTISIA_RECOVERY_TOKEN` doit être identique dans l’environnement de la fonction et celui du script. Le point d’entrée `POST /functions/v1/reconcile-artisia` exige ce jeton serveur dans `Authorization: Bearer ...`, même si la vérification JWT de la passerelle est désactivée. En production, utiliser un secret propre au déploiement et un superviseur de processus ou un ordonnanceur ; ce dépôt ne déploie pas ce service automatiquement.

La fonction renvoie `checked` après une lecture, `deferred` si une échéance ou le budget empêche l’appel, et `retry_scheduled` après une erreur. Elle retraitera aussi jusqu’à dix événements persistés mais non traités à chaque passage, indépendamment des nouvelles livraisons d’Artisia. Les tables `artisia_recovery`, `sync_conflicts` et les colonnes `last_known_*` permettent de consulter l’état réel. Un webhook perdu avant toute réception est détectable comme écart agrégé, pas reconstructible individuellement.

### Budget d’appels et réponses lentes

Le POST accepte une réponse valide après 4 ou 6 secondes ; son délai maximal reste de 7 secondes. Les deux succès lents sont testés. Un dépassement ou un `500` conserve une réservation incertaine.

Tous les appels sortants passent par un budget PostgreSQL partagé : au plus 60 appels par minute pleine et par empreinte SHA-256 de clé API. La clé elle-même n’est pas stockée dans cette table. Si le budget local est épuisé avant l’envoi, Daisy libère le blocage local et renvoie `503`. Après un `429` réellement reçu sur le POST, Daisy conserve prudemment `uncertain`, ne retente pas la réservation et suspend les appels utilisant cette clé jusqu’à la minute suivante.

Le déploiement d’exercice utilise toujours une seule clé et un seul secret d’atelier dans l’environnement. Le budget distingue les clés, mais la sélection de plusieurs comptes atelier dans un même déploiement reste à développer. La synchronisation complète avec plusieurs partenaires n’est pas revendiquée.

### Webhooks reçus plusieurs fois ou dans le désordre

Avant le traitement, l’Edge Function vérifie la signature HMAC à partir du corps brut de la requête et du secret partagé avec Artisia. Une signature incorrecte renvoie `401` sans enregistrer d’événement.

Les événements valides sont stockés dans `webhook_events`. La contrainte unique sur `(partner, event_id)` empêche le stockage d’un même événement plusieurs fois, y compris lors de réceptions simultanées en double.

Lorsqu’un événement déjà traité arrive de nouveau, Daisy renvoie HTTP `200` avec `duplicate`, accusant réception sans appliquer une seconde fois l’effet métier.

Une deuxième protection vérifie l’identifiant de réservation Artisia. La contrainte unique sur `(source, source_booking_id)` et la vérification avant insertion empêchent la création de plusieurs enregistrements Artisia pour une même réservation externe.

Pour l’ordre des événements, la fonction PostgreSQL recherche le dernier `occurred_at` traité pour la même réservation Artisia. Cette recherche intervient après acquisition du verrou du créneau, pour observer les événements concurrents déjà validés. Un événement plus ancien passe en `stale`. À horodatage égal, l’annulation est prioritaire sur la création ; un autre événement égal est ignoré comme ancien.

Par exemple, si Daisy a traité une annulation à `14:05` puis reçoit un événement de création datant de `14:02`, la réservation reste annulée. L’heure métier de l’événement est utilisée à la place de l’ordre d’arrivée des requêtes.

Le coût de ce mécanisme d’idempotence est limité :

- une ligne enregistrée par événement webhook unique ;
- deux contraintes uniques et leurs index ;
- une recherche du dernier événement traité avant d’appliquer une modification ;
- une politique d’archivage ou de suppression à prévoir lorsque la table d’événements grossit.

Ce coût se justifie par la prévention des réservations en double et des effets d’annulation répétés.

### Réservation Daisy et webhook de la même vente

Si le webhook arrive après la réponse `201`, l’identifiant Artisia déjà enregistré permet d’ignorer le second enregistrement de la vente. S’il arrive avant la réponse, le webhook ne contient aucun `external_ref` Daisy : il est conservé comme réservation externe, avec un conflit d’identité tant que la réservation Daisy est en cours ou incertaine.

Lorsque la réponse du POST fournit exactement le même identifiant Artisia et le même nombre de places, la transaction rattache la ligne externe à la réservation Daisy via `merged_into`. La ligne externe reste dans l’historique avec un statut local `cancelled`, afin de ne plus consommer de places ; **aucun DELETE ni aucune demande d’annulation n’est envoyé à Artisia**. Une annulation réelle déjà reçue reste prioritaire et ne peut pas être écrasée par le `201` retardé. Si la réponse n’arrive jamais, aucune identité n’est déduite du nom, du courriel ou du nombre de places : les places restent bloquées et l’ambiguïté reste visible en base.

### Acquittement sous cinq secondes

Les opérations de base du webhook partagent une échéance de 3,5 secondes et le traitement SQL limite l’attente de verrou à 1,5 seconde. Sous contention, la fonction renvoie une erreur permettant une nouvelle livraison plutôt qu’une fausse confirmation. Un événement déjà enregistré reste disponible pour le traitement périodique. Les tests mesurent ce comportement sous verrou bloqué ; ils ne constituent pas une garantie de latence réseau dans toutes les conditions de production.

### Compromis : suspendre une vente plutôt qu’aggraver une incertitude

Je privilégie la prévention des surréservations, en suspendant les ventes dès que la disponibilité est incertaine. Cela ne garantit pas l’absence absolue de course entre Daisy et Artisia. L’artisan peut perdre une vente pendant la vérification, mais une annulation ultérieure peut aussi lui coûter la commission non remboursée et la confiance du client.

Le message prévu pour l’artisan serait : « La synchronisation nécessite une vérification. Les ventes sont temporairement suspendues pour éviter de revendre des places potentiellement déjà prises. » L’état existe en base ; l’interface qui affichera ce message reste à construire.

### Pourquoi je ne relance pas automatiquement le POST de réservation

Le point d’entrée de création de réservation d’Artisia n’est pas idempotent. Deux requêtes identiques peuvent créer deux réservations différentes.

Un `409` refuse explicitement la demande : Daisy passe donc la réservation locale en `cancelled` et libère ses places.

Un dépassement du délai d’attente ou un `500` reste ambigu : Artisia peut avoir créé la réservation avant la perte de connexion ou une erreur lors de la réponse. Répéter la requête pourrait créer une autre réservation.

Dans cette situation, Daisy :

1. ne relance pas le POST ;
2. conserve la réservation locale en `uncertain` ;
3. maintient ses places bloquées ;
4. passe la synchronisation à `needs_review` ;
5. informe le client que sa demande nécessite une vérification.

Le rapprochement persistant détecte les écarts et conserve les ambiguïtés pour vérification. L’envoi de courriels et une interface de résolution manuelle ne sont pas implémentés.

## Périmètre de l’exercice

### Éléments implémentés

- Un schéma PostgreSQL persistant avec ses contraintes.
- La réservation locale atomique des places grâce à un verrou sur le créneau.
- Une Edge Function qui crée une réservation Daisy et la transmet à Artisia.
- Une Edge Function qui reçoit et vérifie les webhooks signés d’Artisia.
- La protection contre les webhooks en double et les vérifications d’ordre fondées sur l’horodatage.
- Les statuts de réservation : `pending`, `confirmed`, `cancelled` et `uncertain`.
- Les états de synchronisation utilisés par les parcours : `healthy` et `needs_review`.
- La détection des surréservations externes et l’enregistrement des conflits.
- Le blocage des nouvelles ventes lorsque l’état du partenaire est incertain.
- Un serveur HTTP Artisia simulant `201`, `409`, `500` et les dépassements du délai d’attente.
- Des données locales reproductibles grâce à `seed.sql`.
- Neuf tests rapides de la logique métier.
- Des tests d’intégration couvrant les réservations, les webhooks, le rapprochement et la limitation des appels.

### Éléments volontairement hors périmètre

- Une interface utilisateur Next.js.
- Le déploiement et la supervision du processus de rapprochement en production.
- Une file d’attente de production pour la synchronisation sortante.
- Le stockage chiffré d’une clé Artisia distincte pour chaque atelier.
- L’envoi réel des courriels de confirmation aux clients.
- Une interface permettant aux responsables d’atelier de consulter et de résoudre les conflits.
- La résolution entièrement automatique lorsqu’Artisia ne fournit que des totaux agrégés de réservations.

Ces éléments constituent des évolutions produit et techniques possibles. L’exercice se concentre sur les règles de synchronisation et les défaillances susceptibles de provoquer une surréservation.

## Vérification automatisée

Consulter le [tableau de couverture des scénarios](docs/scenario-coverage.md) pour connaître les comportements testés et les limites restantes.

Exécuter les tests rapides de la logique métier en mémoire :

```bash
npm test
```

Exécuter les tests d’intégration de réservation, qui réinitialisent Supabase et vérifient PostgreSQL, l’Edge Function et le serveur HTTP Artisia simulé :

```bash
npm run test:integration
```

Exécuter les tests d’intégration des webhooks pour les signatures, les doublons, l’ordre des événements et les conflits externes :

```bash
npm run test:webhook
```

Vérifier TypeScript sans générer de fichiers :

```bash
npm run typecheck
```

La couverture comprend notamment :

- les demandes Daisy simultanées pour la dernière place ;
- la confirmation après un `201` d’Artisia ;
- le refus après un `409` d’Artisia ;
- une réponse ambiguë `500` ;
- un dépassement du délai d’attente sans nouvelle tentative automatique ;
- les signatures HMAC valides et invalides ;
- les réceptions de webhooks en double ;
- un événement ancien reçu après un événement plus récent ;
- une réservation externe dépassant la capacité du créneau ;
- le blocage des nouvelles ventes lorsque le partenaire nécessite une vérification.

## Améliorations prévues pour la production

Je conserverais PostgreSQL comme source de vérité et j’ajouterais progressivement :

- une table d’envoi différé, ou *outbox*, pour enregistrer de manière fiable les opérations de synchronisation sortante ;
- la supervision du processus de rapprochement déjà fourni ;
- des nouvelles tentatives avec un délai croissant pour les opérations pouvant être rejouées sans risque ;
- le chiffrement des clés API propres à chaque atelier ;
- des journaux structurés retraçant chaque réservation et chaque webhook ;
- des alertes pour les réservations restant trop longtemps en `uncertain` ;
- une interface atelier affichant `healthy`, `degraded` et `needs_review` ;
- une action permettant au responsable de l’atelier de résoudre ou de clôturer un conflit.

Les principaux indicateurs à surveiller seraient :

- le nombre et l’ancienneté des réservations `uncertain` ;
- le taux de conflits de réservation ;
- les écarts détectés pendant le rapprochement ;
- les réceptions de webhooks en double ;
- les temps de réponse et les taux d’erreur du partenaire ;
- la durée pendant laquelle chaque créneau reste en `needs_review`.

Ces indicateurs aideraient à détecter une dégradation du partenaire et à évaluer son impact sur les ventes des ateliers.
