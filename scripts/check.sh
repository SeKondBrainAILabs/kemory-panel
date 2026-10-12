#!/usr/bin/env bash
# Validate the plugin and run its tests. Run before opening a PR; CI runs this too.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "→ JSON manifests"
while IFS= read -r f; do
  if jq empty "$f" 2>/dev/null; then echo "  ok   $f"; else echo "  FAIL $f"; fail=1; fi
done < <(find . -name '*.json' -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.claude-plugin/types/*')

echo "→ shell scripts"
while IFS= read -r f; do
  if ! bash -n "$f" 2>/dev/null; then
    echo "  FAIL $f (syntax)"; fail=1
  elif [ ! -x "$f" ]; then
    echo "  FAIL $f (not executable)"; fail=1
  else
    echo "  ok   $f"
  fi
done < <(find . -name '*.sh' -not -path './.git/*')

# One plugin served to two agent hosts through a manifest each. Every
# marketplace gates updates on the version STRING, so a bump applied to one
# and not the other leaves that host on the old version for good.
echo "→ manifests agree"
ver=$(jq -r '.version' .claude-plugin/plugin.json)
if ! diff -q .claude-plugin/plugin.json .grok-plugin/plugin.json >/dev/null; then
  echo "  FAIL .claude-plugin and .grok-plugin have diverged"; fail=1
elif ! printf '%s' "$ver" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  # release.yml turns this into the tag name.
  echo "  FAIL version '$ver' is not X.Y.Z"; fail=1
else
  echo "  ok   $ver"
fi

echo "→ hooks reference existing scripts"
while IFS= read -r s; do
  s="${s/\$\{CLAUDE_PLUGIN_ROOT\}/.}"
  if [ -f "$s" ]; then echo "  ok   $s"; else echo "  FAIL missing $s"; fail=1; fi
done < <(jq -r '.hooks[][].hooks[].command | select(contains("CLAUDE_PLUGIN_ROOT"))' hooks/hooks.json | awk '{print $1}')

# The status check sources this copy of lib.sh, since an installed plugin
# cannot reach the kemory plugin's files. A drifted copy would check a
# different credential than kemory's hooks use. KEMORY_LIB_URL points it at
# another branch while both change together.
echo "→ scripts/lib.sh matches the kemory plugin's"
lib_url=${KEMORY_LIB_URL:-https://raw.githubusercontent.com/SeKondBrainAILabs/kemory-plugin/main/plugin/scripts/lib.sh}
if upstream=$(curl -fsSL --max-time 20 "$lib_url" 2>/dev/null); then
  if [ "$upstream" == "$(cat scripts/lib.sh)" ]; then
    echo "  ok   $lib_url"
  else
    echo "  FAIL scripts/lib.sh differs from $lib_url — copy it over"; fail=1
  fi
else
  echo "  FAIL could not fetch $lib_url"; fail=1
fi

# This repo is public, and release.yml copies CHANGELOG.md into a published
# GitHub release. Catch internal tracker ids and Notion links before then.
echo "→ no internal references in tracked files"
if leaks=$(git grep -nIE 'S9N-[0-9]+|app\.notion\.com|notion\.so/' -- . ':!scripts/check.sh' 2>/dev/null); then
  echo "  FAIL internal references found:"; printf '    %s\n' "$leaks"; fail=1
else
  echo "  ok   no tracker ids or Notion links"
fi

echo "→ approval hook tests"
if python3 tests/test_recall_approve.py >/tmp/kemory-panel-tests.log 2>&1; then
  echo "  ok   $(grep -oE 'Ran [0-9]+ tests' /tmp/kemory-panel-tests.log) passed"
else
  echo "  FAIL see /tmp/kemory-panel-tests.log"; tail -20 /tmp/kemory-panel-tests.log; fail=1
fi

# The module needs a Claude Code that loads modules; without the CLI these
# two cannot run, which CI treats as a failure (it installs the CLI first).
if command -v claude >/dev/null 2>&1; then
  echo "→ claude plugin validate"
  if out=$(claude plugin validate . 2>&1); then
    echo "  ok   plugin manifest and module"
  else
    echo "  FAIL"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1
  fi
  echo "→ module tests (claude plugin test)"
  if out=$(claude plugin test . 2>&1); then
    echo "  ok   $(printf '%s\n' "$out" | grep -E '^ *[0-9]+ pass' | tr -s ' ')"
  else
    echo "  FAIL"; printf '%s\n' "$out" | tail -30 | sed 's/^/    /'; fail=1
  fi
elif [ -n "${CI:-}" ]; then
  echo "→ claude CLI missing in CI"; fail=1
else
  echo "→ module validation and tests (skipped: claude CLI not on PATH)"
fi

if [ "$fail" -eq 0 ]; then echo "PASS"; else echo "FAILURES ABOVE"; exit 1; fi
