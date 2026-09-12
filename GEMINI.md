# iziFacture - Contexte projet

## 1. Résumé de l'application

iziFacture est une application web française de facturation destinée aux TPE, PME, indépendants et artisans en France.

L'application permet de :

- consulter une landing page commerciale ;
- accéder à un espace client/dashboard ;
- créer des factures, devis et factures récurrentes ;
- calculer automatiquement les montants HT, TVA et TTC ;
- enregistrer les factures dans le backend ;
- éviter les doublons lors d'une double sauvegarde du même numéro de facture ;
- modifier le statut d'une facture ;
- envoyer une facture par email avec une pièce jointe PDF ;
- exporter/imprimer la facture au format PDF ;
- gérer les clients ;
- suivre les encaissements et la TVA ;
- exporter un exemple de FEC ;
- gérer les informations légales de l'entreprise ;
- préparer des paiements Stripe pour les plans d'abonnement ;
- consulter les commandes via une page d'administration protégée.

Le projet est actuellement une application locale / prototype fonctionnel. Le backend est prêt à être déployé, mais l'authentification complète et la base de données de production restent à mettre en place.

## 2. Fonctionnalités implémentées

### Site public

- Landing page avec présentation du produit, fonctionnalités, tarifs et témoignages.
- Navigation vers le guide, le dashboard et les tarifs.
- Menu responsive pour mobile.
- Plans tarifaires : Gratuit, Pro et Business & Équipe.
- Les plans Pro et Business appellent `/api/checkout` pour créer une session Stripe Checkout.

### Dashboard

- KPI de chiffre d'affaires, factures en attente, retards de paiement et TVA.
- Calendrier d'activité et d'échéances.
- Recherche dans la liste des factures.
- Filtres par statut.
- Liste de factures historiques présentes dans la maquette.
- Liste dynamique des factures enregistrées dans `data/invoices.json`.
- Menu d'actions par facture :
  - Voir le détail ;
  - Modifier ;
  - Changer le statut ;
  - Supprimer (interface présente, suppression backend à finaliser).
- Sous-menu de statut :
  - Brouillon ;
  - Envoyée ;
  - Payée ;
  - En retard.
- Les statuts des anciennes factures sont sauvegardés par numéro de facture.
- Les statuts des nouvelles factures sont sauvegardés par identifiant.

### Création de factures et devis

- Éditeur `devis.html` avec aperçu en direct.
- Types de document : facture standard, devis commercial et facture récurrente.
- Numéro de document, client, dates d'émission et d'échéance.
- Ajout et suppression de lignes de prestations.
- Quantité, prix unitaire HT et taux de TVA par ligne.
- Calcul automatique HT, TVA et TTC.
- Bouton principal : `Créer la facture`.
- Création persistante via `POST /api/invoices`.
- Si le même numéro existe déjà, la facture est mise à jour au lieu d'être dupliquée.
- Modale après création avec :
  - téléchargement/impression PDF ;
  - retour au dashboard / à la liste des factures.
- Changement de statut depuis l'éditeur.
- Après un envoi email réussi, le statut est automatiquement passé à `Envoyée`.

### PDF et email

- Export de la facture par la boîte d'impression du navigateur.
- Styles d'impression qui masquent l'interface et ne gardent que la facture.
- Génération serveur d'un PDF avec PDFKit pour les emails.
- Envoi SMTP via Nodemailer.
- Pièce jointe PDF nommée avec le numéro de facture.
- L'API accepte notamment ce format :

```json
{
  "clientEmail": "contact@legaret.fr",
  "subject": "Votre facture FAC-2026-009",
  "message": "Bonjour, veuillez trouver ci-joint votre facture...",
  "documentId": "FAC-2026-009"
}
```

- L'API conserve aussi la compatibilité avec `recipient` et `documentNumber`.
- Les informations légales sauvegardées sont reprises dans le PDF email.

### Paramètres entreprise

`parametres.html` permet de modifier et sauvegarder :

- nom légal ;
- RC / SIRET ;
- NINEA ;
- PLATO ;
- email de factures professionnel ;
- adresse de facturation ;
- téléphone professionnel.

Les données sont stockées dans `data/settings.json` et réutilisées dans les factures et PDFs générés.

### Clients

- Répertoire clients avec recherche.
- Ajout d'un client via formulaire.
- Champs SIRET, email, téléphone et informations d'entreprise.
- La page reste principalement une maquette frontend ; la persistance backend des clients est à prévoir.

### TVA et comptabilité

- Page de suivi des transactions et de la TVA.
- Ventilation par taux de TVA français : 20 %, 10 % et 5,5 %.
- Synthèse CA3.
- Journal des encaissements.
- Page d'export FEC et archive Factur-X de démonstration.
- Le FEC actuel est un exemple généré côté navigateur, pas encore un export comptable connecté à toutes les données réelles.

### Administration

- `admin.html` affiche les commandes Stripe et les revenus.
- L'accès à `/api/orders` nécessite l'en-tête `x-admin-token`.
- La page admin utilise la valeur `ADMIN_TOKEN` du fichier `.env`.

## 3. Structure des fichiers

```text
IziFacture/
├── index.html              # Landing page publique et tarifs
├── comment-ca-marche.html  # Guide de présentation et fonctionnement
├── dashboard.html          # Dashboard, calendrier, KPIs et liste des factures
├── devis.html              # Éditeur de devis/factures et aperçu live
├── clients.html            # Répertoire et ajout de clients
├── transactions-tva.html   # Encaissements et suivi de TVA
├── export-fec.html         # Export FEC et archive Factur-X de démonstration
├── parametres.html         # Paramètres légaux de l'entreprise
├── admin.html              # Vue privée des commandes et revenus
├── server.js               # Backend Express, API, Stripe, SMTP et PDF
├── package.json             # Scripts et dépendances Node.js
├── package-lock.json        # Versions verrouillées des dépendances
├── .env.example             # Variables d'environnement documentées
├── .env                     # Secrets locaux, ne jamais commit/publier
├── .gitignore               # Fichiers à ignorer
├── data/
│   ├── invoices.json        # Factures persistées localement
│   ├── settings.json        # Paramètres entreprise persistés
│   └── orders.json          # Commandes Stripe si elles existent
└── .github/agents/          # Instructions spécifiques d'agents déjà présentes
```

## 4. Technologies utilisées

### Frontend

- HTML5 multi-pages.
- CSS intégré directement dans les fichiers HTML.
- JavaScript vanilla côté navigateur.
- Google Fonts : Plus Jakarta Sans, DM Sans et Space Mono.
- SVG inline pour les icônes et graphiques.
- Responsive CSS avec media queries.

### Backend

- Node.js en ES modules (`"type": "module"`).
- Express 4.
- `dotenv` pour les variables d'environnement.
- Stripe Node SDK pour Stripe Checkout et webhook.
- Nodemailer pour SMTP.
- PDFKit pour créer les PDFs joints aux emails.
- `fs/promises` et fichiers JSON comme persistance locale.
- UUID via `crypto.randomUUID()`.

### Commandes utiles

```bash
npm install
npm start
npm run dev
node --check server.js
```

URL locale par défaut : `http://localhost:4242`.

## 5. API backend

- `GET /api/health`
  - Vérifie que le serveur répond.
  - Indique si Stripe est configuré.

- `GET /api/settings`
  - Retourne les paramètres entreprise.

- `PUT /api/settings`
  - Sauvegarde les paramètres entreprise.

- `GET /api/invoices`
  - Retourne les factures persistées.

- `POST /api/invoices`
  - Crée ou met à jour une facture selon son numéro.
  - Une double sauvegarde du même numéro est idempotente.

- `PATCH /api/invoices/:id/status`
  - Met à jour le statut d'une facture enregistrée.

- `PATCH /api/invoices/by-number/:number/status`
  - Met à jour le statut d'une facture historique identifiée uniquement par son numéro.

- `POST /api/invoices/email`
  - Génère un PDF et envoie la facture par SMTP.

- `POST /api/checkout`
  - Crée une session Stripe Checkout pour un plan Pro ou Business.

- `POST /api/stripe/webhook`
  - Reçoit les confirmations Stripe et enregistre les commandes payées.

- `GET /api/orders`
  - Retourne les commandes.
  - Requiert `x-admin-token` égal à `ADMIN_TOKEN`.

## 6. Variables d'environnement

Les variables sont documentées dans `.env.example`.

- `PORT` : port Express, par défaut `4242`.
- `PUBLIC_URL` : URL publique utilisée par Stripe pour les redirections.
- `STRIPE_SECRET_KEY` : clé secrète Stripe, uniquement côté serveur.
- `STRIPE_WEBHOOK_SECRET` : secret du webhook Stripe.
- `ADMIN_TOKEN` : token d'accès admin.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` : configuration SMTP.
- `MAIL_FROM` : adresse expéditrice.

Ne jamais afficher, committer ou envoyer les secrets du `.env` dans une conversation ou un dépôt public.

## 7. Décisions de design

- Identité visuelle premium orientée facturation professionnelle.
- Palette principale violette avec accents vert, ambre et rouge pour les états métier.
- Typographies : Plus Jakarta Sans pour les titres, DM Sans pour le texte, Space Mono pour les montants et références.
- Sidebar fixe de 260 px pour l'espace applicatif.
- Cartes blanches sur fond gris très clair.
- Arrondis modérés, ombres discrètes et bordures fines.
- Les statuts doivent être immédiatement lisibles grâce aux badges colorés.
- Les actions secondaires sont regroupées dans un menu `•••` pour éviter de surcharger les tableaux.
- Les montants utilisent le format français et une police monospace.
- Les documents doivent rester propres à l'impression et au PDF.
- Préserver les layouts, les couleurs et les composants existants avant d'introduire une nouvelle abstraction.

## 8. Instructions pour un futur modèle IA

### Avant de modifier

1. Lire ce fichier et vérifier l'état réel du code.
2. Identifier le fichier et le parcours utilisateur concerné avant toute modification.
3. Respecter le style HTML/CSS existant : pas de framework frontend ajouté sans nécessité.
4. Ne jamais écraser les données utilisateur de `data/` sans demande explicite.
5. Ne jamais exposer les secrets de `.env`.
6. Vérifier si le serveur tourne sur `http://localhost:4242` avant de tester les endpoints.

### Pendant la modification

1. Utiliser les routes existantes et les formats de données existants.
2. Conserver l'idempotence des factures : le numéro est la clé métier d'une facture.
3. Les statuts valides sont `BROUILLON`, `ENVOYEE`, `PAYEE`, `RETARD` et, pour compatibilité, `ATTENTE`.
4. Toute modification de statut doit être persistée côté backend.
5. Toute nouvelle facture doit apparaître dans le dashboard sans doublon.
6. Toute modification des paramètres entreprise doit être reprise dans les futures factures et PDFs.
7. Les emails doivent être envoyés uniquement côté serveur via Nodemailer.
8. Les PDFs envoyés par email doivent être générés côté serveur avec PDFKit.
9. Ne pas prétendre qu'un PDF est généré si l'action ne fait qu'ouvrir une impression navigateur.
10. Garder les données historiques compatibles avec les nouvelles factures.

### Après la modification

1. Exécuter `node --check server.js`.
2. Utiliser `get_errors` sur les fichiers modifiés.
3. Tester le parcours dans le navigateur si une interaction frontend est touchée.
4. Tester les endpoints concernés avec des données temporaires.
5. Supprimer toutes les données de test avant de terminer.
6. Vérifier que `data/invoices.json` et `data/settings.json` ne contiennent pas de données de test.
7. Mentionner clairement les fonctionnalités qui restent dépendantes d'une configuration externe : Stripe, SMTP, déploiement public et webhook.

## 9. Limites et prochaines étapes recommandées

- Ajouter une authentification réelle pour les utilisateurs et l'administration.
- Remplacer les fichiers JSON par PostgreSQL ou SQLite en production.
- Ajouter une vraie API clients persistante.
- Implémenter réellement `Modifier` et `Supprimer` pour les factures.
- Générer les PDF avec toutes les mentions légales et lignes de facture complètes.
- Ajouter une vraie pièce jointe PDF dans l'export navigateur si nécessaire, au lieu de dépendre de la boîte d'impression.
- Finaliser le FEC à partir des écritures réelles.
- Configurer Stripe en production avec webhook public HTTPS.
- Déployer Express et les fichiers statiques sur un hébergeur persistant.
- Ajouter des tests automatisés backend et frontend.
- Corriger les vulnérabilités signalées par `npm audit` avant une mise en production.
