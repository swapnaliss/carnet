---
title: "M2-01 · Document upload, validation, storage, hash, serving headers"
milestone: "M2 · Evidence to Answer"
labels: ["backend", "security"]
blocked_by: ["M1-04", "M1-10"]
estimate: "5h"
resources: []
needs: []
---

## Context

Documents are the evidence for every payment and every RFI answer (R1), and an upload endpoint is the largest attacker-controlled surface in the product (STRIDE: denial of service by upload abuse, tampering, information disclosure). ADR 0003 stores bytes in Postgres with a SHA-256; architecture §8 fixes the controls: magic-byte validation (PDF, JPEG, PNG), 5 MB default cap, PDF at most 20 pages, filenames sanitised to 50 characters (the Airwallex file upload limit in `docs/evidence/airwallex-rfi-contract.md`), attachment-only serving with `nosniff`, no URL fetching anywhere. The hash recorded here is the one the approval binds (ADR 0008) and the executor re-checks (M2-07).

## Scope

1. **`POST /api/v1/documents`** (multipart, one file per request, field `file`, optional `kind`: `invoice | contract | purchase_order | statement | other`), authenticated and scoped by `business_id` (M1-04). Reads the stream with a hard byte limit and rejects early with `413` when `UPLOAD_MAX_BYTES` (default 5242880) is exceeded, including when `Content-Length` lies.
2. **Validation by content, not by name or declared type**: magic bytes decide PDF (`%PDF-`), JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`); the stored `mime` is derived from the bytes. PDFs are parsed with `unpdf` 2.1.0 only to count pages (reject more than 20) and to reject encrypted or unparseable files; no PDF script is ever executed.
3. **Filename sanitising**: strip path parts, control and bidi characters, collapse whitespace, keep a safe character set, truncate to 50 characters preserving the extension that matches the detected type; empty result becomes `document`.
4. **Storage**: `documents` row (id, business_id, kind, filename, mime, size, sha256, bytes `bytea`, created_at); bytes and hash are immutable (no update path in the repository; a DB trigger or privilege rejects `UPDATE` of `bytes` and `sha256`). Identical bytes in the same business return the existing document (`200`, `deduplicated: true`), a new one returns `201`.
5. **Serving**: `GET /api/v1/documents/{id}` (authorised by `business_id`) returns the bytes with `Content-Disposition: attachment; filename="<sanitised>"`, `X-Content-Type-Options: nosniff`, the detected `Content-Type`, `Cache-Control: private, no-store`. `GET /api/v1/documents/{id}/meta` returns metadata only.
6. **No URL fetching anywhere**: no endpoint, field or job accepts a URL to download; a lint test greps the workspace for server-side fetches of user-supplied URLs.
7. **Per-session upload caps**: at most `UPLOAD_SESSION_MAX_FILES` (default 10) files and `UPLOAD_SESSION_MAX_BYTES` (default 25 MB) per session per hour, enforced with the M1-10 rate-limit table; over the cap returns `429` with `retry-after`.
8. **Audit entries**: every upload (accepted or rejected, with reason code), every download, and every dedupe write an audit entry through the audit port (actor, document id, sha256, size, never bytes).
9. **Errors** use the project error format (ADR 0004) with stable reason codes: `TOO_LARGE`, `UNSUPPORTED_TYPE`, `TOO_MANY_PAGES`, `ENCRYPTED_PDF`, `CORRUPT_FILE`, `SESSION_CAP`.

## Out of scope

- Extraction of facts (M2-02), the upload UI (M2-03 queue and evidence view call this endpoint)
- Object storage, virus scanning engines, OCR (ADR 0003 records the trigger for object storage)
- The judge-session caps for replay mode (M4-05)

## Acceptance Criteria

- [ ] A valid PDF, JPEG and PNG from `fixtures/dataset/` upload, and `GET` returns identical bytes whose sha256 equals the stored hash
- [ ] A `.pdf` name with PNG bytes is stored as `image/png`; an `.exe`, an HTML file renamed `.pdf`, an SVG, a ZIP and a polyglot (PDF header, ZIP body) are rejected `UNSUPPORTED_TYPE` or `CORRUPT_FILE`
- [ ] A body of `UPLOAD_MAX_BYTES + 1` is rejected `413` without buffering the whole body, also with a falsified `Content-Length`; a 21-page PDF is rejected `TOO_MANY_PAGES`; an encrypted PDF is rejected
- [ ] Filenames with `../../x`, 300 characters, unicode bidi override, newline, quotes, and only dots all come out as safe names of at most 50 characters (property test over generated names)
- [ ] The `GET` response carries `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store` for every stored type
- [ ] Another business's session gets `404` for the document; an unauthenticated request gets `401`
- [ ] Attempting to update `bytes` or `sha256` through the repository or SQL as the app role fails
- [ ] The eleventh upload in an hour from one session is `429`; counters survive a process restart (DB-backed)
- [ ] Each outcome writes an audit entry and none contains file bytes
- [ ] A fuzz test (at least 500 generated bodies: random bytes, truncated PDFs, mutated headers, huge multipart boundaries, duplicate `file` fields) never returns `5xx` and never stores a row for a rejected input
- [ ] The URL-fetch lint test passes

## Deliverables

- `apps/web/src/app/api/v1/documents/route.ts`, `.../[id]/route.ts`, `.../[id]/meta/route.ts`
- `packages/domain/src/documents/` (pure validators: magic bytes, filename, kind), `packages/db/src/schema/documents.ts`, migration, `packages/db/src/repos/documents.ts`
- Tests including `tests/fuzz/documents.fuzz.test.ts`; config keys `UPLOAD_MAX_BYTES`, `UPLOAD_SESSION_MAX_FILES`, `UPLOAD_SESSION_MAX_BYTES` documented in `.env.example`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-01.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- documents
npm run test -w packages/db -- documents
npm run test -w apps/web -- documents --reporter=json --outputFile="$T/web.json"
test "$(jq '[.testResults[].assertionResults[] | select(.status=="failed")] | length' "$T/web.json")" = 0
FUZZ_CASES=500 npm run test -w apps/web -- tests/fuzz/documents.fuzz.test.ts
! grep -rnE "fetch\((req|body|input|url)" apps/web/src/app/api/v1/documents
./scripts/check-no-secrets.sh
```

## Handoff → M2-02, M2-03, M2-07

M2-02 reads bytes and `kind` through the documents repository; M2-03 uploads through the endpoint; M2-07 re-hashes the stored bytes and compares with the approved sha256. Post an issue comment with the reason codes, the config keys, the repository function names and the audit action names.
