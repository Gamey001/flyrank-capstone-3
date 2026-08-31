# Design — Embeddable Widget & Lead-Capture Platform

*Phase 1 deliverable. Written before the code; annotated afterwards where the build
changed my mind.*

## The problem

A customer defines a widget in an authenticated dashboard, pastes one `<script>` tag
into a website I do not control, and expects two things to be true forever after:
the widget renders fast on their page, and every lead a visitor submits reaches
their dashboard.

Everything hard about this follows from one fact: **the submission endpoint's client
is the open internet**. I cannot trust the payload, control the traffic, predict the
origin, or assume any third party I depend on is up.

## Three request paths, kept separate

The system has exactly three actors, and conflating them is how this kind of service
gets a security hole. Each path gets its own router, its own CORS policy, and its own
trust assumption.

| Path | Who | Auth | CORS | Trust |
|---|---|---|---|---|
| Widget management + dashboard | the owner | Bearer JWT | allow-listed origins | authenticated, still tenant-scoped in every query |
| Widget delivery (bundle + config) | any customer site | none | `*` | public read, projection only |
| Submission | any visitor | none | `*` | hostile until validated |

## Data model

```
tenants ──< widgets ──< submissions
                   └──< jobs (by payload reference)
```

**tenants** — one row per customer. Every other table carries `tenant_id`.

**widgets** — `public_id` (random, 16 chars) is what appears in the `<script>` URL;
the UUID primary key never leaves the authenticated API. Random rather than
sequential so nobody can walk the id space and read another tenant's config.
`revision` increments on every change and feeds the config ETag. Deletes are soft, so
a removed widget stops serving immediately without cascading its leads away.

**submissions** — `tenant_id` is denormalised from `widgets`. That is deliberate:
tenant isolation becomes one `WHERE` clause in every dashboard query rather than a
join somebody can forget. Geo columns are all nullable — a submission with no
location is a *successful* submission.

**jobs** — a transactional outbox. Side effects are enqueued in the same transaction
that stores the submission, so a job exists if and only if the row it refers to does.

Indexes: `(widget_id, created_at DESC)` and `(tenant_id, created_at DESC)` for the
dashboard's two list views; a partial `(tenant_id, country_code)` for the geo
breakdown; a partial unique `(widget_id, idempotency_key)` for retry safety; a
partial `(status, run_at)` for the worker's claim query.

## The embed flow

```
1. owner   POST /api/widgets                      -> widget + embed snippet
2. owner   pastes <script src=".../embed/v<hash>/widget.js?id=<publicId>">
3. browser GET  /embed/v<hash>/widget.js          -> immutable, cached one year
4. browser GET  /api/public/widgets/<id>/config   -> small JSON, 60s + ETag
5. browser renders the form (honeypot included), starts a fill timer
6. visitor POST /api/public/submissions           -> 202
```

The script derives everything from its own tag: the API origin from `script.src`, the
widget id from `?id=`. Nothing is templated per customer, so one cached bundle serves
every widget on the internet.

## Caching

Two different problems, two different answers:

- **The bundle** changes rarely and must never be stale. Its URL contains a hash of
  its contents, so it is `immutable, max-age=1y` and a release is picked up instantly
  because it lives at a new URL. `/widget.js` (unversioned) exists for convenience and
  gets `max-age=300` instead, because that path's content *does* change.
- **The config** changes whenever the owner edits the widget. `max-age=60` +
  `stale-while-revalidate` + an ETag derived from `revision` and `updated_at`, so an
  edit lands within a minute and revalidation costs a 304, not a payload.

## The hardened submission path

Middleware runs in increasing order of cost, so a flood is rejected before it becomes
expensive:

```
body size limit (16 KiB) -> 413
  rate limit per IP       -> 429      in-memory, no I/O
  rate limit per widget   -> 429      in-memory, no I/O
  envelope schema         -> 422      no database yet
  widget lookup           -> 404      first query
  origin allow-list       -> 403
  idempotency lookup      -> 200 replay
  field schema (built from the widget's own fields, .strict())  -> 422
  spam checks             -> 202, stored as spam
  geo enrichment          -> never fails
  store + enqueue jobs    -> 202
```

Two things worth stating explicitly:

- **Spam is answered with the same 202 a human gets.** A bot that can tell it was
  caught is a bot that can iterate. It is stored with `status = 'spam'` so the owner
  can see the volume, and it never reaches the real list or triggers a notification.
- **`.strict()` on the field schema.** A payload carrying keys the widget never
  declared is rejected, not quietly stored — otherwise anyone could stuff arbitrary
  JSON into the database through a public endpoint.

## Failure that must not fail

Two dependencies can be down, and neither may take a lead with it.

**Geo enrichment** is a chain of providers tried in order. `enrichWithGeo` has one
hard contract: *it never throws*. Every failure mode — provider down, timeout,
garbage response, no providers configured — resolves to `status: 'unavailable'` and
the submission proceeds without a location.

**Email and webhooks** never run on the request path at all. They are rows in `jobs`,
written in the submission's transaction and processed by a polling worker with
exponential backoff, a dead-letter state, and an alert log line when a job exhausts
its retries. A broken mail provider is therefore invisible to the visitor by
construction rather than by a `try/catch` somebody has to remember to write.

## Idempotency

The widget sends an `Idempotency-Key` per submit attempt and keeps it across retries.
A partial unique index on `(widget_id, idempotency_key)` is what actually enforces
uniqueness — the pre-check is an optimisation, and the `23505` handler catches the
race two concurrent retries create.

## Explicit non-goal

**No form builder, and no owner-facing UI.** The dashboard is a JSON API. Widget
configuration is submitted as JSON, not assembled by dragging fields around. That is
where the product would go next and where none of the interesting backend problems
are, so it is out of scope on purpose. A minimal HTML page acts as the "customer
website" purely to prove the cross-origin path is real.

## Things I changed while building

- **Rate limiting started as one per-IP limiter.** Adding the per-widget limiter came
  from writing the attack down: a distributed flood against one customer's form has
  no shared IP for the first limiter to catch.
- **The widget's stylesheet was initially per-page with the accent baked in.** Two
  widgets on one page then fought over the colour — whichever loaded first won. Fixed
  by moving every colour to a CSS custom property set on each widget's own root.
- **The fallback proof was going to use the real providers.** A proof that depends on
  ip-api.com actually being down is a coin flip, not a proof. Deterministic mock
  providers plus a `GEO_FORCE_DOWN` switch made it reproducible offline.
