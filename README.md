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

**Getting started**
- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Run it](#run-it)
- [Try it in 60 seconds](#try-it-in-60-seconds)
- [Using the widget on your own page](#using-the-widget-on-your-own-page)

**Reference**
- [Architecture](#architecture)
- [Data model](#data-model)
- [API reference](#api-reference)
- [Widget configuration reference](#widget-configuration-reference)
- [Error reference](#error-reference)
- [Configuration](#configuration)

**Understanding it**
- [How the hard parts work](#how-the-hard-parts-work)
- [Operations](#operations)
- [Tests and acceptance probes](#tests-and-acceptance-probes)

**Meta**
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
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

## Prerequisites

| | Version | Why |
|---|---|---|
| **Docker** + Compose | any current | Postgres, and the one-command run |
| **Node** | 20.11+ (developed on 22) | only for local development and the test suite |

Nothing else. No API keys, no accounts, no credit card — the geo providers used in
development are free and keyless, and the email side effect writes to the log by
default.

Ports used: **3000** (API), **5500** (the customer test site), **55432** (Postgres —
deliberately not 5432, so it cannot collide with a Postgres already on your machine).

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

It prints two demo accounts, their widgets, and the ready-to-paste `<script>` tags:

```
  Login (both accounts share this password): demo-password-1234

  Tenant A  owner@acme.test     882aa1ab-20f7-4a48-af97-dc9085e22e67
    - Acme newsletter signup
        public id: sddtsb3bkqci93v5
        snippet:   <script src="http://localhost:3000/embed/v30a2c1550b28/widget.js?id=sddtsb3bkqci93v5" async></script>
    - Acme contact form
        public id: gj2pqsodgzsh4s9m

  Tenant B  owner@globex.test   adf42dfe-8d42-47db-8525-f673f0ef5230
    - Globex waitlist
        public id: 7c4y7qumm76jwk3v
```

Ids are random per install — yours will differ. Tenant B exists so multi-tenant
isolation can be *demonstrated*, not just asserted. The same values are written to
`seed-output.json` for scripts to read without parsing stdout.

Verify it is up:

```bash
curl -s localhost:3000/readyz
# {"status":"ready","database":"ok","widgetVersion":"v30a2c1550b28","jobs":{}}
```

### Local development

```bash
cp .env.example .env                     # then set JWT_SECRET: openssl rand -hex 32
docker compose up -d db                  # Postgres only
npm install
npm run migrate && npm run seed
npm run dev                              # API   http://localhost:3000  (watch mode)
npm run site                             # site  http://localhost:5500
```

### Every script

| Command | What it does |
|---|---|
| `npm run dev` | API in watch mode |
| `npm run dev:worker` | job worker as a separate process, in watch mode |
| `npm run site` | serves `customer-site/` on :5500 — the second origin |
| `npm run migrate` | applies pending migrations (also runs automatically at boot) |
| `npm run seed` | idempotent demo data; writes `seed-output.json` for scripts |
| `npm test` | 69 integration + unit tests against a real Postgres |
| `npm run test:watch` | same, in watch mode |
| `npm run probes` | acceptance probes 1–6 end to end; writes `.evidence/probes.log` |
| `npm run build` | compiles to `dist/` and copies the widget bundle + migrations |
| `npm start` | runs the built output |
| `npm run start:worker` | runs the built worker alone |
| `npm run lint` / `npm run typecheck` | eslint / tsc |

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

### Things worth trying

```bash
# the honeypot: a bot gets the same 202 a human gets…
curl -s -X POST localhost:3000/api/public/submissions -H 'content-type: application/json' \
  -d '{"widgetId":"<publicId>","data":{"email":"bot@spam.test","company_website":"http://spam.example"}}'
# …but the row lands under status=spam, never in the real list
curl -s 'localhost:3000/api/dashboard/submissions?status=spam' -H "authorization: Bearer $TOKEN" | jq

# the rate limit: a burst turns into 429s, and the API stays up for everyone else
for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:3000/api/public/submissions \
    -H 'content-type: application/json' \
    -d "{\"widgetId\":\"<publicId>\",\"data\":{\"email\":\"burst$i@example.com\"}}"
done; echo

# tenant isolation: tenant B cannot see tenant A's widget
TOKEN_B=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@globex.test","password":"demo-password-1234"}' | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/widgets/<tenantA-widget-uuid> \
  -H "authorization: Bearer $TOKEN_B"     # 404 — not 403, which would confirm it exists
```

---

## Using the widget on your own page

Paste the snippet anywhere. The widget renders itself immediately after its own
`<script>` tag:

```html
<script src="http://localhost:3000/embed/v30a2c1550b28/widget.js?id=YOUR_PUBLIC_ID" async></script>
```

To place it somewhere specific instead, add an element with a matching
`data-flyrank-widget` attribute and the widget mounts inside it:

```html
<div data-flyrank-widget="YOUR_PUBLIC_ID"></div>
<script src="http://localhost:3000/embed/v30a2c1550b28/widget.js?id=YOUR_PUBLIC_ID" async></script>
```

The script derives everything from its own tag — the API origin from `src`, the widget
id from `?id=`. Two optional attributes override that:

| Attribute | Purpose |
|---|---|
| `data-widget-id` | widget id, if you would rather not use `?id=` |
| `data-api-base` | API origin, when the script is served from somewhere other than the API |

**What it does on load:** fetches the widget config, injects one stylesheet, renders
the form (including the hidden honeypot), and starts a fill timer. On submit it POSTs
JSON with an `Idempotency-Key`, then shows either the widget's success message or a
per-field error.

**Multiple widgets on one page** are supported: they share one stylesheet but each
carries its own colours as CSS custom properties, so two customers' widgets cannot
repaint each other. Pasting the same snippet twice is a no-op — mounted ids are
tracked so a widget renders once.

**If the API is unreachable**, the widget logs to the console and renders nothing. It
never breaks the page it was pasted into.

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

### Layering

```
http/            routing, status codes, HTTP caching, CORS   ← knows about HTTP
  ↓
services/        business rules                              ← knows nothing about HTTP
  ↓
repositories/    the only files that write SQL               ← knows nothing about rules
  ↓
db/              pool, migrations
```

Two rules keep the boundaries honest:

1. **Nothing below `http/` mentions a status code.** Services throw an `AppError`
   carrying a status; exactly one middleware turns it into a response. That is why a
   service can be called from the job worker as easily as from a route.
2. **Nothing above `repositories/` writes SQL**, and every tenant-scoped repository
   method takes `tenantId` as a *required argument* — so a cross-tenant leak has to be
   written deliberately rather than forgotten.

### The three request paths

The system has exactly three actors, and conflating them is how this kind of service
gets a security hole. Each gets its own router and its own trust assumption:

| Path | Who | Auth | CORS | Trust |
|---|---|---|---|---|
| Widget management + dashboard | the owner | Bearer JWT | allow-listed origins | authenticated, still tenant-scoped in every query |
| Widget delivery (bundle + config) | any customer site | none | `*` | public read, projection only |
| Submission | any visitor | none | `*` | hostile until validated |

---

## Data model

```
tenants ──< widgets ──< submissions
                   └──< jobs (by payload reference)
```

### `tenants`

One row per customer. Everything else hangs off this id.

| Column | Notes |
|---|---|
| `id` | uuid, primary key |
| `email` | unique **case-insensitively**, via a functional index on `lower(email)` |
| `password_hash` | scrypt, with its cost parameters encoded in the string |

### `widgets`

| Column | Notes |
|---|---|
| `id` | uuid — the *private* id, used by the authenticated API |
| `public_id` | 16 random chars — the id in the `<script>` URL. Random, not sequential, so nobody can enumerate another tenant's config |
| `type` | `signup_form` \| `contact_form` \| `cta_popover` |
| `status` | `active` \| `paused` — a paused widget stops serving publicly |
| `fields` | jsonb — the field definitions the submission validator is built from |
| `display` | jsonb — position, theme, accent colour, delay |
| `honeypot_field` | per-widget, so it can be rotated |
| `allowed_origins` | text[] — empty means any origin (the normal case) |
| `revision` | bumped on every change; feeds the public config ETag |
| `deleted_at` | soft delete, so removing a widget does not cascade away its leads |

### `submissions`

| Column | Notes |
|---|---|
| `tenant_id` | **denormalised from `widgets`** so every dashboard query filters by tenant in one `WHERE` clause, never a join someone can forget |
| `status` | `stored` \| `spam` |
| `spam_reason` | `honeypot_filled` \| `submitted_too_fast` \| `excessive_links` \| `bot_user_agent` |
| `data` | jsonb — the validated fields, honeypot stripped |
| `ip_address` | `inet`; returned as text via `host()` |
| `geo_*` | all nullable — a submission with no location is still a successful submission |
| `idempotency_key` | with `widget_id`, a partial unique index |

### `jobs`

A transactional outbox. Rows are inserted in the same transaction as the submission
they refer to, so one exists if and only if the other does.

| Column | Notes |
|---|---|
| `type` | `submission.notify_email` \| `submission.webhook` |
| `status` | `pending` → `running` → `succeeded` \| `failed` \| `dead` |
| `attempts` / `max_attempts` | exhausting them marks the job `dead` and logs an alert |
| `run_at` | when the next attempt is due — how backoff is expressed |
| `locked_at` | a job `running` past the timeout is reclaimed |

### Indexes and why each exists

| Index | Serves |
|---|---|
| `tenants (lower(email))` unique | case-insensitive login |
| `widgets (public_id)` unique | every public config request |
| `widgets (tenant_id, created_at DESC)` partial | the widget list |
| `submissions (widget_id, created_at DESC)` | per-widget lead list |
| `submissions (tenant_id, created_at DESC)` | the dashboard's main list |
| `submissions (tenant_id, country_code)` partial | the geo breakdown |
| `submissions (widget_id, idempotency_key)` unique partial | **idempotency enforcement** |
| `jobs (status, run_at)` partial | the worker's claim query |

### Migrations

Plain `.sql` files in `src/db/migrations/`, applied in filename order by a runner that:

- takes a **Postgres advisory lock**, so several replicas booting together is safe;
- records a **SHA-256 of each file**, and refuses to start if an already-applied
  migration has changed — you add a new migration rather than editing history;
- wraps **each migration in its own transaction**, so a failure leaves everything
  before it applied and that one fully rolled back.

Migrations run automatically at boot, which is what makes `docker compose up` a single
command on a clean machine.

---

## API reference

Base URL `http://localhost:3000`. All request and response bodies are JSON.

All errors share one shape:

```json
{ "error": { "code": "unprocessable_entity", "message": "Some fields are invalid",
             "details": [{ "path": "email", "message": "Must be a valid email address" }],
             "requestId": "5f2c…" } }
```

`requestId` is echoed in the `x-request-id` response header on every request and
appears on every log line for it — quote it when reporting a problem.

---

### Auth

#### `POST /api/auth/register` → `201`

```json
{ "email": "owner@acme.test", "name": "Acme Inc.", "password": "at-least-12-chars" }
```

```json
{ "tenant": { "id": "8cf512c0-…", "email": "owner@acme.test", "name": "Acme Inc.",
              "createdAt": "2026-08-31T12:00:00.000Z" },
  "token": "eyJhbGciOiJIUzI1NiIs…", "expiresIn": 86400 }
```

`409` if the email is taken (compared case-insensitively).

#### `POST /api/auth/login` → `200`

Same response shape. Returns `401 Invalid email or password` for both a wrong password
and an unknown account — deliberately indistinguishable, so this endpoint is not an
account-enumeration oracle.

#### `GET /api/auth/me` → `200`

Cheap way to check a stored token is still valid. Returns `{ "tenant": { … } }`.

> Both auth endpoints are rate limited to 20 requests per 15 minutes per IP.

---

### Widget management

All require `Authorization: Bearer <token>`.

#### `POST /api/widgets` → `201`

```json
{
  "name": "Acme newsletter signup",
  "type": "signup_form",
  "title": "Join the Acme newsletter",
  "description": "Product news once a month.",
  "buttonText": "Subscribe",
  "successMessage": "You are on the list.",
  "fields": [
    { "name": "email", "label": "Email address", "type": "email", "required": true,
      "placeholder": "you@example.com" },
    { "name": "consent", "label": "I agree to receive emails", "type": "checkbox",
      "required": true }
  ],
  "display": { "position": "inline", "theme": "light", "accentColor": "#4f46e5" },
  "notifyEmail": "leads@acme.test",
  "webhookUrl": "https://example.com/hooks/leads",
  "allowedOrigins": ["https://acme.example"],
  "honeypotField": "company_website"
}
```

Only `name`, `type`, `title` and `fields` are required. The response is
`{ "widget": { …, "embed": { … } } }`:

```json
{ "widget": {
    "id": "d44f2b57-…", "publicId": "sddtsb3bkqci93v5", "revision": 1,
    "embed": {
      "version": "v30a2c1550b28",
      "scriptUrl": "http://localhost:3000/embed/v30a2c1550b28/widget.js?id=sddtsb3bkqci93v5",
      "configUrl": "http://localhost:3000/api/public/widgets/sddtsb3bkqci93v5/config",
      "snippet": "<script src=\"…\" async></script>",
      "snippetWithPlaceholder": "<div data-flyrank-widget=\"…\"></div>\n<script src=\"…\" async></script>"
    } } }
```

#### `GET /api/widgets?limit=25&offset=0` → `200`

`{ "widgets": [ … ], "pagination": { "total": 3, "limit": 25, "offset": 0 } }`.
`limit` is 1–100.

#### `GET /api/widgets/:id` → `200`

Another tenant's id returns **`404`, not `403`** — a `403` would confirm the id exists.

#### `PATCH /api/widgets/:id` → `200`

Any subset of the create body; at least one field. Bumps `revision`, which changes the
public config ETag so browsers pick the edit up when the short cache expires.

#### `DELETE /api/widgets/:id` → `204`

Soft delete. The widget stops serving publicly at once; its submissions stay in the
dashboard.

#### `GET /api/widgets/:id/embed` → `200`

`{ "embed": { … } }` — the same object as on create, regenerated against the current
bundle version.

> The authenticated API is rate limited to 300 requests/minute per IP.

---

### Widget delivery — public, no auth

#### `GET /embed/:version/widget.js` → `200`

```
Content-Type: application/javascript; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
x-widget-version: v30a2c1550b28
```

`:version` is a hash of the file's own contents, so this response is genuinely
immutable. A **stale version redirects (`302`) to the current one**, preserving
`?id=`, so a customer who cached the snippet itself keeps working across a release.

#### `GET /widget.js?id=…` → `200`

The same bytes at a stable URL, with `Cache-Control: public, max-age=300,
stale-while-revalidate=600` — short, because *this* URL's content changes on release.

#### `GET /api/public/widgets/:publicId/config` → `200`

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
ETag: "dbce940fd8426c15"
Vary: Origin
Access-Control-Allow-Origin: *
```

```json
{ "id": "sddtsb3bkqci93v5", "type": "signup_form", "title": "Join the list",
  "description": null, "buttonText": "Submit",
  "successMessage": "Thanks! We will be in touch.",
  "fields": [ … ], "display": {}, "honeypotField": "company_website", "revision": 1 }
```

A **projection, not the row**: `tenantId`, `webhookUrl` and `notifyEmail` are never in
it. Send `If-None-Match` to get a `304`. `404` for an unknown, paused or deleted
widget.

#### `GET /api/public/version` → `200`

`{ "widgetVersion", "bundlePath", "bundleBytes", "baseUrl" }` — lets a page confirm
which bundle is live.

---

### Public submission

#### `OPTIONS /api/public/submissions` → `204`

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: content-type,accept,idempotency-key,x-request-id
Access-Control-Max-Age: 86400
```

#### `POST /api/public/submissions` → `202`

```
Content-Type: application/json
Origin: https://any-customer-site.example
Idempotency-Key: 05a51602-…            (optional but recommended)
```

```json
{ "widgetId": "sddtsb3bkqci93v5",
  "data": { "email": "visitor@example.com", "consent": true },
  "elapsedMs": 8421,
  "pageUrl": "https://acme.example/pricing" }
```

| Field | Required | Notes |
|---|---|---|
| `widgetId` | yes | the **public** id, not the uuid |
| `data` | yes | validated against that widget's own field definitions, strictly |
| `elapsedMs` | no | ms the form was on screen; a spam signal |
| `pageUrl` | no | stored for the dashboard |

```json
{ "ok": true, "id": "f11e940f-…", "message": "Thanks! We will be in touch." }
```

| Status | When |
|---|---|
| `202` | accepted (**also returned for a caught bot**, with `"id": null` — deliberately indistinguishable) |
| `200` | idempotent replay; `Idempotent-Replay: true`, `"duplicate": true`, same id |
| `400` | body is not valid JSON |
| `403` | widget has an origin allow-list and this origin is not on it |
| `404` | unknown, paused or deleted widget |
| `413` | body over `SUBMISSION_BODY_LIMIT_BYTES` (16 KiB default) |
| `422` | a field failed validation, or a key the widget never declared was present |
| `429` | per-IP or per-widget limit; `Retry-After` + draft-7 `RateLimit` headers |

Responses are always `Cache-Control: no-store`.

---

### Dashboard

All require `Authorization: Bearer <token>`. All responses are
`Cache-Control: private, no-store`.

#### `GET /api/dashboard/submissions` → `200`

| Query | Notes |
|---|---|
| `widgetId` | uuid; **`404` if it is not yours**, rather than a plausible empty page |
| `status` | `stored` \| `spam` |
| `from` / `to` | ISO dates; `from` must precede `to` |
| `limit` / `offset` | 1–100, default 25 |

```json
{ "submissions": [ { "id": "…", "widgetId": "…", "tenantId": "…", "status": "stored",
    "spamReason": null, "data": { … }, "email": "visitor@example.com",
    "ipAddress": "203.0.113.42", "userAgent": "…", "origin": "http://localhost:5500",
    "referer": "…", "pageUrl": "…", "geoProvider": "mock-a", "geoStatus": "enriched",
    "country": "Germany", "countryCode": "DE", "region": "Berlin", "city": "Berlin",
    "latitude": 52.52, "longitude": 13.405, "idempotencyKey": null,
    "createdAt": "2026-08-31T17:55:32.472Z" } ],
  "pagination": { "total": 2, "limit": 25, "offset": 0 } }
```

#### `GET /api/dashboard/submissions/:id` → `200`

`{ "submission": { … } }`. `404` if it belongs to another tenant.

#### `GET /api/dashboard/stats?days=30&granularity=day` → `200`

`days` 1–365 (default 30), `granularity` `day` \| `hour` (default `day`).

```json
{ "window": { "since": "2026-08-01T…", "days": 30, "granularity": "day" },
  "totals": { "submissions": 5, "stored": 4, "spam": 1, "enriched": 2, "last24h": 5 },
  "timeseries": [ { "bucket": "2026-08-31T00:00:00.000Z", "stored": 4, "spam": 1 } ],
  "widgets": [ { "widgetId": "…", "name": "Newsletter", "publicId": "…",
                 "stored": 3, "spam": 1, "lastSubmissionAt": "2026-08-31T…" } ],
  "geo": [ { "countryCode": "DE", "country": "Germany", "submissions": 2 } ] }
```

A widget with no submissions still appears, with zeros — an empty row is information,
a missing row looks like a bug.

---

### Health

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness — touches no dependency; `{ "status": "ok", "uptimeSeconds": 42 }` |
| `GET /readyz` | readiness — checks Postgres and reports job-queue counts; `503` when the database is unreachable |

---

### Webhooks (outgoing)

If a widget has a `webhookUrl`, each non-spam submission triggers one `POST`:

```
POST https://your-endpoint.example
x-flyrank-event: submission.created
x-flyrank-delivery: <submission id>        ← de-duplicate on this
user-agent: flyrank-widget-platform/1.0
```

```json
{ "event": "submission.created",
  "submission": { "id": "…", "widgetId": "…", "createdAt": "…", "data": { … },
    "geo": { "status": "enriched", "provider": "mock-a", "country": "Germany",
             "countryCode": "DE", "city": "Berlin" } } }
```

Any non-2xx response is a failure and is retried with backoff. Deliveries have a
5-second timeout, and can arrive more than once — de-duplicate on `x-flyrank-delivery`.

---

## Widget configuration reference

### Field types

| `type` | Renders | Validation applied to submissions |
|---|---|---|
| `text` | `<input type="text">` | trimmed, `maxLength` (default 2000) |
| `email` | `<input type="email">` | trimmed, lowercased, valid address, ≤ 320 chars |
| `tel` | `<input type="tel">` | trimmed, 5–40 chars of digits and `+()-.` |
| `textarea` | `<textarea>` | trimmed, `maxLength` (default 5000) |
| `select` | `<select>` | must be one of `options` (at least one required) |
| `checkbox` | `<input type="checkbox">` | required ⇒ must be `true`, not merely present |

Field object: `{ name, label, type, required?, placeholder?, options?, maxLength? }`.
`name` must match `/^[a-z][a-z0-9_]*$/i` — it becomes an HTML input name, a JSON key
and a dashboard column header. Names must be unique and must not collide with
`honeypotField`. Maximum 25 fields.

An optional field left blank is treated as absent, not as `""` — so an empty optional
email does not fail the email check.

### Display options

| Key | Values | Effect |
|---|---|---|
| `position` | `inline` (default), `bottom-right`, `bottom-left` | inline renders in place; the others float and get a close button |
| `theme` | `light` (default), `dark` | per-widget, applied as CSS custom properties |
| `accentColor` | hex, e.g. `#4f46e5` | button, focus ring, checkbox |
| `delaySeconds` | 0–120 | hide the widget for N seconds after load |

### Other widget options

| Key | Notes |
|---|---|
| `honeypotField` | default `company_website`; must not collide with a real field |
| `allowedOrigins` | empty (default) = any origin. Entries are scheme + host + optional port, no path |
| `webhookUrl` | http(s) only — the server fetches it |
| `notifyEmail` | address for the confirmation email job |
| `status` | `paused` stops public serving without deleting |

---

## Error reference

| Code | Status | Typical cause |
|---|---|---|
| `bad_request` | 400 | malformed JSON body |
| `unauthorized` | 401 | missing, malformed or expired Bearer token |
| `forbidden` | 403 | origin not on a widget's allow-list, or on the admin API's |
| `not_found` | 404 | unknown id — **or one belonging to another tenant** |
| `conflict` | 409 | email already registered |
| `payload_too_large` | 413 | body over the configured limit |
| `unprocessable_entity` | 422 | schema failure; `details[]` carries `path` + `message` per field |
| `too_many_requests` | 429 | rate limit; `error.scope` is `ip`, `widget`, `auth` or `admin` |
| `internal_error` | 500 | unexpected — the real message goes to the log, never the response |

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

### Caching

Two different problems, two different answers:

- **The bundle** changes rarely and must never be stale. Its URL contains a hash of
  its contents, so it is `immutable, max-age=1y`, and a release is picked up instantly
  because it lives at a new URL.
- **The config** changes whenever the owner edits the widget. `max-age=60` +
  `stale-while-revalidate` + an ETag derived from `revision` and `updated_at`, so an
  edit lands within a minute and revalidation costs a `304`, not a payload.

Express's automatic ETag is **disabled** — every route states its caching explicitly
rather than inheriting a guess.

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

## Operations

### Logging

Structured JSON via pino. Every request gets an `x-request-id` (an inbound one is
honoured, otherwise generated) that appears on every log line for that request and in
every error body. `/healthz` and `/readyz` are excluded from request logging — they
are high-volume and would drown everything that matters.

```bash
docker compose logs -f api                       # follow
docker compose logs api | grep '"level":50'      # errors only
docker compose logs api | grep 'job_dead'        # jobs that exhausted their retries
```

### Running the worker separately

By default the job worker runs inside the API process. To run it as its own
process or container:

```bash
RUN_WORKER_IN_PROCESS=false npm start     # API without a worker
npm run start:worker                      # the worker alone
```

Several workers can run at once — `FOR UPDATE SKIP LOCKED` gives each a disjoint
batch. **Do not** leave `RUN_WORKER_IN_PROCESS=true` on the API while also running a
standalone worker against the same database unless you intend both to compete for
jobs.

### Graceful shutdown

`SIGTERM`/`SIGINT` stops accepting connections, drains in-flight requests, lets the
current job batch finish, then closes the pool. The Docker image runs under `tini` so
the signal actually reaches Node.

### Local mail catcher

```bash
docker compose --profile mail up          # Mailpit UI at http://localhost:8025
# then: EMAIL_TRANSPORT=smtp, SMTP_HOST=mailpit, SMTP_PORT=1025
```

### Exercising the real geo providers

`localhost` has no public location, so enrichment is skipped for it. To use the real
free APIs by hand, set `TRUST_PROXY_HOPS=1` and present a public IP:

```bash
curl -X POST localhost:3000/api/public/submissions \
  -H 'content-type: application/json' -H 'x-forwarded-for: 8.8.8.8' \
  -d '{"widgetId":"<publicId>","data":{"email":"a@b.com"}}'
```

Only do this locally — see the warning on `TRUST_PROXY_HOPS` below.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that change
behaviour most:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | base of the generated embed snippet |
| `ADMIN_CORS_ORIGINS` | `http://localhost:3000` | allow-list for the authenticated API |
| `TRUST_PROXY_HOPS` | `0` | proxies to trust for `X-Forwarded-For`. **Leave at 0 unless a proxy strips the header** — otherwise any client can spoof its IP past the rate limit |
| `DATABASE_URL` | — | required |
| `TEST_DATABASE_URL` | — | used when `NODE_ENV=test`; the suite truncates it |
| `JWT_SECRET` | — | required, ≥ 32 chars: `openssl rand -hex 32` |
| `JWT_TTL_SECONDS` | `86400` | token lifetime |
| `SUBMISSION_BODY_LIMIT_BYTES` | `16384` | over this → `413` |
| `RATE_LIMIT_IP_MAX` / `_WINDOW_SECONDS` | `10` / `60` | per-IP submission budget |
| `RATE_LIMIT_WIDGET_MAX` / `_WINDOW_SECONDS` | `60` / `60` | per-widget submission budget |
| `SPAM_MIN_FILL_MS` | `1200` | faster than this is a bot; `0` disables |
| `GEO_PROVIDERS` | `ip-api,ipapi-co` | ordered chain; `mock-a`/`mock-b` are deterministic |
| `GEO_FORCE_DOWN` | *(empty)* | force providers "down" to demonstrate the fallback |
| `GEO_TIMEOUT_MS` | `1500` | per-provider deadline |
| `EMAIL_TRANSPORT` | `log` | `log`, `smtp` (Mailpit), or `fail` to prove side-effect safety |
| `JOB_POLL_INTERVAL_MS` | `1000` | worker poll interval |
| `JOB_MAX_ATTEMPTS` | `5` | attempts before a job is marked `dead` |
| `RUN_WORKER_IN_PROCESS` | `true` | `false` when running `npm run start:worker` separately |
| `LOG_LEVEL` | `info` | pino level |

A bad value fails the boot with a per-variable message rather than surfacing later as
a runtime error.

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
needs, and writes a full transcript to `.evidence/probes.log`. It refuses to run if
another API process shares the job queue, because a stray worker would silently
service the jobs a probe needs to observe failing. See [EVIDENCE.md](EVIDENCE.md) for
pasted output.

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

Also: [DESIGN.md](DESIGN.md) (the one-page design doc), [EVIDENCE.md](EVIDENCE.md)
(one proof per requirement), [BUILDLOG.md](BUILDLOG.md) (AI-usage log),
[capstone.yaml](capstone.yaml) (the evaluator's manifest).

---

## Troubleshooting

**`Migration 001_init.sql has changed since it was applied`**
An applied migration's file no longer matches its recorded checksum. Intended
behaviour — it stops the database and the repo disagreeing about the schema. In
development: `docker compose down -v` and start again. In a real deployment: add a new
migration instead of editing an old one.

**Widget renders but submissions fail with a CORS error in the console**
Check the browser's network tab for the `OPTIONS` preflight. If it never appears, the
request is being blocked before it leaves. If it returns a non-2xx, the widget id in
`?id=` is probably wrong — the preflight is answered regardless, so look at the `POST`
that follows.

**Every submission returns `429` immediately**
Something is sharing your per-IP budget, or `RATE_LIMIT_IP_MAX` is set very low. Note
that with `TRUST_PROXY_HOPS=0` all local traffic counts as one client.

**Geo is always `"geoStatus": "skipped"`**
Expected for local traffic: `127.0.0.1` and private ranges have no public location.
See [Exercising the real geo providers](#exercising-the-real-geo-providers).

**`npm run probes` exits saying another API process shares the queue**
Stop the compose API (`docker compose stop api`) or any `npm run dev` still running.
A second worker would service the failing jobs probe 5 needs to observe.

**Widget shows an old version after a release**
`/widget.js` is cached for 5 minutes by design. Use the versioned URL, or wait it out.

**Port already in use**
3000, 5500 and 55432 are the three. Postgres is on 55432 specifically to avoid a clash
with a local 5432.

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
