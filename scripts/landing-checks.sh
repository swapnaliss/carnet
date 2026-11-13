#!/usr/bin/env bash
# The landing checks: ONE chain shared by /start Phase 6 and /start-milestone § 3d, so a manager's
# merge and a worker's merge are held to the same bar. The first failure stops the rest, and the
# secret scan runs first so a leak blocks landing exactly like a failed test.
# Edit per project (add its own checks at the bottom), never per run.
#
# Two levels:
#   ./scripts/landing-checks.sh          full: every workspace plus the slow project checks.
#                                        Standalone /start, the /start-milestone batch gate, CI.
#   ./scripts/landing-checks.sh --fast   only the npm workspaces this branch changed against
#                                        origin/main. /start-milestone workers, and re-runs after a
#                                        rebase or backlog fix. A root config change runs everything.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

# Private-from-day-one paths (research, outreach, recon notes, review screenshots, local state) are
# gitignored by /kickoff and must never be tracked. Workflow files are untracked later, by M<n>-CLEANUP.
if git ls-files | grep -E '^(docs/(research|outreach|recon)/|\.review/|\.prp/|\.dev-refs\.md$|\.kickoff-state\.md$)'; then
  echo "landing-checks: the private paths above are tracked; run 'git rm -r --cached' on them" >&2
  exit 1
fi

./scripts/check-no-secrets.sh

# Prints "ALL", or the changed workspace locations separated by spaces (empty when none changed).
changed_workspaces() {
  local base
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null) || { echo ALL; return; }
  CHANGED="$(git diff --name-only "$base"; git ls-files --others --exclude-standard)" node -e '
    // Workspaces from package.json, not `npm query` (which needs node_modules). Supports literal
    // paths and one trailing `/*`, the shapes npm workspaces use in practice.
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    const ws = globs.flatMap((g) => {
      if (!g.endsWith("/*")) return fs.existsSync(`${g}/package.json`) ? [g] : [];
      const dir = g.slice(0, -2);
      return fs.existsSync(dir)
        ? fs.readdirSync(dir).map((d) => `${dir}/${d}`).filter((p) => fs.existsSync(`${p}/package.json`))
        : [];
    });
    if (ws.length === 0) { console.log("ALL"); process.exit(0); }
    const hit = new Set();
    for (const f of process.env.CHANGED.split("\n").filter(Boolean)) {
      const w = ws.find((l) => f === l || f.startsWith(l + "/"));
      if (w) hit.add(w);
      else if (/^(package(-lock)?\.json|tsconfig[^/]*\.json|eslint\.config\.[cm]?js|\.eslintrc[^/]*)$/.test(f)) {
        console.log("ALL"); process.exit(0);
      }
    }
    console.log([...hit].join(" "));
  ' 2>/dev/null || echo ALL
}

if [ -f package.json ]; then
  scope=ALL
  [ "$FAST" = 1 ] && scope=$(changed_workspaces)
  if [ "$scope" = ALL ]; then
    npm run typecheck
    npm run lint
    npm run test
  elif [ -z "$scope" ]; then
    echo "landing-checks --fast: no workspace changed; npm checks skipped"
  else
    for w in $scope; do
      echo "landing-checks --fast: $w"
      npm run typecheck -w "$w" --if-present
      npm run lint -w "$w" --if-present
      npm run test -w "$w" --if-present
    done
  fi
else
  echo "landing-checks: no package.json yet (before the repo-bootstrap ticket): npm checks not applicable"
fi

# Project-specific checks below. Guard a check that a later ticket creates with `if [ -x … ]; then …; fi` (never `[ … ] && …`: a false test as the last command fails the script) and say so.
# Put slow checks (emulators, e2e, full-stack runs) inside `if [ "$FAST" = 0 ]; then … fi`.

# --- Carnet project checks ---------------------------------------------------------------------
# Money safety: no floating-point arithmetic on money columns in the domain core (heuristic; the real
# guard is the Money type and its tests). Guarded: packages/domain exists only after M1-01.
if [ -d packages/domain/src ]; then
  if grep -rnE "parseFloat\(|Number\(.*(amount|minor)" packages/domain/src --include=*.ts | grep -v "\.test\.ts" | grep -v "// money-ok"; then
    echo "landing-checks: floating-point conversion of money in packages/domain (add '// money-ok' only at the Airwallex boundary)" >&2
    exit 1
  fi
  # The domain core imports no framework, SDK or I/O (ADR 0001).
  if grep -rnE "from ['\"](next|react|pg|drizzle-orm|@anthropic-ai/sdk|better-auth|node:(fs|net|http|https|child_process))" packages/domain/src --include=*.ts | grep -v "\.test\.ts"; then
    echo "landing-checks: packages/domain must not import frameworks, SDKs or I/O (ADR 0001)" >&2
    exit 1
  fi
fi
# The model package holds no payment credentials and no executor imports (ADR 0009).
if [ -d packages/agent/src ]; then
  if grep -rnE "AIRWALLEX_(API_KEY|CLIENT_ID)|from ['\"](@carnet/airwallex|\.\./.*executor)" packages/agent/src --include=*.ts | grep -v "\.test\.ts"; then
    echo "landing-checks: packages/agent must not reach Airwallex credentials or the executor (ADR 0009)" >&2
    exit 1
  fi
fi
if [ "$FAST" = 0 ]; then
  # Slow checks (full stack, e2e, evals) are added by the tickets that create them, guarded by -x.
  if [ -x scripts/check-fixtures-redacted.sh ]; then ./scripts/check-fixtures-redacted.sh; fi
  # Every STRIDE row in docs/architecture.md section 8 has a named test (M4-04).
  if [ -x scripts/check-stride-map.py ]; then python3 scripts/check-stride-map.py; fi
fi
