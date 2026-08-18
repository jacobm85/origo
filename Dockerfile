# syntax=docker/dockerfile:1
#
# Sjökortsplotter – avskalad variant av kartan (gren: plotter-sjokort).
# Inga förkonverterade datamängder, ingen Lantmäteri-integration och inga
# egna redigerbara lagergrupper; sjökortet hämtas som WMS vid körning.

FROM node:lts-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run prebuild-sass && npm run build

FROM nginx:alpine
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
# Client runtime config (window.APP_CONFIG) — renderas vid containerstart från
# MAP_TITLE / MAP_FOOTER_TEXT i .env via /docker-entrypoint.d/.
COPY app-config/config.js.template /etc/templates/app-config/config.js.template
COPY app-config/30-render-app-config.sh /docker-entrypoint.d/30-render-app-config.sh
RUN chmod +x /docker-entrypoint.d/30-render-app-config.sh
# Inloggningsskärmens text (rubrik + ev. underrubrik) renderas från
# LOGIN_TITLE / LOGIN_SUBTITLE i login.html vid containerstart.
COPY app-config/25-render-login.sh /docker-entrypoint.d/25-render-login.sh
RUN chmod +x /docker-entrypoint.d/25-render-login.sh
# nginx-mallen innehåller inga env-variabler i den här varianten. Filtret
# måste ändå sättas — utan det substituerar entrypointen samtliga variabler.
ENV NGINX_ENVSUBST_FILTER='(NGINX_ENVSUBST_FILTER)' \
    MAP_TITLE='' \
    MAP_FOOTER_TEXT='' \
    LOGIN_TITLE='Sjökortsplotter' \
    LOGIN_SUBTITLE=''
EXPOSE 80
