# syntax=docker/dockerfile:1

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
ENV NGINX_ENVSUBST_FILTER='LM_BEARER_TOKEN' \
    LM_BEARER_TOKEN=''
EXPOSE 80
