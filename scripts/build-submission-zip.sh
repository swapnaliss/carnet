#!/usr/bin/env bash
# Builds the HackerEarth submission zip from tracked files only (git archive) and checks it (M5-03).
# The zip is written OUTSIDE the repo and is never committed. Re-run after M5-CLEANUP merges; M5-GATE
# re-checks the result.
#
#   ./scripts/build-submission-zip.sh [--strict] [ref] [out-dir]
#     ref      commit to archive (default HEAD; use the merge commit on main for the real zip)
#     out-dir  where carnet.zip goes (default: a new dir under ${TMPDIR:-/tmp}); must be outside the repo
#     --strict internal paths (PROJECT.md, WORKFLOW.md, CLAUDE.md, .github/plan/) fail instead of warn;
#              use it after M5-CLEANUP
#
# Prints the commit SHA, file count, size and SHA-256 to paste on the M5-03 / M5-GATE issues.
# Never prints a secret value: gitleaks runs with --redact.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
root=$(pwd -P)

strict=0
if [ "${1:-}" = "--strict" ]; then strict=1; shift; fi
ref=${1:-HEAD}
out=${2:-$(mktemp -d "${TMPDIR:-/tmp}/submit.XXXX")}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
case "$out/" in "$root"/*) echo "FAIL: out-dir must be outside the repo ($out)"; exit 1 ;; esac

command -v gitleaks >/dev/null || { echo "FAIL: gitleaks not on PATH (prereq P-09)"; exit 1; }
command -v unzip >/dev/null || { echo "FAIL: unzip not on PATH"; exit 1; }

sha=$(git rev-parse --verify "$ref^{commit}")
zip="$out/carnet.zip"
rm -f "$zip"
git archive --format=zip -o "$zip" "$sha"

fail=0
if unzip -Z1 "$zip" | grep -E '(^|/)\.env$|^\.git/|(^|/)\.dev-refs\.md$|^\.prp/'; then
  echo "FAIL: forbidden path in the zip (listed above)"; fail=1
fi
if internal=$(unzip -Z1 "$zip" | grep -E '^(PROJECT|WORKFLOW|CLAUDE)\.md$|^\.github/plan/|^\.claude/'); then
  n=$(echo "$internal" | wc -l)
  if [ "$strict" = 1 ]; then echo "FAIL: $n internal paths in the zip:"; echo "$internal" | head -20; fail=1
  else echo "WARN: $n internal paths in the zip; run again with --strict after M5-CLEANUP"; fi
fi
if unzip -Z1 "$zip" | grep -E '^video/'; then echo "FAIL: demo video material in the zip"; fail=1; fi

x="$out/x"; rm -rf "$x"; mkdir "$x"; unzip -q "$zip" -d "$x"
echo "== gitleaks: zip contents"
gitleaks detect --no-git --source "$x" --redact --no-banner || fail=1
echo "== gitleaks: full history"
gitleaks detect --source . --redact --no-banner || fail=1
echo "== check-no-secrets: working tree"
./scripts/check-no-secrets.sh || fail=1
rm -rf "$x"

files=$(unzip -Z1 "$zip" | grep -vc '/$' || true)
bytes=$(wc -c < "$zip")
echo
echo "commit:  $sha"
echo "zip:     $zip"
echo "files:   $files"
echo "bytes:   $bytes"
echo "sha256:  $(sha256sum "$zip" | cut -d' ' -f1)"
[ "$fail" = 0 ] && echo "build-submission-zip: ok" || { echo "build-submission-zip: FAILED"; exit 1; }
