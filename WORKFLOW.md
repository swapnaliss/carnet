# WORKFLOW — how Carnet is built

Where state lives, what to run, and how a cold session resumes.

## Where state lives
| What | Where |
|---|---|
| The plan (tickets) | `.github/plan/*.md` → GitHub issues (`.github/plan/issue-map.json` maps ids to issue numbers) |
| Milestones, resources | `.github/plan/milestones.json`, `.github/plan/resources.json` |
| Prerequisites | `.github/plan/prereqs.json` → `docs/PREREQS.md` (`python3 scripts/check-prereqs.py`) |
| Spend | `docs/budget.md` |
| Spec, decisions | `PROJECT.md`, `docs/architecture.md`, `docs/adr/` |
| Findings during the build | `BL-01` (the backlog issue), via `/backlog` |
| Secrets | `.env` only; their locations in `.dev-refs.md` |

## Commands (project-local, in `.claude/commands/`)
- `/status` — rebuild the picture from GitHub: milestones, in flight, blocked, next, the owner list.
- `/start <id>` — one ticket end to end. Phase 1 checks blockers **and prerequisites** (`needs:`); Phase 6b runs the design review for `frontend` tickets; Phase 7b is a best-effort backlog pass that never blocks the merge.
- `/start-milestone <n>` — run `python3 scripts/waves.py <n>` first (read-only plan, resource limits, holds, `Safe to spawn: YES`), then run it from a fresh session in the project directory. One worktree worker per ticket; a held or blocked ticket stops only its dependants; green PRs merge; the run ends with one owner list.
- `/gate <n>` — the milestone gate from a clean state (fresh stack, migrations, seed), then a non-blocking post-gate backlog sweep. The last gate runs after `M5-CLEANUP` from a clean clone.
- `/backlog <finding>` — log a finding to `BL-01`; fix it now only if it blocks the ticket's acceptance criteria.

## Order of work
`/start M0-00` → complete its owner checklist → `/start-milestone 0` in a fresh session → `/gate 0` → repeat for each milestone. Scope is set by the product, never the calendar: dates set the pace.

## Hard rules
- Every `gh` call, `git init` and write under `.claude/` runs outside the sandbox; temp files go under `$TMPDIR` (a scratch directory).
- The landing chain is `./scripts/landing-checks.sh` (`--fast` for workers); it runs the secret scan first and guards the private paths.
- Features are never deferred to pass a gate; a gate needs every ticket in its `blocked_by` done.
- Exclusive resources (`AIRWALLEX_SANDBOX`, `DEPLOY`) are never claimed by two tickets in one batch; `ANTHROPIC` is budgeted.
- Workflow files stay tracked during the build (worktree workers only receive tracked files); `M5-CLEANUP` untracks them. History is never rewritten.

## Resuming cold
1. `cd` to the project, start Claude Code, run `/status`.
2. Read `PROJECT.md` and the next ticket's file.
3. `python3 scripts/check-prereqs.py` shows what only the owner can provide.
4. Continue with `/start <id>` or `/start-milestone <n>`.

## Backlog hygiene
Every ticket runs a best-effort backlog pass before it merges (`/start` Phase 7b); every passed gate spawns a post-gate sweep (`/gate` step 8). Neither blocks progress; decisions go to the owner.
