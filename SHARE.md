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

## Corriger le domaine (Cloudflare)

Le domaine est actuellement servi par Cloudflare vers un autre hébergement.

1. Cloudflare → **DNS** → enregistrement `A` de `izifacture.fr` :
   remplacer `185.158.133.1` par **l'adresse IP de la VM** (`51.158.106.168`).
2. Faire de même pour `www` (enregistrement `A` vers la même IP, ou `CNAME` vers `izifacture.fr`).
3. Le certificat en place sur la VM couvre `izifacture.fr` : conserver le mode SSL
   **Full (strict)** et ne pas activer la réécriture d'URL Cloudflare sur `/api/`.
4. Vérifier : `curl -sS https://izifacture.fr/ | grep -o '<title>[^<]*</title>'` doit
   renvoyer le titre IZI, et non celui de l'application OCR.
5. Étant donné qu'un site Lovable a été publié sur ce domaine, vérifier que celui-ci reste
   accessible sur une autre adresse avant de déplacer l'enregistrement DNS.