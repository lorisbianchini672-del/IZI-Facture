#!/bin/sh
# Configuration nginx pour izifacture.fr (VM Scaleway 51.158.106.168).
#
# À APPLIQUER DANS CET ORDRE, sinon https://izifacture.fr affiche
# « Votre connexion n'est pas privée » (certificat auto-signé snakeoil) :
#
#   ÉTAPE 1 — obtenir le certificat AVANT de basculer le DNS
#             (certbot en défi DNS, qui ne dépend pas de l'enregistrement A) :
#     sudo apt install -y certbot
#     sudo certbot certonly --manual --preferred-challenges dns \
#          -d izifacture.fr -d www.izifacture.fr
#     # ajouter les enregistrements TXT _acme-challenge demandés dans Cloudflare,
#     # attendre la propagation (dig +short TXT _acme-challenge.izifacture.fr)
#   ÉTAPE 2 — appliquer ce fichier  : sh nginx_conf.sh
#   ÉTAPE 3 — basculer le DNS (Cloudflare) vers 51.158.106.168
#   ÉTAPE 4 — vérifier avec        : npm run check:dns
#
# Le certificat doit exister : nginx refuse de démarrer si ces deux fichiers
# sont absents.
cat > /etc/nginx/sites-available/izi-facture << 'NGX'
server {
    listen 80;
    server_name izifacture.fr www.izifacture.fr;

    # Nécessaire au renouvellement automatique (certbot --webroot).
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name izifacture.fr www.izifacture.fr;

    ssl_certificate /etc/letsencrypt/live/izifacture.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/izifacture.fr/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://127.0.0.1:4242;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90;
        proxy_send_timeout 90;
    }
}
NGX
