#!/usr/bin/env bash
# The panel's workspace picker.
#
#   org.sh list        prints GET /api/v1/me/orgs as JSON
#   org.sh use <id>    makes <id> the organisation Kemory reads and writes
#
# `use` moves both servers a session can reach Kemory through:
#   * the claude.ai connector, which cannot send a header, through the
#     account's stored MCP selection (PUT /api/v1/mcp/org-selection). That
#     selection is account-wide: every connector on the account follows it.
#   * the plugin's own server and hooks, through active_org_id in the
#     credential file, which is what `kemory use` writes. The CLI's bridge and
#     lib.sh read the file on every request, so no restart is needed.
# The server checks membership on the PUT, so the file is written only after
# it accepts.
#
# Exits non-zero with one line on stdout saying why.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh disable=SC1091
. "$DIR/lib.sh"

kemory_resolve_auth || { echo "no Kemory credential, run /kemory:login"; exit 1; }
[ "${KEMORY_TOKEN_EXPIRED:-0}" = 1 ] && { echo "token expired, run /kemory:login"; exit 1; }

case "${1:-}" in
  list)
    curl -sf --max-time 8 -H "$KEMORY_AUTH_HEADER" ${KEMORY_ORG_HEADER:+-H "$KEMORY_ORG_HEADER"} \
      "$KEMORY_BASE_URL/api/v1/me/orgs" || { echo "could not list organisations"; exit 1; }
    ;;
  use)
    org="${2:-}"
    [[ "$org" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
      || { echo "not an organisation id: $org"; exit 1; }
    case "$KEMORY_AUTH_HEADER" in
      X-API-Key:*) echo "an API key is bound to one organisation and cannot switch"; exit 1 ;;
    esac
    creds="$HOME/.kemory/credentials-${KEMORY_ENV:-prod}"
    [ -r "$creds" ] || creds="$HOME/.kemory/credentials"
    [ -w "$creds" ] || { echo "no credential file to update, run /kemory:login"; exit 1; }

    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X PUT \
      -H "$KEMORY_AUTH_HEADER" ${KEMORY_ORG_HEADER:+-H "$KEMORY_ORG_HEADER"} \
      -H 'Content-Type: application/json' -d "{\"org_id\":\"$org\"}" \
      "$KEMORY_BASE_URL/api/v1/mcp/org-selection")
    case "$code" in
      200) ;;
      403) echo "you are not a member of that organisation"; exit 1 ;;
      503) echo "Kemory could not check your membership, try again"; exit 1 ;;
      *) echo "Kemory refused the switch (HTTP ${code:-000})"; exit 1 ;;
    esac

    KEMORY_CREDS="$creds" KEMORY_ORG="$org" python3 -c '
import json, os, tempfile
creds, org = os.environ["KEMORY_CREDS"], os.environ["KEMORY_ORG"]
d = json.load(open(creds))
d["active_org_id"] = org
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds) or ".", prefix="." + os.path.basename(creds) + ".", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(d, fh)
    os.replace(tmp, creds)
except Exception:
    os.unlink(tmp)
    raise
' 2>/dev/null || { echo "the connector moved, but the credential file could not be written"; exit 1; }
    echo ok
    ;;
  *)
    echo "usage: org.sh list | use <org_id>"; exit 1 ;;
esac
