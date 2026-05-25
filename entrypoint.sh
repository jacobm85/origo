#!/bin/sh
set -e
htpasswd -bc /etc/nginx/.htpasswd "${APP_USER}" "${APP_PASSWORD}"
exec /docker-entrypoint.sh "$@"
