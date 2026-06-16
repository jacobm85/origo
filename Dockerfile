# syntax=docker/dockerfile:1

FROM node:lts-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Hämta hem färska versioner av de externa datamängder som inte är WMS:er och
# därför förkonverteras till GeoJSON vid varje build:
#   - Försvarsmaktens riksintressen/påverkansområden (shapefil → GeoJSON)
#   - Länsstyrelsernas riksintresse slutförvaring (ATOM/shapefil → GeoJSON)
#   - SCB:s areal riksintresse per kommun (statistik-API → choropleth-GeoJSON)
# Varje steg faller tillbaka på den incheckade kopian i data/ om hämtningen
# misslyckas, så bygget aldrig bryts av en otillgänglig extern tjänst.
RUN apk add --no-cache python3 \
 && (python3 tools/build_forsvarsmakten_riksintressen.py \
     || echo "WARN: Forsvarsmakten-fetch misslyckades; anvander incheckad kopia") \
 && (python3 tools/build_slutforvaring_riksintresse.py \
     || echo "WARN: slutforvaring-fetch misslyckades; anvander incheckad kopia") \
 && (python3 tools/build_riksintresse_areal.py \
     || echo "WARN: SCB-fetch misslyckades; anvander incheckad kopia")

RUN npm run prebuild-sass && npm run build

FROM nginx:alpine
# python3 används av startskriptet som genererar de egna lagergrupperna
# (40-render-egna-grupper.sh → render-egna-grupper.py) ur EGNA_GRUPPER.
RUN apk add --no-cache python3
COPY --from=builder /app/build /usr/share/nginx/html
COPY login.html /usr/share/nginx/html/login.html
# Copy the plugins explicitly (not via the build's concurrent copy-plugins step)
# so they are always served at /plugins/ regardless of build-pipeline races.
COPY plugins /usr/share/nginx/html/plugins
# nginx official entrypoint runs envsubst on files in /etc/nginx/templates/
# with the .template extension and writes the result to /etc/nginx/conf.d/.
# Only variables listed in NGINX_ENVSUBST_FILTER are substituted, so other
# nginx variables like $uri are left alone.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Beräknar Basic Auth-headern för Lantmäteriets WMTS-bakgrundskartor från
# LM_USER/LM_PASS. .envsh sourcas av nginx-entrypointen FÖRE envsubst-steget så
# att $LM_BASIC_AUTH finns när ${LM_BASIC_AUTH} ersätts i nginx-mallen.
COPY app-config/15-lm-basic-auth.envsh /docker-entrypoint.d/15-lm-basic-auth.envsh
RUN chmod +x /docker-entrypoint.d/15-lm-basic-auth.envsh
# Client runtime config (window.APP_CONFIG) — renderas vid containerstart från
# MAP_TITLE / MAP_FOOTER_TEXT i .env via /docker-entrypoint.d/.
COPY app-config/config.js.template /etc/templates/app-config/config.js.template
COPY app-config/30-render-app-config.sh /docker-entrypoint.d/30-render-app-config.sh
RUN chmod +x /docker-entrypoint.d/30-render-app-config.sh
# Inloggningsskärmens text (rubrik + ev. underrubrik) renderas från
# LOGIN_TITLE / LOGIN_SUBTITLE i login.html vid containerstart.
COPY app-config/25-render-login.sh /docker-entrypoint.d/25-render-login.sh
RUN chmod +x /docker-entrypoint.d/25-render-login.sh
# Egna (redigerbara) lagergrupper genereras i index.json ur EGNA_GRUPPER.
COPY app-config/render-egna-grupper.py /etc/templates/app-config/render-egna-grupper.py
COPY app-config/40-render-egna-grupper.sh /docker-entrypoint.d/40-render-egna-grupper.sh
RUN chmod +x /docker-entrypoint.d/40-render-egna-grupper.sh
# Bara dessa env-variabler substitueras i nginx-mallen (övriga $-variabler som
# $uri lämnas orörda). LM_BASIC_AUTH sätts av 15-lm-basic-auth.envsh.
ENV NGINX_ENVSUBST_FILTER='(LM_BEARER_TOKEN|LM_BASIC_AUTH)' \
    LM_BEARER_TOKEN='' \
    LM_USER='' \
    LM_PASS='' \
    MAP_TITLE='' \
    MAP_FOOTER_TEXT='' \
    LOGIN_TITLE='Origo' \
    LOGIN_SUBTITLE='' \
    EGNA_GRUPPER=''
EXPOSE 80
