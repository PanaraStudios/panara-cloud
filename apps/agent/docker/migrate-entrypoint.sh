#!/bin/sh
# Panara Cloud migrate image commands (packages/backend/scripts/install.mjs):
#   migrate       push Convex functions, apply env and data migrations (default)
#   create-admin, reset-password, setup-link  as in the agent image
# Run once per install, upgrade and in-panel update, then removed.
set -e

: "${CONVEX_SELF_HOSTED_URL:=http://panara-cloud-convex:3210}"
: "${CONVEX_SELF_HOSTED_ADMIN_KEY_FILE:=/etc/panara-cloud/secrets/convex-admin-key}"
export CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY_FILE

command="${1:-migrate}"
[ $# -gt 0 ] && shift
case "$command" in
migrate) exec node /migrate/scripts/install.mjs deploy "$@" ;;
create-admin | reset-password | setup-link) exec node /migrate/scripts/install.mjs "$command" "$@" ;;
*) exec "$command" "$@" ;;
esac
