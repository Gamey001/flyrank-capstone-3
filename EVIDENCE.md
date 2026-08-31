# Evidence

One pasted proof per requirement box in Section 6 of the brief, plus the six
acceptance probes.

Everything below is **real output**, captured on 2026-08-31 from
`./scripts/probes.sh` (full transcript in `.evidence/probes.log`) and `pytest`.
Bearer tokens are redacted by the probe script; nothing else is edited.

Reproduce all of it:

```bash
docker compose up -d db
python3.11 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
python -m app.db.migrate && python -m app.db.seed
pytest                # 74 tests
./scripts/probes.sh   # acceptance probes 1-6
```

---

## Test suite

```
 tests/test_auth_tenancy.py       9 passed
 tests/test_widget_delivery.py   13 passed
 tests/test_submissions.py       18 passed
 tests/test_rate_limit.py         6 passed
 tests/test_enrichment.py         8 passed
 tests/test_side_effects.py      10 passed
 tests/test_dashboard.py         10 passed

 74 passed in 9.90s
```

`ruff check .`, `ruff format --check .` and `mypy app` (strict) all pass clean —
59 source files, no ignores beyond the two documented in `pyproject.toml`.

---

# Widget management

### ☑ Authenticated CRUD endpoints for widgets; requests without valid auth are rejected

```
$ curl -s -o /dev/null -w '%{http_code}' localhost:3011/api/widgets
401
$ curl -s localhost:3011/api/widgets
{"error":{"code":"unauthorized","message":"Missing Bearer token","requestId":"…"}}
```

From the probe run:

```
  PASS  unauthenticated widget list -> 401
```

Tests: `test_auth_tenancy.py` — *"rejects unauthenticated request"*, *"rejects token
signed with wrong secret"*.

Creating a widget with a valid token (probe setup):

```
  widget id  : 4486b5db-fd7d-48a5-8527-e31d85b6c7a9
  public id  : afpa76gcrtaqqjt7
```

### ☑ Multi-tenant isolation proven: tenant A cannot read or modify tenant B's widgets or submissions

```
--- multi-tenant isolation: tenant B must not see tenant A's data
  PASS  tenant B reading tenant A's widget -> 404
  PASS  unauthenticated widget list -> 401
  PASS  tenant B's submission count -> 0
```

Isolation is enforced in SQL — `tenant_id` is a required keyword argument of every
tenant-scoped repository function — not in a handler that could be forgotten. Another
tenant's id answers `404` rather than `403`, because a `403` would confirm the id
exists.

Tests (`test_auth_tenancy.py`):

- *"hides another tenant's widget"* — `GET`, `PATCH` and `DELETE` all `404`, and the
  widget is verified unchanged afterwards.
- *"never lists another tenant's widgets"*
- *"never exposes another tenant's submissions"* — including that filtering explicitly
  by the other tenant's `widgetId` is a `404`, not an empty page.

### ☑ Embed snippet generated per widget

```
  snippet : <script src="http://localhost:3011/embed/v30a2c1550b28/widget.js?id=afpa76gcrtaqqjt7" async></script>
```

Generated, never stored, so every existing widget starts serving a new bundle the
moment one is released. `GET /api/widgets/:id/embed` returns the same on demand.

---

# Widget delivery

### ☑ Public config endpoint serves a small payload with correct HTTP cache headers

```
$ curl -si 'http://localhost:3011/api/public/widgets/afpa76gcrtaqqjt7/config' -H 'origin: http://localhost:5500'
HTTP/1.1 200 OK
cache-control: public, max-age=60, stale-while-revalidate=300
etag: "16997c66e79d1551"
vary: Origin
access-control-allow-origin: *
{"id":"afpa76gcrtaqqjt7","type":"signup_form","title":"Join the list","description":null,
 "buttonText":"Submit","successMessage":"Thanks! We will be in touch.",
 "fields":[{"name":"email","label":"Email","type":"email","required":true},
           {"name":"consent","label":"I agree","type":"checkbox","required":true}],
 "display":{},"honeypotField":"company_website","revision":1}

  PASS  conditional config request -> 304
```

352 bytes. `Vary: Origin` because the CORS headers vary with it. Revalidation with
`If-None-Match` returns `304` and no body.

The payload is a **projection**, not the row — `test_widget_delivery.py` asserts
`tenantId`, `webhookUrl` and `notifyEmail` are absent and the whole thing is under 2 KB.

### ☑ Widget JavaScript served as a versioned bundle (new version = new URL)

```
$ curl -sI 'http://localhost:3011/embed/v30a2c1550b28/widget.js'
HTTP/1.1 200 OK
content-type: application/javascript; charset=utf-8
cache-control: public, max-age=31536000, immutable
x-widget-version: v30a2c1550b28
```

The version is a SHA-256 prefix of the file's own contents, computed at import. Same
content → same URL → cacheable for a year with no risk of staleness; changed content →
a different URL, so a release is picked up instantly with no purge.

Worth noting: the bundle is byte-identical to the one the earlier Node implementation
served, and both compute **the same version string** from it — the hash is a property
of the file, not the framework.

The unversioned `/widget.js` gets a short cache instead, because that path's content
*does* change:

```
cache-control: public, max-age=300, stale-while-revalidate=600
```

A request for a stale version redirects to the current one, preserving `?id=`, so a
customer who cached the snippet keeps working (`test_widget_delivery.py` —
*"outdated version redirects preserving id"*).

### ☑ The widget renders on a page served from a different origin than the API

Verified against the containerised stack: the customer page is served from
`http://localhost:5500`, the API from `http://localhost:3000` — two different origins.
The full browser sequence, replayed with a real browser User-Agent:

```
1. browser loads the page, fetches the bundle
   GET /widget.js -> 200 (13413 bytes)
2. bundle fetches the widget config (cross-origin)
   GET config -> 200
3. visitor submits: browser sends a preflight first
   OPTIONS -> 204
4. then the real POST
{"ok":true,"id":"75c5e50c-729a-4e08-b6da-340e60bb2cae","message":"You are on the list — check your inbox."}
```

and the stored row:

```
  data: {'email': 'grace@hopper.example', 'consent': True, 'first_name': 'Grace'}
  userAgent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Chrome/150.0.0.0 Safari/537.36
  origin: http://localhost:5500
  referer: http://localhost:5500/
  pageUrl: http://localhost:5500/
  idempotencyKey: D7BFFE62-B77D-4CB9-A18F-7FDF9962A713
```

The `origin`, `referer` and browser `userAgent` are what prove this came from a
cross-origin page rather than a same-origin call.

Reproduce: `docker compose up --build`, seed, then open <http://localhost:5500> and
paste the two seeded public widget ids into the setup box.

---

# Public submission API

### ☑ Cross-origin submissions work: CORS headers correct, preflight (OPTIONS) handled

```
$ curl -si -X OPTIONS 'http://localhost:3011/api/public/submissions' \
    -H 'origin: http://localhost:5500' \
    -H 'access-control-request-method: POST' \
    -H 'access-control-request-headers: content-type,idempotency-key'
HTTP/1.1 204 No Content
access-control-allow-origin: *
access-control-allow-methods: GET,POST,OPTIONS
access-control-allow-headers: content-type,accept,idempotency-key,x-request-id
access-control-max-age: 86400
access-control-expose-headers: x-request-id, retry-after, ratelimit, ratelimit-policy, idempotent-replay
```

And the actual request:

```
HTTP/1.1 202 Accepted
access-control-allow-origin: *
cache-control: no-store
{"ok":true,"id":"c9f8fdf7-f229-41bf-9d5f-2e7855fc4e9f","message":"Thanks! We will be in touch."}
```

The admin API uses the opposite policy — a named allow-list — and refuses an unknown
origin with `403` (`test_submissions.py` — *"admin API is restricted to configured
origins"*).

### ☑ All incoming input validated; malformed and oversized payloads rejected with appropriate 4xx codes and JSON errors

```
$ curl -si … -d '{"widgetId":'
HTTP/1.1 400 Bad Request
{"error":{"code":"bad_request","message":"Request body is not valid JSON","requestId":"44ee6d78-…"}}

$ curl -si … -d '{"widgetId":"afpa76gcrtaqqjt7","data":{"email":"not-an-email","consent":false}}'
HTTP/1.1 422 Unprocessable Entity
{"error":{"code":"unprocessable_entity","message":"Some fields are invalid",
 "details":[{"path":"email","message":"Must be a valid email address"},
            {"path":"consent","message":"I agree is required"}],"requestId":"ccd0ad2c-…"}}

a 20083-byte body, against a 16384-byte limit:
HTTP/1.1 413 Payload Too Large
{"error":{"code":"payload_too_large","message":"Request body exceeds the maximum allowed size","requestId":"c39c061c-…"}}

  PASS  malformed JSON -> 400
  PASS  invalid field data -> 422
  PASS  undeclared field -> 422
  PASS  oversized payload -> 413
  PASS  unknown widget id -> 404
```

Never a `500`. Every field is validated against a schema **built from that widget's own
field definitions**, strictly — so a payload carrying a key the widget never declared is
rejected rather than quietly stored:

```json
{"error":{"code":"unprocessable_entity","message":"Some fields are invalid",
 "details":[{"path":"","message":"Unrecognized key(s) in object: 'is_admin'"}]}}
```

The oversized case is worth calling out: FastAPI's exception handlers sit *inside* the
middleware stack, so the body-size middleware **returns** a 413 response rather than
raising — raising would escape the handlers and surface as the 500 this probe exists to
catch. That bug was present and caught during the port.

### ☑ Valid submissions stored safely, linked to the right widget and tenant

```
$ curl -s 'http://localhost:3011/api/dashboard/submissions?limit=2' -H 'authorization: Bearer <redacted>'
{"submissions":[
  {"id":"bd7ec414-…","widgetId":"4486b5db-…","tenantId":"24f44b55-…","status":"stored",
   "spamReason":null,"data":{"email":"probe1@example.com","consent":true},
   "email":"probe1@example.com","ipAddress":"8.8.8.8","userAgent":"curl/8.4.0",
   "origin":"http://localhost:5500","pageUrl":null,
   "geoProvider":"mock-a","geoStatus":"enriched","country":"Germany","countryCode":"DE",
   "region":"Berlin","city":"Berlin","latitude":52.52,"longitude":13.405,
   "idempotencyKey":null,"createdAt":"2026-08-31T20:46:41.930561+00:00"},
  …],"pagination":{"total":2,"limit":2,"offset":0}}

  PASS  dashboard lists the stored submissions (total=2)
```

**Idempotency** (shared requirement #5) — a retried POST must not create a second lead:

```
--- idempotency: the same key twice must not create two leads
  PASS  first request -> 202
  PASS  retried request -> 200
```

The replay carries `Idempotent-Replay: true` and the original id. Enforcement is a
partial unique index on `(widget_id, idempotency_key)`, not just the pre-check —
`test_submissions.py` fires **five simultaneous** requests with one key and asserts
exactly one row:

> *"concurrent retries still store one row"* ✓

---

# Abuse protection

### ☑ Rate limiting per IP and/or per widget returns 429 under a burst — and the API keeps serving legitimate traffic

```
--- starting API on :3011 with  RATE_LIMIT_IP_MAX=5 RATE_LIMIT_IP_WINDOW_SECONDS=60

12 rapid submissions from one IP:
   202 202 202 202 202 429 429 429 429 429 429 429
  PASS  7 of 12 requests were rejected with 429

HTTP/1.1 429 Too Many Requests
ratelimit-policy: 5;w=59
ratelimit: limit=5, remaining=0, reset=59
retry-after: 59
{"error":{"code":"too_many_requests","message":"Too many submissions from this source. Please slow down and try again shortly.","scope":"ip","retryAfterSeconds":59,"requestId":"e3ff5e10-…"}}

--- and the service is still up for everyone else
  PASS  health -> 200
  PASS  widget config -> 200
  PASS  dashboard -> 200
  PASS  another visitor's IP -> 202
```

The last line is the one that matters: a flooding client is rejected and **everyone else
is unaffected**. A per-IP limit that punished all visitors would be a denial of service,
not a defence against one.

A second, independent limiter caps a *distributed* flood — every request from a
different IP, so only the per-widget budget can catch it (`test_rate_limit.py`):

> *"caps a distributed flood without touching another widget"* ✓ — `202 202 202` then
> `429`s with `error.scope == "widget"`, while a different widget still returns `202`.

Preflights are exempt from both, so a browser's `OPTIONS` cannot spend a visitor's
budget before they submit.

### ☑ At least one spam-prevention technique demonstrably blocks a spam submission

```
$ curl -si … -d '{"widgetId":"afpa76gcrtaqqjt7",
                  "data":{"email":"bot@spam.test","consent":true,
                          "company_website":"http://spam.example"}}'
HTTP/1.1 202 Accepted
{"ok":true,"id":null,"message":"Thanks! We will be in touch."}

  PASS  the bot gets the same 202 a human gets -> 202
  PASS  2 submissions classified as spam, none in the real inbox
  PASS  the spam never appears among real leads -> 0
```

The bot gets an identical status and body to a real visitor — a bot that can tell it was
caught is a bot that can iterate. Meanwhile the owner sees exactly what happened:

```json
"status":"spam","spamReason":"honeypot_filled","data":{"email":"bot2@spam.test","consent":true}
```

Note `data` has **no `company_website`** — the honeypot value is stripped before storage;
its only job was to be filled.

Two more signals, both tested:

- **fill time** — `elapsedMs: 40` → `spamReason: "submitted_too_fast"`; `elapsedMs: 9000`
  passes through as a normal lead.
- **content heuristics** — three or more links, or a self-identifying bot UA.

---

# Enrichment & safe side effects

### ☑ IP→geo enrichment uses a provider fallback chain; all providers down → submission still succeeds

```
--- starting API on :3011 with  (defaults)
provider A up   ->  mock-a enriched Germany
  PASS  provider A enriched the submission

--- starting API on :3011 with  GEO_FORCE_DOWN=mock-a
provider A DOWN ->  mock-b enriched Portugal
  PASS  fell back to provider B
  PASS  submission still enriched

--- starting API on :3011 with  GEO_FORCE_DOWN=mock-a,mock-b
both providers DOWN ->  none unavailable None
  PASS  submission still accepted with no geo provider -> 202
  PASS  stored without geo — degraded, not failed
```

Three stored rows, same endpoint, three configurations — enriched by A, enriched by B,
and stored with `geoStatus: "unavailable"` and every geo column null. **Degrade, never
fail.**

The providers are deterministic mocks on purpose: a fallback proof that depends on
ip-api.com actually being down is a coin flip, not a proof. The real providers
(`ip-api`, `ipapi-co`) are the default chain and are used in normal development.

`test_enrichment.py` pins the whole contract with stub providers — A answers and B is
never called; A raises and B answers; both raise and the result is `unavailable`; a
provider that hangs past the timeout is treated as down; private, loopback **and RFC 5737
documentation** addresses skip the chain entirely; and:

> *"never raises whatever a provider does"* ✓ — including a provider returning garbage
> and an empty chain.

### ☑ A failing confirmation email / webhook does not prevent the submission from being stored

```
--- starting API on :3011 with  EMAIL_TRANSPORT=fail
EMAIL_TRANSPORT=fail makes every confirmation email throw.

HTTP/1.1 202 Accepted
  PASS  submission accepted despite the broken mailer -> 202
  PASS  the row is stored (13 -> 14)
```

The failure is real, and it happens where the visitor cannot see it:

```json
{"job_id": "3d594fa5-7d87-40ba-b112-fd03663536c7", "type": "submission.notify_email",
 "attempts": 1, "err": "EMAIL_TRANSPORT=fail: simulated mail provider outage",
 "event": "job failed, scheduled for retry"}
```

```
$ curl -s 'http://localhost:3011/readyz'
{"status":"ready","database":"ok","widgetVersion":"v30a2c1550b28","jobs":{"pending":3,"succeeded":91}}

  PASS  the failing email job was retried in the background, not on the request path
```

This is safe **by construction**, not by a `try/except` somebody remembered to write: the
email and webhook are rows in `jobs`, inserted in the same transaction as the submission.
The request path only writes rows.

`test_side_effects.py` covers the rest:

- *"commits submission and its jobs together"* — the transactional outbox.
- *"stores and succeeds when the mailer is down"* / *"…when the webhook is unreachable"*
  (a real connection refusal to `127.0.0.1:9`).
- *"retries then marks dead and alerts"* — the retry is scheduled in the future, not run
  immediately; after `max_attempts` the job is `dead` with an `alert="job_dead"` log line.
- *"marks succeeded once the handler stops failing"*.
- *"gives up immediately on an unknown job type"* — a deploy bug is not a transient fault.
- *"reclaims a job abandoned mid-run"*.
- *"claims each job exactly once under concurrency"* — `FOR UPDATE SKIP LOCKED`.

---

# Documentation

### ☑ README with architecture diagram, setup instructions, and API documentation; required files present

| File | Status |
|---|---|
| `README.md` | ASCII architecture diagram, one-command setup, seed step, full API reference, an honest limitations section |
| `DESIGN.md` | the Phase-1 design doc — data model, embed flow, API contracts, one explicit non-goal |
| `capstone.yaml` | `run`, `seed`, `test`, `verify`, `base_url`, `docs_url`, and every endpoint to probe |
| `EVIDENCE.md` | this file |
| `BUILDLOG.md` | AI-usage log: where it helped, where it was wrong, what changed |
| `.env.example` | every variable, with placeholders and a note on what each one does |
| `.gitignore` | `.env` ignored before the first commit |
| `LICENSE` | MIT |

Plus **interactive API docs generated from the code** at `/docs`, with the raw schema at
`/openapi.json`. `test_dashboard.py` asserts the schema is served and contains the public
submission and widget paths, so the docs cannot silently break.

---

# The shared requirements

| # | Requirement | Where |
|---|---|---|
| 1 | **Layered architecture** | `http/` (routing, status codes) → `services/` (rules, no HTTP) → `repositories/` (the only SQL) → `db/`. One `AppError` crosses the boundaries; one handler turns it into a response. |
| 2 | **Validation at the boundary → clean 4xx, never a 500** | Pydantic models for the envelope, `field_validation.py` for the per-widget contents. Proved by probe 2 above. |
| 3 | **≥1 background job, retries + failure alert** | `jobs/worker.py` — transactional outbox, `SKIP LOCKED` claim, exponential backoff capped at 5 min, dead-letter with an `alert="job_dead"` log line, stale-job reclaim. |
| 4 | **Real persistence: migrations, indexes, isolated tenants** | `app/db/migrations/*.sql` run by a checksum-verified runner under a Postgres advisory lock. Indexes for both dashboard list views, the geo aggregation, the idempotency constraint and the worker's claim query. Isolation proved above. |
| 5 | **Idempotency where it matters** | `Idempotency-Key` on the public submission endpoint, enforced by a partial unique index; concurrent-retry test above. |
| 6 | **Secrets clean: env only, never logged** | All secrets read and validated once in `config/settings.py`. The logger's redaction processor covers `authorization`, cookies, passwords, `jwt_secret`, `smtp_password`, `database_url`, and any `token`. `.env` git-ignored; `.env.example` committed. `test_auth_tenancy.py` asserts a password hash never appears in a response. |
| 7 | **Cost tracked, if AI is used** | **Not applicable** — the running system makes no AI calls. AI was used to *write* the code, logged in `BUILDLOG.md`. There is no per-request AI spend to attribute, so no budget guard exists. |
