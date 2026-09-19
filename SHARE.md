# Kit de partage — IZI Facture

## À lire avant tout partage : conflit de domaine

Il existe **deux sites différents** derrière la marque :

| URL | Ce qui répond | Hébergement |
| --- | --- | --- |
| `https://izifacture.fr/` | « IZIFACTURE — Dématérialisation et OCR de factures par IA » (appli Lovable, pages `/auth`, design Tailwind) | Cloudflare + 185.158.133.1 |
| `https://51.158.106.168.nip.io/` | **Cette application** (Express, dashboard, Factur-X, relances) | VM Scaleway 51.158.106.168 |

Tant que `izifacture.fr` pointe ailleurs, **tout lien partagé vers le domaine envoie les visiteurs sur l'autre site**.
Pour partager CE site : soit pointer le domaine vers la VM de production, soit partager provisoirement
l'URL `https://51.158.106.168.nip.io/`.

Deux conditions bloquantes ont été mesurées le 19/09/2026 :

| Condition | État | Conséquence |
| --- | --- | --- |
| Certificat TLS couvrant `izifacture.fr` sur la VM | ❌ auto-signé (`snakeoil`) | basculer le DNS maintenant → alerte « connexion non privée » |
| `robots.txt`, `sitemap.xml`, `og-image.png` servis par la VM | ❌ 404 (code non déployé) | pas d'aperçu de partage ni d'indexation |

Diagnostic complet en une commande (aucune modification) :

```bash
npm run check:dns
```

## URL à utiliser

- Domaine (une fois le DNS corrigé, voir ci-dessous) : `https://izifacture.fr/`
- Repli immédiat, sans attendre le DNS : `https://51.158.106.168.nip.io/`

## Liens prêts à copier

Ajoutez `?utm_source=` et `?utm_medium=` pour savoir d'où viennent les visites.

```
LinkedIn  : https://izifacture.fr/?utm_source=linkedin&utm_medium=social
X         : https://izifacture.fr/?utm_source=x&utm_medium=social
Facebook  : https://izifacture.fr/?utm_source=facebook&utm_medium=social
WhatsApp  : https://izifacture.fr/?utm_source=whatsapp&utm_medium=message
Email     : https://izifacture.fr/?utm_source=email&utm_medium=signature
```

## Textes à copier-coller

### LinkedIn (post long)
> La facturation électronique devient la norme en France : dès 2026, toutes les entreprises
> devront pouvoir émettre des factures au format Factur-X.
>
> IZI Facture est né d'un constat simple : les TPE, PME et indépendants n'ont pas besoin d'un
> ERP complexe, mais d'un outil qui fait le travail correctement.
>
> Ce que fait IZI Facture :
> - Devis et factures conformes Factur-X 2026, en 2 clics
> - TVA calculée automatiquement, mentions légales incluses
> - Relances d'impayés automatiques en 3 niveaux
> - Export FEC pour votre expert-comptable
> - Suivi du chiffre d'affaires, de l'encaissé et de l'encours
>
> Prêt en 2 minutes, à partir de 0 €/mois. Hébergement en France.
>
> 👉 https://izifacture.fr/?utm_source=linkedin&utm_medium=social

### X / Twitter (court)
> La facture électronique devient obligatoire en France en 2026.
>
> IZI Facture : devis, factures Factur-X, relances d'impayés et export FEC — en 2 minutes.
> Dès 0 €/mois, hébergé en France.
>
> https://izifacture.fr/?utm_source=x&utm_medium=social

### Facebook
> Vous facturez encore à la main ? 📄
>
> IZI Facture génère vos devis et factures conformes Factur-X 2026, calcule la TVA,
> relance vos impayés automatiquement et exporte le FEC pour votre comptable.
>
> Dès 0 €/mois, prêt en 2 minutes  https://izifacture.fr/?utm_source=facebook&utm_medium=social

### WhatsApp (message direct)
> Bonjour ! Je te transmets IZI Facture, l'outil de facturation conforme Factur-X 2026 que
> j'utilise : devis, factures, TVA, relances d'impayés et export comptable.
> C'est prêt en 2 minutes : https://izifacture.fr/?utm_source=whatsapp&utm_medium=message

### Signature d'email
> IZI Facture - Facturation conforme Factur-X 2026
> https://izifacture.fr/?utm_source=email&utm_medium=signature

## Aperçu des liens (Open Graph)

`index.html` déclare désormais : `og:title`, `og:description`, `og:url`, `og:image`
(`og-image.png`, 1200 × 630), `og:site_name`, `og:locale` et les balises `twitter:card`.

Contrôle : coller l'URL dans le débogueur de partage d'une plateforme, ou vérifier
directement que l'image est accessible.

```bash
curl -sSI https://izifacture.fr/og-image.png | head -3
```

Si l'aperçu conserve une ancienne version : forcer le rafraîchissement du cache
(LinkedIn Post Inspector, Facebook Sharing Debugger, ou un `?v=2` sur l'URL).

## Référencement

- `robots.txt` : indexation autorisée sur les pages publiques, `admin.html`,
  `dashboard.html`, `parametres.html`, `/api/` et `/data/` exclus.
- `sitemap.xml` : 14 pages publiques. À déclarer dans la Search Console Google
  (`https://izifacture.fr/sitemap.xml`).

## Mettre le domaine en ligne (ordre impératif)

⚠️ **Ne basculez pas le DNS en premier** : la VM présente actuellement un certificat
auto-signé (`ssl-cert-snakeoil`) pour `izifacture.fr`. Un basculement immédiat ferait
apparaître « Votre connexion n'est pas privée » chez tous les visiteurs.

Procédure vérifiée (chaque étape est contrôlable) :

**Étape 0 — Déployer le code sur la VM.** Le serveur de production ne sert pas encore
`robots.txt`, `sitemap.xml` ni `og-image.png` (tous en 404). Sur la VM :

```bash
cd /chemin/vers/izi && git pull && sudo systemctl restart izi
```

**Étape 1 — Obtenir le certificat avant de toucher au DNS** (défi DNS : ne dépend pas
de l'enregistrement `A`, donc zéro coupure) :

```bash
sudo apt install -y certbot
sudo certbot certonly --manual --preferred-challenges dns \
     -d izifacture.fr -d www.izifacture.fr
# ajouter les TXT _acme-challenge demandés dans Cloudflare, puis vérifier :
dig +short TXT _acme-challenge.izifacture.fr
```

**Étape 2 — Appliquer la configuration nginx** (elle référence désormais
`/etc/letsencrypt/live/izifacture.fr/`) :

```bash
sh nginx_conf.sh && sudo nginx -t && sudo systemctl reload nginx
```

**Étape 3 — Basculer le DNS (Cloudflare)**
1. Enregistrement `A` de `izifacture.fr` : `185.158.133.1` → **`51.158.106.168`**.
2. Idem pour `www` (enregistrement `A` vers la même IP, ou `CNAME` vers `izifacture.fr`).
   `www` renvoie actuellement `421 Project not found` côté Cloudflare/Lovable.
3. Mode SSL **Full (strict)**, sans réécriture d'URL sur `/api/`.

**Étape 4 — Vérifier** (une seule commande, sans rien modifier) :

```bash
npm run check:dns
```

Elle contrôle le DNS, le certificat, le titre réellement servi et les fichiers de
partage. `izifacture.fr` et `www` doivent pointer vers `51.158.106.168`, le titre
doit être celui de `index.html`, et les 3 fichiers doivent répondre `200`.

**Point de vigilance :** un site « IZIFACTURE — Dématérialisation et OCR de factures par
IA » (Lovable) est publié sur ce domaine. Avant de déplacer l'enregistrement, assurez-vous
que ce site reste accessible sur une autre adresse, sinon il deviendra injoignable.