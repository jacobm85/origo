#!/bin/sh
set -e
printf '%s:%s\n' "${APP_USER}" "$(openssl passwd -apr1 "${APP_PASSWORD}")" > /etc/nginx/.htpasswd
exec /docker-entrypoint.sh "$@"
