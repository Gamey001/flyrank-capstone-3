# Evidence

One pasted proof per requirement box in Section 6 of the brief, plus the six
acceptance probes.

Everything below is **real output**, captured on 2026-08-31 from
`npm run probes` (full transcript in `.evidence/probes.log`) and `npm test`.
Bearer tokens are redacted by the probe script; nothing else is edited.

Reproduce all of it:

```bash
docker compose up -d db
npm ci && npm run migrate && npm run seed
npm test          # 69 tests
npm run probes    # acceptance probes 1-6
```

---

## Test suite

```
 ✓ test/submissions.test.ts       (18 tests)
 ✓ test/side-effects.test.ts      (10 tests)
 ✓ test/widget-delivery.test.ts   (11 tests)
 ✓ test/dashboard.test.ts          (8 tests)
 ✓ test/auth-tenancy.test.ts       (8 tests)
 ✓ test/enrichment.test.ts         (8 tests)
 ✓ test/rate-limit.test.ts         (5 tests)
 ✓ test/rate-limit-widget.test.ts  (1 test)

 Test Files  8 passed (8)
      Tests  69 passed (69)
```

`npm run lint` and `npm run typecheck` both pass clean.

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

Test: `auth-tenancy.test.ts` — *"rejects an unauthenticated request to the widget
API"*, *"rejects a token signed with the wrong secret"*.

Creating a widget with a valid token (probe setup):

```
  widget id  : d44f2b57-f0bc-47fa-9fad-f52765f9131a
  public id  : tiz8ek2irgf77uj2
```

### ☑ Multi-tenant isolation proven: tenant A cannot read or modify tenant B's widgets or submissions

```
--- multi-tenant isolation: tenant B must not see tenant A's data
  PASS  tenant B reading tenant A's widget -> 404
  PASS  unauthenticated widget list -> 401
  PASS  tenant B's submission count -> 0
```

Isolation is enforced in SQL — `tenant_id` is a required argument of every
repository read — not in a handler that could be forgotten. Another tenant's id
answers `404` rather than `403`, because a `403` would confirm the id exists.

Tests (`auth-tenancy.test.ts`):

- *"hides another tenant's widget from read, update and delete"* — `GET`, `PATCH`
  and `DELETE` all `404`, and the widget is verified unchanged afterwards.
- *"never lists another tenant's widgets"*
- *"never exposes another tenant's submissions"* — including that filtering
  explicitly by the other tenant's `widgetId` is a `404`, not an empty page.

### ☑ Embed snippet generated per widget

```
  snippet : <script src="http://localhost:3011/embed/v30a2c1550b28/widget.js?id=tiz8ek2irgf77uj2" async></script>
```

The snippet is generated, never stored, so every existing widget starts serving a
new bundle the moment one is released. `GET /api/widgets/:id/embed` returns the same
thing on demand.

---

# Widget delivery

### ☑ Public config endpoint serves a small payload with correct HTTP cache headers

```
$ curl -si 'http://localhost:3011/api/public/widgets/tiz8ek2irgf77uj2/config' -H 'origin: http://localhost:5500'
HTTP/1.1 200 OK
cache-control: public, max-age=60, stale-while-revalidate=300
etag: "dbce940fd8426c15"
vary: Origin
{"id":"tiz8ek2irgf77uj2","type":"signup_form","title":"Join the list","description":null,
 "buttonText":"Submit","successMessage":"Thanks! We will be in touch.",
 "fields":[{"name":"email","type":"email","label":"Email","required":true},
           {"name":"consent","type":"checkbox","label":"I agree","required":true}],
 "display":{},"honeypotField":"company_website","revision":1}

  PASS  conditional config request -> 304
```

365 bytes. `Vary: Origin` because the CORS headers vary with it. Revalidation with
`If-None-Match` returns `304` with no body.

The payload is a **projection**, not the row — `widget-delivery.test.ts` asserts
`tenantId`, `webhookUrl` and `notifyEmail` are absent, and that the whole thing is
under 2 KB.

### ☑ Widget JavaScript served as a versioned bundle (new version = new URL)

```
$ curl -sI 'http://localhost:3011/embed/v30a2c1550b28/widget.js'
HTTP/1.1 200 OK
Content-Type: application/javascript; charset=utf-8
cache-control: public, max-age=31536000, immutable
x-widget-version: v30a2c1550b28
```

The version is a SHA-256 prefix of the file's own contents, computed at boot. Same
content → same URL → cacheable for a year with no risk of staleness; changed content
→ a different URL, so a release is picked up instantly with no purge.

Observed across this build: editing `widget.js` moved the version
`vf0de3b45cc8b → vbc78be6d4135 → v95db10fbc8fa → v30a2c1550b28`, with no
configuration change at any point.

The unversioned `/widget.js` gets a short cache instead, because that path's content
*does* change:

```
cache-control: public, max-age=300, stale-while-revalidate=600
```

A request for a stale version redirects to the current one, preserving `?id=`, so a
customer who cached the snippet itself keeps working
(`widget-delivery.test.ts` — *"redirects an outdated bundle version…"*).

### ☑ The widget renders on a page served from a different origin than the API

Verified in Chrome against the compose stack: the customer page is served from
`http://localhost:5500`, the API from `http://localhost:3000` — two different
origins. Both seeded widgets render from one `<script>` tag each, and a form
submitted in the browser produced this row:

```json
{
  "id": "490f7a10-fa30-4e3f-8fe0-2edaa7b31b23",
  "status": "stored",
  "data": { "email": "grace@hopper.example", "consent": true, "first_name": "Grace" },
  "userAgent": "Mozilla/5.0 (Macintosh…) Chrome/150.0.0.0 Safari/537.36",
  "origin": "http://localhost:5500",
  "referer": "http://localhost:5500/",
  "pageUrl": "http://localhost:5500/",
  "idempotencyKey": "05a51602-2931-4e32-a986-ee53ecd95fa1"
}
```

The `origin`, `referer` and browser `userAgent` are the proof this came from a real
cross-origin page rather than curl. The `idempotencyKey` was generated by the widget.

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
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: content-type,accept,idempotency-key,x-request-id
Access-Control-Max-Age: 86400
Access-Control-Expose-Headers: x-request-id,retry-after,ratelimit-remaining,ratelimit-reset
```

And the actual request:

```
$ curl -si -X POST 'http://localhost:3011/api/public/submissions' \
    -H 'content-type: application/json' -H 'origin: http://localhost:5500' \
    -d '{"widgetId":"tiz8ek2irgf77uj2","data":{…},"pageUrl":"http://localhost:5500/pricing"}'
HTTP/1.1 202 Accepted
Access-Control-Allow-Origin: *
cache-control: no-store
{"ok":true,"id":"f11e940f-73b3-4b2c-84ac-fd5238a2b0aa","message":"Thanks! We will be in touch."}
```

The admin API uses the opposite policy — an allow-list — and refuses an unknown
origin with `403` (`submissions.test.ts` — *"restricts the admin API to the
configured origins"*).

### ☑ All incoming input validated; malformed and oversized payloads rejected with appropriate 4xx codes and JSON errors

```
$ curl -si … -d '{"widgetId":'
HTTP/1.1 400 Bad Request
{"error":{"code":"bad_request","message":"Request body is not valid JSON","requestId":"b96c71ad-…"}}

$ curl -si … -d '{"widgetId":"tiz8ek2irgf77uj2","data":{"email":"not-an-email","consent":false}}'
HTTP/1.1 422 Unprocessable Entity
{"error":{"code":"unprocessable_entity","message":"Some fields are invalid",
 "details":[{"path":"email","message":"Must be a valid email address"},
            {"path":"consent","message":"I agree is required"}],"requestId":"bb82b28e-…"}}

a 20083-byte body, against a 16384-byte limit:
HTTP/1.1 413 Payload Too Large
{"error":{"code":"payload_too_large","message":"Request body exceeds the maximum allowed size","requestId":"8dee92c1-…"}}

  PASS  malformed JSON -> 400
  PASS  invalid field data -> 422
  PASS  undeclared field -> 422
  PASS  oversized payload -> 413
  PASS  unknown widget id -> 404
```

Never a `500`. Every field is validated against a schema **built from that widget's
own field definitions**, with `.strict()` — so a payload carrying a key the widget
never declared is rejected rather than quietly stored:

```
{"error":{"code":"unprocessable_entity","message":"Some fields are invalid",
 "details":[{"path":"","message":"Unrecognized key(s) in object: 'is_admin'"}]}}
```

### ☑ Valid submissions stored safely, linked to the right widget and tenant

```
$ curl -s 'http://localhost:3011/api/dashboard/submissions?limit=2' -H 'authorization: Bearer <redacted>'
{"submissions":[
  {"id":"e0de705f-…","widgetId":"d44f2b57-…","tenantId":"2abf247e-…","status":"stored",
   "spamReason":null,"data":{"email":"probe1@example.com","consent":true},
   "email":"probe1@example.com","ipAddress":"203.0.113.42","userAgent":"curl/8.4.0",
   "origin":"http://localhost:5500","pageUrl":null,
   "geoProvider":"mock-a","geoStatus":"enriched","country":"Germany","countryCode":"DE",
   "region":"Berlin","city":"Berlin","latitude":52.52,"longitude":13.405,
   "idempotencyKey":null,"createdAt":"2026-08-31T17:55:32.472Z"},
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
`submissions.test.ts` fires **five simultaneous** requests with one key and asserts
exactly one row:

> *"keeps concurrent retries of the same key down to a single row"* ✓

---

# Abuse protection

### ☑ Rate limiting per IP and/or per widget returns 429 under a burst — and the API keeps serving legitimate traffic

```
--- starting API on :3011 with  RATE_LIMIT_IP_MAX=5 RATE_LIMIT_IP_WINDOW_SECONDS=60

12 rapid submissions from one IP:
   202 202 202 202 202 429 429 429 429 429 429 429
  PASS  7 of 12 requests were rejected with 429

HTTP/1.1 429 Too Many Requests
RateLimit-Policy: 5;w=60
RateLimit: limit=5, remaining=0, reset=60
Retry-After: 60
{"error":{"code":"too_many_requests","message":"Too many submissions from this source. Please slow down and try again shortly.","scope":"ip","retryAfterSeconds":60,"requestId":"851de991-…"}}

--- and the service is still up for everyone else
  PASS  health -> 200
  PASS  widget config -> 200
  PASS  dashboard -> 200
  PASS  another visitor's IP -> 202
```

The last line is the one that matters: a flooding client is rejected and **everyone
else is unaffected**. A per-IP limit that punished all visitors would be a denial of
service, not a defence against one.

A second, independent limiter caps a *distributed* flood — every request from a
different IP, so only the per-widget budget can catch it
(`rate-limit-widget.test.ts`):

> *"caps a distributed flood against one widget without touching another"* ✓ —
> `202 202 202` then `429`s, `error.scope === "widget"`, while a different widget
> still returns `202`.

Preflights are exempt from both, so a browser's `OPTIONS` cannot spend a visitor's
budget before they submit (`rate-limit.test.ts`).

### ☑ At least one spam-prevention technique demonstrably blocks a spam submission

```
$ curl -si … -d '{"widgetId":"tiz8ek2irgf77uj2",
                  "data":{"email":"bot@spam.test","consent":true,
                          "company_website":"http://spam.example"}}'
HTTP/1.1 202 Accepted
{"ok":true,"id":null,"message":"Thanks! We will be in touch."}

  PASS  the bot gets the same 202 a human gets -> 202
  PASS  2 submissions classified as spam, none in the real inbox
  PASS  the spam never appears among real leads -> 0
```

The bot gets an identical status and an identical body to a real visitor — a bot that
can tell it was caught is a bot that can iterate. Meanwhile the owner sees exactly
what happened:

```json
{"status":"spam","spamReason":"honeypot_filled","data":{"email":"bot@spam.test","consent":true}, …}
```

Note `data` has **no `company_website`** — the honeypot value is stripped before
storage; its only job was to be filled.

Two more signals, both tested:

- **fill time** — `elapsedMs: 40` → `spamReason: "submitted_too_fast"`; `elapsedMs:
  9000` passes through as a normal lead (`submissions.test.ts`).
- **content heuristics** — three or more links, or a self-identifying bot UA.

---

# Enrichment & safe side effects

### ☑ IP→geo enrichment uses a provider fallback chain; all providers down → submission still succeeds

```
--- starting API on :3011 with  (defaults)
provider A up  ->  mock-a enriched Germany
  PASS  provider A enriched the submission

--- starting API on :3011 with  GEO_FORCE_DOWN=mock-a
provider A DOWN ->  mock-b enriched Portugal
  PASS  fell back to provider B
  PASS  submission still enriched

--- starting API on :3011 with  GEO_FORCE_DOWN=mock-a,mock-b
both providers DOWN ->  none unavailable null
  PASS  submission still accepted with no geo provider -> 202
  PASS  stored without geo — degraded, not failed
```

Three stored rows, same endpoint, three configurations — enriched by A, enriched by
B, and stored with `geoStatus: "unavailable"` and every geo column `null`. **Degrade,
never fail.**

The providers are deterministic mocks on purpose: a fallback proof that depends on
ip-api.com actually being down is a coin flip, not a proof. The real providers
(`ip-api`, `ipapi-co`) are the default chain and are used in normal development.

`enrichment.test.ts` pins the whole contract with stub providers — A answers and B is
never called; A throws and B answers; both throw and the result is `unavailable`; a
provider that hangs past the timeout is treated as down; private/loopback IPs skip
the chain entirely; and:

> *"never throws, whatever a provider does"* ✓ — including a hostile provider and an
> empty chain.

### ☑ A failing confirmation email / webhook does not prevent the submission from being stored

```
--- starting API on :3011 with  EMAIL_TRANSPORT=fail
EMAIL_TRANSPORT=fail makes every confirmation email throw.

HTTP/1.1 202 Accepted
{"ok":true,"id":"fbf65b05-88e1-4c72-9356-aef48ae38714","message":"Thanks! We will be in touch."}

  PASS  submission accepted despite the broken mailer -> 202
  PASS  the row is stored (13 -> 14)
```

The failure is real, and it happens where the visitor cannot see it:

```json
{"level":40,"jobId":"189e001d-6778-4559-b1be-b63e9041ce91","type":"submission.notify_email",
 "attempts":1,"err":"EMAIL_TRANSPORT=fail: simulated mail provider outage",
 "msg":"job failed, scheduled for retry"}
```

```
$ curl -s 'http://localhost:3011/readyz'
{"status":"ready","database":"ok","widgetVersion":"v30a2c1550b28","jobs":{"succeeded":11,"pending":3}}

  PASS  the failing email job was retried in the background, not on the request path
```

This is safe **by construction**, not by a `try/catch` somebody remembered to write:
the email and webhook are rows in `jobs`, inserted in the same transaction as the
submission. The request path only writes rows.

`side-effects.test.ts` covers the rest:

- *"commits the submission and its notification job together"* — the transactional outbox.
- *"stores and returns success even when the mail provider is down"* / *"…when the
  webhook endpoint is unreachable"* (a real connection refusal to `127.0.0.1:9`).
- *"retries with backoff, then marks the job dead and raises an alert"* — the retry is
  scheduled in the future, not run immediately; after `max_attempts` the job is `dead`
  with an `alert: 'job_dead'` log line.
- *"marks a job succeeded once its handler stops failing"*.
- *"gives up immediately on a job type it has no handler for"* — a deploy bug is not a
  transient fault.
- *"reclaims a job abandoned by a worker that died mid-run"*.
- *"claims each job exactly once when workers run concurrently"* — `FOR UPDATE SKIP LOCKED`.

---

# Documentation

### ☑ README with architecture diagram, setup instructions, and API documentation; required files present

| File | Status |
|---|---|
| `README.md` | ASCII architecture diagram, one-command setup, seed step, full API reference, an honest limitations section |
| `DESIGN.md` | the Phase-1 one-page design doc — data model, embed flow, API contracts, one explicit non-goal |
| `capstone.yaml` | `run`, `seed`, `test`, `verify`, `base_url`, and every endpoint to probe |
| `EVIDENCE.md` | this file |
| `BUILDLOG.md` | AI-usage log: where it helped, where it was wrong, what changed |
| `.env.example` | every variable, with placeholders and a note on what each one does |
| `.gitignore` | `.env` ignored before the first commit |
| `LICENSE` | MIT |

---

# The shared requirements

| # | Requirement | Where |
|---|---|---|
| 1 | **Layered architecture** | `http/` (routing, status codes) → `services/` (rules, no HTTP) → `repositories/` (the only SQL) → `db/`. One `AppError` crosses the boundaries; one middleware turns it into a response. |
| 2 | **Validation at the boundary → clean 4xx, never a 500** | `http/middleware/validate.ts` replaces `req[target]` with the parsed value, so a handler cannot use the unvalidated version. Proved by probe 2 above. |
| 3 | **≥1 background job, retries + failure alert** | `jobs/worker.ts` — transactional outbox, `SKIP LOCKED` claim, exponential backoff capped at 5 min, dead-letter with an `alert: 'job_dead'` log line, stale-job reclaim. |
| 4 | **Real persistence: migrations, indexes, isolated tenants** | `src/db/migrations/*.sql` run by a checksum-verified runner under a Postgres advisory lock. Indexes for both dashboard list views, the geo aggregation, the idempotency constraint and the worker's claim query. Isolation proved above. |
| 5 | **Idempotency where it matters** | `Idempotency-Key` on the public submission endpoint, enforced by a partial unique index; concurrent-retry test above. |
| 6 | **Secrets clean: env only, never logged** | All secrets read and validated once in `config/env.ts`. The logger's `redact` list covers `authorization`, cookies, passwords, `JWT_SECRET`, `SMTP_PASSWORD`, `DATABASE_URL`. `.env` git-ignored from the first commit; `.env.example` committed. `auth-tenancy.test.ts` asserts a password hash never appears in a response. |
| 7 | **Cost tracked, if AI is used** | **Not applicable** — the running system makes no AI calls. AI was used to *write* the code, and that is logged in `BUILDLOG.md`. There is no per-request AI spend to attribute, so no budget guard exists. |
