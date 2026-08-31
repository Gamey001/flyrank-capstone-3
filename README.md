# Embeddable Widget & Lead-Capture Platform

A multi-tenant platform where a customer defines a widget, pastes **one line of
`<script>`** into any website, and every submission from that website is validated,
rate-limited, spam-filtered, enriched with geo data, stored, and shown back to them
in a dashboard.

FlyRank backend-track capstone. Node + TypeScript + Express 5 + PostgreSQL, all of it
free to run: `docker compose up --build`.

```html
<script src="http://localhost:3000/embed/v30a2c1550b28/widget.js?id=sddtsb3bkqci93v5" async></script>
```

That line is the whole product surface. Everything else — config, rendering, CORS,
submission, abuse protection, enrichment, notification — follows from it.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Run it](#run-it)
- [Try it in 60 seconds](#try-it-in-60-seconds)
- [API reference](#api-reference)
- [How the hard parts work](#how-the-hard-parts-work)
- [Configuration](#configuration)
- [Tests and acceptance probes](#tests-and-acceptance-probes)
- [Project layout](#project-layout)
- [Limitations](#limitations)

---

## What it does

| | |
|---|---|
| **Widget management** | Authenticated, tenant-isolated CRUD. One customer can never see or touch another's widgets or leads. |
| **Embed snippet** | Generated per widget from the current bundle version — existing widgets pick up a new release with no re-paste. |
| **Cached delivery** | Content-hashed, immutable bundle (1-year cache) + a small config payload (60s cache, ETag, 304s). |
| **Public submission API** | Any origin, preflight handled, every field validated against the widget's own definition, oversized and malformed payloads rejected as clean 4xx. |
| **Abuse protection** | Per-IP *and* per-widget rate limits, plus three spam signals (honeypot, fill-time, link heuristics). |
| **Enrichment** | IP → geo through a provider fallback chain that degrades to "no location" rather than failing. |
| **Safe side effects** | Confirmation email and webhooks run off the request path via a transactional outbox with retries and a dead-letter alert. |
| **Dashboard** | Submissions with filters and pagination, plus counts over time, per-widget totals and a geo breakdown. |

---

## Architecture

```
┌─ WIDGET OWNER ──────────── authenticated ────────────────────────────────────┐
│                                                                              │
│  POST /api/auth/login                       ──> JWT                          │
│  POST /api/widgets                          ──> widget + embed snippet       │
│  GET  /api/dashboard/submissions|stats      <── leads + aggregates           │
│         │                                                                    │
│         │  every query filters on tenant_id — isolation lives in SQL,        │
│         │  not in the handler                                                │
└─────────┼────────────────────────────────────────────────────────────────────┘
          v
   ┌────────────┐
   │  Postgres  │  tenants ──< widgets ──< submissions
   │            │                      └──< jobs (transactional outbox)
   └────────────┘
          ^
┌─────────┼─────────── CUSTOMER WEBSITE (any origin) ──────────────────────────┐
│         │                                                                    │
│  <script src=".../embed/v<hash>/widget.js?id=abc123"></script>               │
│         │                                                                    │
│         ├─> GET /embed/v<hash>/widget.js          public · immutable · 1 year│
│         └─> GET /api/public/widgets/abc123/config public · 60s + ETag · CORS *│
│                    │                                                         │
│                    v  renders the form (+ hidden honeypot, + fill timer)     │
└──────────────────────────────────────────────────────────────────────────────┘
                     │
┌────────────────────┼──── WEBSITE VISITOR ────────────────────────────────────┐
│                    v                                                         │
│  POST /api/public/submissions        (public · CORS · OPTIONS preflight)     │
│    │                                                                         │
│    ├─ body > 16 KiB ........................ 413, never a 500                │
│    ├─ rate limit per IP / per widget ....... 429, service stays up           │
│    ├─ envelope + per-field validation ...... 422 with per-field messages     │
│    ├─ idempotency key already seen ......... 200 replay, no second lead      │
│    ├─ honeypot / too fast / link-stuffing .. 202, stored as spam, bot none   │
│    │                                              the wiser                  │
│    ├─ geo: provider A ─fails→ B ─fails→ store anyway, without geo            │
│    ├─ INSERT submission ─┐                                                   │
│    │                     ├── same transaction ──> INSERT jobs                │
│    └─ 202 Accepted ──────┘                             │                     │
│                                                        v                     │
│                                          ┌─────────────────────────┐         │
│                                          │  worker (poll + claim)  │         │
│                                          │  FOR UPDATE SKIP LOCKED │         │
│                                          │  retry w/ backoff       │         │
│                                          │  exhausted -> dead+alert│         │
│                                          └───────────┬─────────────┘         │
│                                                      v                       │
│                                      confirmation email / webhook            │
│                                      (failure here cannot touch the lead)    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Layering.** `http/` (routing, validation, status codes) → `services/` (business
rules, no knowledge of HTTP) → `repositories/` (the only place that writes SQL) →
`db/`. Errors cross the boundaries as one `AppError` type; exactly one middleware
turns it into a response.

---

## Run it

### One command

```bash
git clone <this repo> && cd flyrank-capstone-widget-platform
docker compose up --build
```

That starts Postgres, migrates the schema on boot, serves the API on **:3000**, and
serves the "customer website" on **:5500** — a genuinely different origin, which is
what makes the CORS path real rather than theoretical.

Then seed demo data:

```bash
docker compose exec api node dist/db/seed.js
```

It prints two demo accounts, their widgets, and the ready-to-paste `<script>` tags.

### Local development

```bash
cp .env.example .env                     # then set JWT_SECRET: openssl rand -hex 32
docker compose up -d db                  # Postgres only
npm install
npm run migrate && npm run seed
npm run dev                              # API   http://localhost:3000
npm run site                             # site  http://localhost:5500
```

Requires Node 20.11+ (developed on 22) and Docker.

---

## Try it in 60 seconds

```bash
# 1. log in as the seeded demo tenant
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@acme.test","password":"demo-password-1234"}' | jq -r .token)

# 2. create a widget and read back the line you would paste into a website
curl -s -X POST localhost:3000/api/widgets -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "name": "Newsletter", "type": "signup_form", "title": "Join the list",
    "notifyEmail": "leads@acme.test",
    "fields": [{"name":"email","label":"Email","type":"email","required":true}]
  }' | jq -r '.widget.publicId, .widget.embed.snippet'

# 3. submit from a different origin, exactly as the widget does
curl -i -X POST localhost:3000/api/public/submissions \
  -H 'content-type: application/json' -H 'origin: http://localhost:5500' \
  -H 'idempotency-key: demo-1' \
  -d '{"widgetId":"<publicId>","data":{"email":"visitor@example.com"}}'

# 4. read it back
curl -s localhost:3000/api/dashboard/submissions -H "authorization: Bearer $TOKEN" | jq
```

Or open <http://localhost:5500>, paste the two seeded public widget ids into the setup
box, and watch the widgets render and submit from a page this API does not own.

---

## API reference

All errors share one shape:

```json
{ "error": { "code": "unprocessable_entity", "message": "Some fields are invalid",
             "details": [{ "path": "email", "message": "Must be a valid email address" }],
             "requestId": "5f2c…" } }
```

### Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/auth/register` | `{email, name, password}` (password ≥ 12 chars) | `201` `{tenant, token, expiresIn}` |
| `POST` | `/api/auth/login` | `{email, password}` | `200` `{tenant, token, expiresIn}` |
| `GET` | `/api/auth/me` | — | `200` `{tenant}` |

### Widget management — `Authorization: Bearer <token>`

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/widgets` | `201`. Body: `name, type, title, fields[]`, optional `description, buttonText, successMessage, display, honeypotField, allowedOrigins[], webhookUrl, notifyEmail, status`. |
| `GET` | `/api/widgets?limit&offset` | `200` `{widgets[], pagination}` |
| `GET` | `/api/widgets/:id` | `200`. Another tenant's id returns `404`, not `403` — a `403` would confirm it exists. |
| `PATCH` | `/api/widgets/:id` | `200`. Bumps `revision`, which busts the config ETag. |
| `DELETE` | `/api/widgets/:id` | `204`. Soft delete: stops serving, keeps the leads. |
| `GET` | `/api/widgets/:id/embed` | `200` `{embed: {snippet, scriptUrl, configUrl, version}}` |

`fields[]` entries: `{name, label, type, required, placeholder?, options?, maxLength?}`
with `type` one of `text | email | tel | textarea | select | checkbox`.

### Widget delivery — public

| Method | Path | Cache-Control |
|---|---|---|
| `GET` | `/embed/:version/widget.js` | `public, max-age=31536000, immutable` — a stale version redirects to the current one |
| `GET` | `/widget.js?id=…` | `public, max-age=300, stale-while-revalidate=600` |
| `GET` | `/api/public/widgets/:publicId/config` | `public, max-age=60, stale-while-revalidate=300` + `ETag`, `Vary: Origin`, `304` on revalidation |
| `GET` | `/api/public/version` | current bundle version and path |

The config is a projection, never the row: `tenantId`, `webhookUrl` and `notifyEmail`
are not in it.

### Public submission

```
POST /api/public/submissions          Origin: *      Idempotency-Key: <optional>
{ "widgetId": "<publicId>", "data": { … }, "elapsedMs": 8421, "pageUrl": "https://…" }
```

| Status | When |
|---|---|
| `202` | accepted (also returned for a caught bot — deliberately indistinguishable) |
| `200` | idempotent replay, `Idempotent-Replay: true`, same id |
| `400` | body is not valid JSON |
| `403` | widget has an origin allow-list and this origin is not on it |
| `404` | unknown or paused widget |
| `413` | body over `SUBMISSION_BODY_LIMIT_BYTES` |
| `422` | a field failed validation, or a key the widget never declared was present |
| `429` | per-IP or per-widget rate limit, with `Retry-After` and draft-7 `RateLimit` headers |

`OPTIONS` is answered with `204` and a 24-hour `Access-Control-Max-Age`.

### Dashboard — `Authorization: Bearer <token>`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/dashboard/submissions?widgetId&status&from&to&limit&offset` | `status` is `stored` or `spam` |
| `GET` | `/api/dashboard/submissions/:id` | |
| `GET` | `/api/dashboard/stats?days=30&granularity=day\|hour` | totals, timeseries, per-widget, geo breakdown |

### Health

`GET /healthz` — liveness, touches nothing.
`GET /readyz` — checks Postgres and reports job-queue counts; `503` when the database
is unreachable.

---

## How the hard parts work

### CORS — two policies, on purpose

The public widget endpoints allow **every** origin. That is the product: a widget
meant to be pasted into any website cannot have an allow-list that needs a deploy per
customer. They carry no credentials, and per-widget origin rules are enforced in the
submission service using the widget's own `allowedOrigins`.

The admin and dashboard API is the opposite — a named allow-list from
`ADMIN_CORS_ORIGINS`, credentials on, and an unknown origin gets a `403`.

Preflights are answered before anything else on the public router. A request that is
going to be rejected still needs a correct preflight, or the browser reports a CORS
error instead of the real `4xx` and the developer on the other side is debugging the
wrong thing.

### Rate limiting — two limiters, two threat models

- **Per IP** (`10/min` by default) stops one machine flooding.
- **Per widget** (`60/min`) caps a *distributed* flood against one customer's form,
  which has no shared IP for the first limiter to catch.

Preflights are exempt: they carry no payload and are cached by the browser, so
counting them would spend a visitor's budget before they submitted anything. A limited
client never affects anyone else — `test/rate-limit.test.ts` asserts that a second
visitor still gets a `202` while the first is being rejected.

### Spam — three signals

1. **Honeypot** — a field rendered off-screen with `tabindex="-1"` and
   `autocomplete="off"`. Humans never see it; form fillers fill it. Its name is
   per-widget so it can be rotated.
2. **Fill time** — the widget records how long the form was on screen. Under
   `SPAM_MIN_FILL_MS` (1.2s) was not filled by a person.
3. **Content heuristics** — three or more links, or a self-identifying bot UA.

All three answer `202` and store with `status = 'spam'` and a `spamReason`, so the
owner sees the volume and the reason while the bot learns nothing.

### Enrichment — degrade, never fail

`enrichWithGeo(ip)` tries providers in order and **never throws**. Private and
loopback addresses are skipped before any request (a provider cannot resolve
`127.0.0.1`, and asking burns quota to be told so). Every call has a hard timeout, so
a hung upstream cannot hold a request open.

Providers ship as a registry — `ip-api`, `ipapi-co`, and two deterministic mocks. The
mocks exist because a fallback proof that depends on a real provider actually being
down is a coin flip; `GEO_PROVIDERS=mock-a,mock-b` with `GEO_FORCE_DOWN=mock-a` makes
probe 4 reproducible on any machine, offline included.

### Safe side effects — a transactional outbox

The email and the webhook are not called on the request path at all. They are rows in
`jobs`, inserted **in the same transaction** as the submission, so a job exists if and
only if the lead does — no "stored but never notified", no "notified about nothing".

A polling worker claims batches with `FOR UPDATE SKIP LOCKED` (safe to run several
workers), retries with exponential backoff capped at five minutes, and after
`JOB_MAX_ATTEMPTS` marks the job `dead` and logs an alert line. Jobs left `running` by
a worker that died are reclaimed after two minutes.

This is why a broken mail provider cannot affect a visitor: the request path only
writes rows. Prove it with `EMAIL_TRANSPORT=fail`.

### Idempotency

The widget generates an `Idempotency-Key` per submit attempt and keeps it across
retries, clearing it only on success. A partial unique index on
`(widget_id, idempotency_key)` is the actual enforcement; the pre-check is just an
optimisation, and the `23505` handler catches the race that two concurrent retries
create. `test/submissions.test.ts` fires five simultaneous requests with one key and
asserts exactly one row.

### Secrets

Everything sensitive is read once, in `src/config/env.ts`, and validated there — the
process refuses to boot on a bad value instead of failing later inside a request. The
logger has a `redact` list covering `authorization`, cookies, passwords, `JWT_SECRET`,
`SMTP_PASSWORD` and `DATABASE_URL`, so a credential cannot reach a log line even if
someone logs a whole request object. `.env` is git-ignored; `.env.example` carries
placeholders. Passwords are hashed with `scrypt` from `node:crypto` — memory-hard, and
no native module to compile in the image. JWT verification pins `HS256`, because
without pinning a token could arrive signed with an algorithm we never intended to
accept.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that change
behaviour most:

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | base of the generated embed snippet |
| `ADMIN_CORS_ORIGINS` | `http://localhost:3000` | allow-list for the authenticated API |
| `TRUST_PROXY_HOPS` | `0` | proxies to trust for `X-Forwarded-For`. **Leave at 0 unless a proxy strips the header** — otherwise any client can spoof its IP past the rate limit |
| `SUBMISSION_BODY_LIMIT_BYTES` | `16384` | over this → `413` |
| `RATE_LIMIT_IP_MAX` | `10` / min | per-IP submission budget |
| `RATE_LIMIT_WIDGET_MAX` | `60` / min | per-widget submission budget |
| `SPAM_MIN_FILL_MS` | `1200` | faster than this is a bot; `0` disables |
| `GEO_PROVIDERS` | `ip-api,ipapi-co` | ordered chain; `mock-a`/`mock-b` are deterministic |
| `GEO_FORCE_DOWN` | *(empty)* | force providers "down" to demonstrate the fallback |
| `EMAIL_TRANSPORT` | `log` | `log`, `smtp` (Mailpit), or `fail` to prove side-effect safety |
| `RUN_WORKER_IN_PROCESS` | `true` | `false` when running `npm run start:worker` separately |

Local mail catcher: `docker compose --profile mail up`, then `EMAIL_TRANSPORT=smtp`,
`SMTP_HOST=mailpit`. Inbox at <http://localhost:8025>.

Exercising the *real* geo providers locally needs a public IP, which `localhost` is
not: set `TRUST_PROXY_HOPS=1` and send `X-Forwarded-For: 8.8.8.8`.

---

## Tests and acceptance probes

```bash
docker compose up -d db
npm test          # 69 integration + unit tests against a real Postgres
npm run probes    # acceptance probes 1-6, end to end, on a real port
```

The suite runs against a real database because the behaviours under test — unique
indexes, transactions, tenant filters, `SKIP LOCKED` — do not exist in a mock. It is
deterministic: no test touches a third party, and the rate-limit files configure their
own limits before importing the app so they cannot affect each other.

| File | Covers |
|---|---|
| `auth-tenancy.test.ts` | auth, account enumeration resistance, cross-tenant read/write/list/delete |
| `widget-delivery.test.ts` | CRUD, validation, immutable bundle, version redirect, config cache + ETag + 304 |
| `submissions.test.ts` | CORS + preflight, malformed/oversized/undeclared payloads, origin allow-list, all three spam signals, idempotency incl. concurrent |
| `rate-limit.test.ts` | 429 under burst, other visitors unaffected, preflight exemption, service stays up |
| `rate-limit-widget.test.ts` | distributed flood capped per widget |
| `enrichment.test.ts` | full fallback chain, timeouts, both-down degradation, private-IP skip |
| `side-effects.test.ts` | outbox atomicity, failing mailer/webhook, retry → backoff → dead + alert, concurrent claim safety |
| `dashboard.test.ts` | aggregations, filters, pagination, query validation |

`npm run probes` starts and restarts the API itself with the configuration each probe
needs, and writes a full transcript to `.evidence/probes.log`. See
[EVIDENCE.md](EVIDENCE.md) for pasted output.

---

## Project layout

```
src/
  config/env.ts            every env var, validated at boot
  db/                      pool, migration runner, .sql migrations, seed
  domain/models.ts         the shared vocabulary
  repositories/            the only files that write SQL
  services/                business rules — no HTTP, no status codes
    geo/                   provider interface, registry, fallback chain
  jobs/                    worker + handlers (email, webhook)
  http/
    middleware/            request id, CORS ×2, rate limits ×4, auth, validate, errors
    routes/                auth · widgets · public · dashboard · health
    validators/            zod schemas at the boundary
  widget/widget.js         the embeddable bundle (plain ES5-era JS, no build)
customer-site/             the "customer website" — a second origin
scripts/probes.sh          acceptance probes 1-6
test/                      integration + unit tests
```

---

## Limitations

Honest list of what this does not do.

- **Rate limiting is in-memory.** Correct for one instance; running several API
  replicas multiplies the effective limit by the replica count. A shared store (Redis,
  or a Postgres-backed store) is the fix.
- **The job worker polls once a second.** Fine at lead-capture volumes and it keeps
  the stack to one dependency, but it is not a queue for high throughput.
- **No owner-facing UI.** The dashboard is a JSON API — an explicit non-goal, see
  [DESIGN.md](DESIGN.md).
- **Visitor IPs are stored in full.** Real deployments handling EU traffic would want
  truncation or hashing plus a retention policy; consent capture and export/delete
  endpoints are listed as stretch goals and are not built.
- **JWTs cannot be revoked before they expire.** No refresh tokens, no session table.
- **The bundle is served unminified** and is not behind a real CDN — the cache headers
  are correct for one, but nothing is deployed.
- **`EMAIL_TRANSPORT=fail` is a demo switch.** It exists to make probe 5 reproducible
  and has no business in a production configuration.
- **Spam heuristics are simple** and would be evaded by a determined attacker. They
  are layered rather than clever on purpose; a proof-of-work challenge is the listed
  next step.

## Licence

MIT — see [LICENSE](LICENSE).
