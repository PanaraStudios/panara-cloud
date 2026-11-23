#!/bin/sh
# Panara Cloud agent image commands:
#   agent         run the agent (default)
#   migrate       push Convex functions, apply env and data migrations. The
#                 functions and the tools that deploy them are in the
#                 panara-cloud-migrate image of the same version, which
#                 installers and updates from 0.1.6 on run directly; this
#                 command is for callers that still run it here (an in-panel
#                 Update made by 0.1.5): it fetches that image's deploy files
#                 from the registry and runs them in this container, with the
#                 network, environment and mounts it was given
#   create-admin  create the first administrator from JSON on stdin
#   reset-password  print a password reset link for {"email"} on stdin
#   setup-link    print a new one-time link that creates the first account
#   panel-setup   prepare /etc/panara-cloud and Traefik on the panel host
set -e

: "${CONVEX_SELF_HOSTED_URL:=http://panara-cloud-convex:3210}"
: "${CONVEX_SELF_HOSTED_ADMIN_KEY_FILE:=/etc/panara-cloud/secrets/convex-admin-key}"
export CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY_FILE

command="${1:-agent}"
[ $# -gt 0 ] && shift
case "$command" in
agent) exec node --enable-source-maps /app/agent/index.mjs "$@" ;;
migrate)
	dir=$(node /app/agent/migrate-fetch.mjs)
	exec node "$dir/scripts/install.mjs" deploy "$@"
	;;
create-admin) exec node /app/agent/install.mjs create-admin "$@" ;;
reset-password) exec node /app/agent/install.mjs reset-password "$@" ;;
setup-link) exec node /app/agent/install.mjs setup-link "$@" ;;
panel-setup) exec node --enable-source-maps /app/agent/panel-setup.mjs "$@" ;;
*) exec "$command" "$@" ;;
esac
