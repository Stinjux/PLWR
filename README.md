# PLWR – agenda, objectifs et budget

Application personnelle (PWA) qui réunit l’agenda, les objectifs et le budget. Pensée pour le téléphone (navigation en bas, actions à une main), agréable sur ordinateur (navigation latérale, vue semaine). Français canadien, dollar canadien, fuseau `America/Toronto`.

## Architecture

| Couche | Choix | Pourquoi |
|---|---|---|
| Interface | React 19 + Vite, PWA (manifeste + service worker) | Installable sur l’écran d’accueil ; requis par iOS pour les notifications |
| Serveur | Node.js ≥ 22.18 (TypeScript exécuté nativement), Hono | Un seul processus, pas d’étape de compilation côté serveur |
| Données | SQLite intégré (`node:sqlite`), fichier dans `DATA_DIR` | Aucune base externe à gérer ; sauvegarde = copier un fichier |
| Authentification | Courriel + mot de passe (scrypt), session en cookie `HttpOnly`/`SameSite=Lax`, en-tête anti-CSRF, limitation des tentatives | Inscriptions fermées après le premier compte ; les personnes invitées entrent par un lien signé (HMAC) |
| Lecture d’images | Claude (`claude-opus-5-5`) appelé **depuis le serveur** via le SDK Anthropic ; secours `local` (OCR Tesseract hors ligne) | La clé ne quitte jamais le serveur |
| Confidentialité des images | OCR local → numéros de carte masqués en noir **avant** l’envoi ; métadonnées (GPS) retirées ; images servies seulement au propriétaire ; supprimées après validation | |
| Rappels | Web Push (VAPID) + planificateur côté serveur toutes les 30 s | Livrés même quand l’app est fermée (voir limites) |

```
server/
  app.ts               routes API
  services/events.ts   agenda, récurrences, exceptions d'occurrence
  services/sharing.ts  agenda partagé : accès, invitations, « Occupé », participants
  services/google.ts   synchronisation Google Agenda (OAuth, import, envoi)
  services/outlook.ts  synchronisation Outlook (Microsoft Graph)
  services/onboarding.ts accueil (profil, dépenses mensuelles, épargne) et cloche
  services/planner.ts  « Réorganiser ma journée »
  services/goals.ts    progression, historique semaine/mois
  services/budget.ts   enveloppes, transactions, ventilations, catégorisation, doublons
  services/expenseParser.ts  compréhension des phrases en français
  services/chat.ts     chatbot (une question ciblée à la fois)
  services/drafts.ts   fiches à valider (confirmation idempotente)
  services/imports.ts  import photo/capture : normalisation, empreintes, masquage, extraction
  services/reminders.ts rappels, heures silencieuses, Web Push, « Reporter »
  vision/              fournisseurs de lecture d'images + OCR local
web/src/               interface React (pages Aujourd’hui, Agenda, Objectifs, Budget, Réglages)
web/public/sw.js       service worker (push, action Reporter, hors ligne)
tests/e2e/             parcours vérifiés avec Playwright
server/tests/          tests unitaires
```

## Installation

Prérequis : **Node.js 22.18 ou plus récent** (pour SQLite intégré et l’exécution directe du TypeScript).

```bash
npm install
```

```bash
cp .env.example .env
```

Remplis au minimum `APP_SECRET`, puis `ANTHROPIC_API_KEY` (lecture d’images) et les clés VAPID (notifications) :

```bash
npm run vapid
```

Copie les deux lignes affichées dans `.env`. Ensuite :

```bash
npm run build
```

```bash
npm start
```

Ouvre http://localhost:3000. Le premier compte créé devient le tien ; les inscriptions se ferment ensuite (`ALLOW_SIGNUP=false`). Coche « Ajouter quelques exemples » pour voir l’app remplie ; un bouton **Réglages → Supprimer les exemples** les retire en un clic.

### Développement

```bash
npm run dev
```

(serveur sur le port 3000 avec rechargement + Vite sur http://localhost:5173 avec proxy `/api`). Le service worker n’est actif que sur la version compilée (`npm start`).

### Tests

```bash
npm test
```

```bash
npm run e2e
```

Les tests E2E démarrent un serveur isolé (`tests/.data`, fournisseur d’images `local`) et pilotent l’interface sur un téléphone Android émulé.

### Mise en ligne sur Railway

Le dépôt contient `railway.json` (build `npm run build`, démarrage `npm start`, vérification de santé sur `/api/auth/status`, une seule instance).

1. **New Project → Deploy from GitHub repo** → choisir ce dépôt.
2. **Volume (obligatoire)** : clic droit sur le service → *Attach Volume* → point de montage `/data`. Railway fournit alors `RAILWAY_VOLUME_MOUNT_PATH`, que l’app utilise automatiquement pour la base SQLite et les images temporaires. Sans volume, **toutes les données sont perdues à chaque déploiement** (un avertissement s’affiche dans les journaux).
3. **Domaine** : *Settings → Networking → Generate Domain*, port **3000** (et ajoute `PORT=3000` dans les variables). L’URL HTTPS est détectée via `RAILWAY_PUBLIC_DOMAIN` (ou fixe `APP_URL` si tu utilises un domaine personnalisé).
4. **Variables** : onglet *Variables → Raw Editor*, coller puis remplir :

```
PORT=3000
APP_SECRET=
ANTHROPIC_API_KEY=
VISION_PROVIDER=anthropic
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:ton-courriel@exemple.ca
ALLOW_SIGNUP=false
DEFAULT_TIMEZONE=America/Toronto
```

   - `APP_SECRET` : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` : `npm run vapid` en local, une seule fois. **Ne les change plus ensuite** : les téléphones déjà abonnés devraient se réabonner.
   - Inutile de définir `DATA_DIR`, `APP_URL`, `COOKIE_SECURE` ou `NODE_ENV` : l’app détecte Railway (cookies `Secure`, volume, domaine).
   - Colle les clés VAPID **sans guillemets ni espaces**. Une clé invalide n’empêche plus l’app de démarrer : le push est alors désactivé et Réglages affiche la raison.
5. Déployer, ouvrir l’URL, **créer ton compte tout de suite** (le premier compte ferme les inscriptions), puis Réglages → Activer les notifications → Envoyer une notification de test.

Garde **une seule instance** (`numReplicas: 1`) : SQLite et le planificateur de rappels sont prévus pour un seul processus, qui doit tourner en continu (désactive toute mise en veille de type *App Sleeping*, sinon les rappels ne partent pas). Sauvegarde : télécharger `/data/plwr.sqlite` (ou activer les sauvegardes du volume Railway).

### Autre hébergeur

Il faut **HTTPS** (notifications, installation sur iPhone, cookies `Secure`) et un disque persistant : monter un volume sur `DATA_DIR`, définir `NODE_ENV=production`, `APP_URL`, `APP_SECRET`, `COOKIE_SECURE=true`.

## Fonctionnalités

**Aujourd’hui** – prochain rendez-vous, 3 priorités (★ pour choisir, sinon les plus urgentes), tâches du jour, objectifs à cocher, nombre de dépenses en attente, alerte de surcharge, boutons Tâche / Événement / Dépense. « Dépense » ouvre le chatbot avec le champ prêt à écrire.

**Agenda** – vues jour et semaine ; glisser la poignée ⋮⋮ pour déplacer (aussi d’un jour à l’autre en vue semaine), tirer le bas du bloc pour la durée ; événements récurrents (jour, semaine avec jours choisis, mois, date de fin) avec « cette occurrence / toute la série ». Rendez-vous fixes (bleu, plein) et tâches flexibles (vert, pointillé) avec durée estimée, échéance, priorité, plage préférée. Bouton « Se prolonge +15/+30/+45 » sur un rendez-vous, puis **Réorganiser ma journée** : proposition respectant les fixes, les pauses choisies et un battement entre blocs, aperçu avant/après, acceptation ligne par ligne, tâches qui ne rentrent pas avec un autre créneau proposé (jours suivants) ou « demain, à placer ».

**Accueil (onboarding)** – après la création du compte, en trois étapes :
1. **Profil, obligatoire** : prénom, âge, profession et salaire (par année, par mois, aux 2 semaines ou par semaine, brut ou net). Un salaire net avec une date de paie devient un revenu récurrent, ce qui alimente « Jusqu’à la prochaine paie ».
2. **Dépenses fixes mensuelles** (facultatif) : loyer, Hydro, Internet, cellulaire, assurances, garderie… Elles deviennent des paiements récurrents du budget, avec un rappel 2 jours avant.
3. **Objectif d’épargne** (facultatif) : un montant par mois, ou une somme d’ici une date. PLWR suggère 10 % du revenu net, ou un fonds d’urgence de 3 mois de dépenses fixes.

Le profil se modifie ensuite dans Réglages.

**Cloche (en haut à droite)** – une pastille compte ce qui attend :
- **À faire** : synchroniser ses agendas, terminer ses dépenses mensuelles, choisir son objectif d’épargne, avec la progression.
- **Alertes** : erreurs de synchronisation, paiements dus dans les 3 jours, dépenses à valider, rappels envoyés (marqués comme lus à l’ouverture).

**Agenda partagé** – chacun garde son agenda et peut le partager avec d’autres comptes (Agenda → bouton personnes, ou Réglages → Partager mon agenda). Trois accès : **Peut modifier** (voit tout, ajoute et modifie), **Peut voir** (tous les détails), **Occupé seulement** (plages prises, sans titre). Inviter par courriel crée un lien à usage unique valable 14 jours, réservé à ce courriel, à envoyer soi-même (Messages, courriel… ; l’app n’envoie pas de courriel). Un **lien d’invitation** réutilisable (accès « Peut voir ») s’active ou se coupe d’un geste. Une invitation permet de créer un compte même quand les inscriptions sont fermées (`ALLOW_SIGNUP=false`). Dans l’agenda, une couleur par personne (choisie dans Réglages), des pastilles pour afficher ou masquer chacun, les avatars des participants sur les blocs. Un événement peut avoir des **participants** : ils le voient dans leur agenda et en reçoivent les rappels, même sans accès au reste. Chaque événement peut être marqué « Occupé seulement » pour les autres. Retirer une personne coupe son accès et ses participations tout de suite ; on peut aussi quitter l’agenda de quelqu’un. Les tâches à placer, objectifs, priorités et « Réorganiser » restent personnels.

**Synchronisation Google Agenda** – chaque personne relie son propre Google Agenda (Réglages → Google Agenda) avec un **guide illustré de A à Z** :
1. créer un projet Google Cloud ;
2. activer l’API Google Calendar ;
3. remplir l’écran de consentement OAuth (Externe, accès `calendar.events`, puis publier l’application) ;
4. créer un client OAuth « Application Web » avec l’URI de redirection affichée par PLWR ;
5. **importer ses variables** dans PLWR : le fichier JSON téléchargé, ou l’ID client et le code secret ;
6. autoriser PLWR sur l’écran de consentement de Google ;
7. c’est synchronisé.

Ce qui se synchronise :
- **Google → PLWR** : les événements avec une heure, de 30 jours en arrière à 365 jours en avant, en lecture seule. Les événements « toute la journée » sont ignorés et un événement privé arrive en « Occupé seulement ».
- **PLWR → Google** (option) : ce qui est créé dans PLWR, récurrences et occurrences supprimées comprises. Une occurrence d’une série déplacée seule n’est pas reportée.
- **Rythme** : toutes les 5 minutes (`GOOGLE_SYNC_MINUTES`), et quelques secondes après une modification.
- **Partage** : les personnes qui partagent l’agenda voient aussi les événements Google, selon leur accès.

Sécurité : le code secret et les jetons sont chiffrés (AES-256-GCM, clé dérivée d’`APP_SECRET` ; si `APP_SECRET` change, il faut reconnecter). Si `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` sont définis sur le serveur, ils servent par défaut et le guide se réduit à l’autorisation. Un client OAuth laissé « En test » chez Google expire après 7 jours : le guide indique de publier l’application.

**Synchronisation Outlook** (Outlook.com, Hotmail, Live, Microsoft 365) – même principe que Google, par Microsoft Graph, avec son **guide illustré de A à Z** (Réglages → Outlook) :
1. ouvrir les inscriptions d’applications dans Microsoft Entra ;
2. inscrire l’application PLWR : comptes multilocataires et personnels, plateforme Web, URI de redirection affichée par PLWR ;
3. choisir les autorisations déléguées `Calendars.ReadWrite` et `offline_access` (la fiche de consentement) ;
4. créer un secret client et copier la colonne **Valeur** ;
5. **importer ses variables** dans PLWR : ID d’application, valeur du secret, annuaire (`common` par défaut) ;
6. accepter la fiche de consentement de Microsoft ;
7. c’est synchronisé.

Comportement :
- **Comme pour Google** : import en lecture seule, envoi optionnel avec récurrences, synchro toutes les 5 minutes (`OUTLOOK_SYNC_MINUTES`) et après chaque modification.
- **Propre à Outlook** : les occurrences supprimées dans PLWR sont aussi supprimées dans Outlook, et un secret client expiré est signalé clairement.
- **Identifiants communs** : `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` et `OUTLOOK_TENANT` sur le serveur réduisent le guide à l’autorisation.
- **Deux agendas** : on peut relier Google et Outlook en même temps, et chacun reçoit ce qui est créé dans PLWR.

**Objectifs** – ponctuels ou récurrents (jour, semaine, mois), à cocher, quantité, durée, montant, échéance et rappel. Un objectif peut être lié à plusieurs blocs ; en terminant un bloc on saisit le résultat réel (ex. 45 min sur 60 prévues). Progression, reste à faire, historique par semaine ou par mois.

**Budget** – enveloppes mensuelles par catégorie (modifiables en cours de mois, ce mois seulement ou aussi les suivants), dépenses confirmées, reste ; revenus ; paiements récurrents (« Payé »/« Reçu » crée la transaction et avance l’échéance, sans doublon) ; vues Personnel, MONDAIX et Combiné. Modifier une transaction confirmée, enregistrer un remboursement (réparti au prorata), ventiler une dépense entre plusieurs catégories (y compris entre personnel et MONDAIX). Bonus : « Jusqu’à la prochaine paie ».

**Chatbot de dépenses** – depuis Aujourd’hui et Budget. Phrases en français courant (« 72$30 », « 1 250,00 $ », « hier », « ce matin », « lundi », « le 3 novembre », « pour MONDAIX »), plusieurs dépenses par message, photo jointe. Une fiche modifiable par transaction (Confirmer / Modifier / Annuler, ou Tout confirmer), une seule question ciblée à la fois si une information manque (montant → commerçant → catégorie), réutilisation des catégories et de tes corrections passées, doublons signalés, budget mis à jour seulement après confirmation avec le reste de la catégorie affiché. Double pression = une seule transaction (verrou côté client + transaction SQL + contrainte d’unicité).

**Import photo / capture** – depuis le chatbot ou le budget, même parcours de validation. Pour chaque ligne : date, commerçant, montant, devise, catégorie et budget proposés, champs incertains surlignés. Corriger, retirer, confirmer une ligne ou la sélection. Même image réimportée détectée (empreinte exacte + empreinte perceptuelle) et lignes déjà enregistrées désélectionnées ; une confirmation de doublon exige « Confirmer quand même ». Image illisible ou panne du fournisseur → saisie manuelle.

## Rappels sur le téléphone

Approche retenue : **Web Push standard** (VAPID) envoyé par le serveur + service worker. Les rappels sont recalculés à partir de l’horaire courant : déplacer un événement déplace son rappel, l’annuler ou le supprimer annule son rappel (la clé de déduplication contient l’heure de début). Types : rendez-vous et blocs (minutes avant), échéances de tâches, échéances d’objectifs, factures récurrentes. Notification de test, heures silencieuses (le rappel est décalé à la fin de la plage), « Reporter » (durée réglable), historique des notifications.

### Activer

- **iPhone (iOS/iPadOS 16.4 ou plus récent)** : ouvrir l’app dans Safari → Partager → « Sur l’écran d’accueil ». Ouvrir PLWR **depuis l’icône**, Réglages → « Activer les notifications » → Autoriser. Puis « Envoyer une notification de test ».
- **Android (Chrome, Edge, Firefox, Samsung Internet)** : Réglages → « Activer les notifications » → Autoriser. Installer l’app (menu ⋮ → Installer) est recommandé.

### Si les notifications n’arrivent pas

Réglages → « Envoyer une notification de test » affiche maintenant le résultat exact :
- *Push désactivé sur le serveur* → variables `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` absentes ou mal collées (le message précise laquelle).
- *Aucun appareil abonné* → touche « Activer les notifications » sur le téléphone (sur iPhone : depuis l’icône de l’écran d’accueil).
- *Clés VAPID différentes* → les clés ont changé depuis l’abonnement ; l’app se réabonne seule à la prochaine ouverture, sinon désactive puis réactive.
- *Envoyée à 1 appareil* mais rien ne s’affiche → réglages de notification du téléphone, mode Concentration, économiseur de batterie (Android).
Les échecs d’envoi sont aussi écrits dans les journaux Railway (`[push] échec vers …`).

### Limites connues (à savoir avant de compter dessus)

- **iPhone** : les notifications ne fonctionnent que si l’app est ajoutée à l’écran d’accueil (pas dans un onglet Safari). iOS **n’affiche pas les boutons d’action** : « Reporter » n’apparaît pas dans la notification ; la toucher ouvre une page « Reporter 10 min / 30 min / 1 h ». Le mode Concentration peut retarder ou masquer les notifications.
- **Android** : l’économiseur de batterie (surtout Samsung, Xiaomi, Huawei) peut retarder la livraison ; retirer l’optimisation de batterie pour le navigateur.
- Les notifications sont envoyées par **ton serveur** : il doit tourner en continu (pas d’hébergement qui s’endort). Précision : ±30 s (intervalle du planificateur) ; après un redémarrage, les rappels manqués depuis moins de 15 min sont rattrapés.
- Sans clés VAPID, les rappels restent visibles dans l’historique et en bandeau quand l’app est ouverte, mais rien n’est livré app fermée.
- Pas d’alarme sonore insistante comme une app native : c’est une notification standard du système.

## Lecture d’images : fournisseur et confidentialité

- Par défaut `VISION_PROVIDER=anthropic` : Claude lit l’image (reçu = une transaction au total ; capture bancaire = une ligne par transaction) et renvoie un JSON validé. La requête active le repli automatique du serveur Anthropic (`fallbacks: "default"`) si un modèle refuse.
- Avant l’envoi : rotation EXIF, suppression des métadonnées, redimensionnement (≤ 2000 px), **OCR local pour repérer les numéros de carte (13 à 19 chiffres) et les masquer en noir**. Le texte renvoyé est aussi filtré. Limite : un numéro très flou ou manuscrit peut échapper à l’OCR local.
- Images stockées dans `DATA_DIR/uploads/<utilisateur>/` (droits 600), servies uniquement à leur propriétaire avec `Cache-Control: no-store`, supprimées dès que toutes les lignes sont confirmées ou retirées (réglable), purge de sécurité après 72 h.
- `VISION_PROVIDER=local` fonctionne sans clé (OCR Tesseract embarqué, français + anglais) mais est moins précis sur les photos de reçus.

## Ajouts priorisés après la première version

| Priorité | Ajout | État |
|---|---|---|
| 1 | Catégories suggérées selon mes corrections | **Déjà actif** : chaque confirmation ou correction mémorise commerçant → catégorie (ex. un fournisseur classé en Inventaire MONDAIX sera proposé ainsi ensuite). |
| 2 | Alerte de surcharge | **Version de base active** sur Aujourd’hui (temps libre vs tâches) et dans « Réorganiser ». À étendre à la semaine. |
| 3 | Solde jusqu’à la prochaine paie | **Version de base active** (Budget) à partir des paiements récurrents « Revenu ». À raffiner (dépenses variables prévues). |
| 4 | Capture rapide de tâches en langage naturel (« CFA 45 min demain après le travail ») | À faire : réutiliser l’analyseur de dates du chatbot + le planificateur pour proposer un bloc. |
| 5 | Revue du dimanche | À faire : comparer blocs prévus/faits (données déjà enregistrées), reporter en lot, ajuster la semaine. |
