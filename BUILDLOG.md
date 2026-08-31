# Build log

Required honest account of where AI helped, where it was wrong, and what I changed.
The rule I held myself to: I have to be able to explain any 2–3 lines a reviewer
points at. Where I could not, I rewrote them.

**AI usage:** Claude (Opus), as a pair-programmer in the terminal, for essentially
the whole build. It wrote most of the first draft of every file. What follows is
what it got right, what it got wrong, and what I had to change.

**A note on the history.** This was first built in Node + TypeScript + Express, then
ported to Python + FastAPI. Both are in the git history. That was my call — the brief
allows either lane, and I chose the language *after* seeing the design work. The port
is documented at the end of this file; the acceptance probes are pure HTTP and
validated both implementations without a single change, which is what made the port
tractable rather than a rewrite.

**Runtime AI cost: none.** The service makes no AI calls, so shared requirement #7
(per-call cost tracking with a budget guard) has nothing to track. AI was a build
tool, not a dependency.

---

## Where AI genuinely helped

- **Boilerplate volume.** The repository layer, row mappers, zod schemas and the
  Express wiring are the kind of code that is tedious rather than hard. Having a
  first draft in minutes meant the time went into the parts that are actually
  interesting — the caching strategy, the failure boundaries, the middleware order.
- **Remembering the HTTP details.** `Vary: Origin` on a CORS-varying cached response,
  `stale-while-revalidate`, the draft-7 `RateLimit` headers, `Access-Control-Max-Age`.
  I knew these existed; I would have looked half of them up one at a time.
- **`FOR UPDATE SKIP LOCKED`.** I knew I wanted a queue in Postgres. The
  `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` shape — select and claim
  in one statement, so there is no window where a job is selected but unclaimed — was
  the suggestion I most valued, and I wrote a concurrency test to convince myself it
  was true rather than take it on trust.
- **Naming the thing I was already building.** I had written "insert the job in the
  same transaction as the submission" before I knew that pattern is called a
  transactional outbox. Having the name made the README section much easier to write.

## Where AI was wrong, and what I changed

**1. A zod chain that would have thrown at runtime.**
The first field-schema builder ended with `(schema as z.ZodString).min(1, …)` after
already calling `.toLowerCase()`. The cast makes TypeScript happy; whether it works
depends on whether `.toLowerCase()` returns `ZodString` or `ZodEffects`, and a cast
is exactly the wrong way to find out. Rewrote the builder so required/optional is
decided per branch and `.min()` is applied to a value that is a `ZodString` by
construction, with no cast anywhere.

**2. Empty optional fields were rejected.**
Browsers post untouched inputs as `""`. An optional email field would therefore fail
`.email()` on an empty string — a visitor who skipped an optional field would get a
validation error. Not caught by the generated code or its first tests; caught by
filling the form in a browser. Fixed with a `preprocess` that normalises `""` to
`undefined` for optional fields.

**3. Postgres enum casts.**
`COALESCE($5, 'active')` for an enum column fails with *"column status is of type
widget_status but expression is of type text"* the first time you pass `null`. The
seed script died on its first run. Added explicit `::widget_status` / `::widget_type`
/ `::text[]` casts.

**4. A migration typo that only a real database catches.**
`run_at timestapmtz` — transposed letters, and no `NOT NULL DEFAULT now()`. This is
the argument for running migrations against a real Postgres in the test suite rather
than mocking it.

**5. The rate-limit test was silently self-defeating.**
Every supertest request comes from the same client IP, so the tests were exhausting
each other's budget and the failures looked like product bugs. Restructured: the
rate-limit files set their own limits *before* importing the app (vitest gives each
file a fresh module registry), and each test presents its own `X-Forwarded-For` with
`TRUST_PROXY_HOPS=1`. That also let me write the test I actually wanted — *"keeps
serving a different visitor while one is being limited"* — which is the property that
matters and which the original test did not check at all.

**6. Two widgets on one page fought over the accent colour.**
`injectStyles(accent, theme)` baked the colours into a single page-level stylesheet
and returned early if it already existed — so whichever widget loaded first
repainted the other. Only visible by putting two widgets on the test page and
looking. Rewrote it: one shared stylesheet with every colour as a CSS custom
property, set on each widget's own root.

**7. The checkbox rendered as a full-width input.**
A generic `input { width: 100% }` rule applied to checkboxes too. Fixed with a
dedicated checkbox branch in `buildField` and a `.fr-check` layout — the label
belongs beside a checkbox, not above it.

**8. The oversized-payload probe was quietly proving nothing.**
The probe reported `400`, while the server log for the same request said `413`. Two
compounding causes: curl's `Expect: 100-continue` handshake for bodies over 1 KB
confused the reported status, and a 20 KB string nested through `"$(submit - "…")"`
was being mangled by shell quoting. Fixed by writing the body to a file, posting it
with `--data-binary` and `-H 'Expect:'` (which is what a browser does anyway), and
adding a `submit_file` helper so no large payload ever travels through nested
quoting. **This is the mistake I'm most glad I chased**: the probe was green, and it
was green for the wrong reason.

**9. Probe 5 passed because of a process I'd forgotten about.**
The failing-mailer probe kept reporting success with no failed jobs. A `npm run dev`
watcher from hours earlier was still alive, pointed at the same database, and its
worker — configured with `EMAIL_TRANSPORT=log` — was cheerfully succeeding the jobs
the probe needed to see fail. The system was behaving correctly (`SKIP LOCKED` doing
its job); the *test setup* was wrong. Added a guard to `probes.sh` that refuses to run
if another API process or the compose `api` service shares the queue.

**10. `express.json({ limit })` alone is not enough for a clean 413.**
body-parser throws typed errors (`entity.too.large`, `entity.parse.failed`) that
surface as `500`s if the error handler does not know about them — the exact failure
acceptance probe 2 checks for. Added explicit branches in `normalise()`.

**11. `req.query` is read-only in Express 5.**
The validation middleware assigned the parsed value back over `req[target]`, which
works for `body` and `params` and silently fails for `query`. Stashed the parsed
query on the request instead, with a typed accessor.

## Decisions I made against the first suggestion

- **`trust proxy` defaults to `0`, not `true`.** The draft set it to `true`, which
  means any client can put whatever it likes in `X-Forwarded-For` and walk straight
  past the per-IP rate limit. It is now a numeric hop count, defaults to trusting
  nothing, and the README says why.
- **Spam is stored, not discarded.** The suggestion was to drop it. Storing it with a
  `spamReason` costs one row and gives the owner a spam count and a reason in the
  dashboard — and it makes probe 6 verifiable instead of an absence of evidence.
- **`404`, not `403`, for another tenant's resource.** A `403` confirms the id exists.
- **Login answers identically for a wrong password and an unknown account**, and does
  the hashing work either way, so the endpoint is not an account-enumeration oracle.
- **`202`, not `201`, for a submission.** The row is committed but the email and
  webhook it triggers have not run yet. `201 Created` would overstate what has
  happened.
- **`scrypt` from `node:crypto` over bcrypt/argon2.** Memory-hard, and no native
  module to compile in an Alpine image. The parameters are stored alongside the hash
  so they can be raised later without invalidating existing passwords.
- **Deterministic mock geo providers.** A fallback proof that depends on a third party
  actually being down is a coin flip. The real providers stay the default; the mocks
  exist so probe 4 gives the same answer on any machine, offline included.

## How I verified rather than assumed

Every claim in `EVIDENCE.md` is pasted output from a command anyone can re-run. The
things I checked by hand, not just by test:

- Opened the widget in a real browser on a real second origin, submitted the form,
  and read the stored row back — the `origin`, `referer` and Chrome `userAgent` on
  that row are what prove it was not curl.
- Watched the bundle version change (`vf0de3b45cc8b → vbc78be6d4135 → v95db10fbc8fa`)
  as I edited `widget.js`, and watched the browser keep serving the cached copy of
  `/widget.js` for its full `max-age=300` — the cache behaving exactly as designed,
  which was briefly confusing and then reassuring.
- Ran `docker compose up --build` from a clean image to confirm the one-command
  promise in the README, which is how I found that `tsc` does not copy `.sql`
  migrations into `dist/`.

---

## The port to FastAPI

The design carried over intact. What did not, and what it taught me:

**1. Exceptions raised in middleware bypass FastAPI's exception handlers.**
Starlette's `ExceptionMiddleware` sits *inside* the user middleware stack, so an
`AppError` raised by my body-size middleware escaped every handler and surfaced as a
`500` — the exact failure acceptance probe 2 exists to catch. The fix is to *return* a
`JSONResponse` rather than raise. The same bug was present in my CORS middleware.
I only found it because the probes were already written and probe 2 went red.

**2. Starlette's `CORSMiddleware` is global.**
It cannot express "open to everyone on these paths, allow-listed on those", and being
global it answered the public preflights with the admin policy — a `400`, and
`access-control-allow-origin` echoing the caller instead of `*`. Replaced with one
middleware holding both policies and dispatching on path.

**3. Pydantic serialises snake_case unless told otherwise.**
The widget response came back with `public_id`, `button_text` and so on, silently
breaking the documented camelCase contract. Caught because `probes.sh` reads
`widget.publicId` and got an empty string. Fixed with an alias generator on the domain
models rather than a hand-written key map — which also let me delete the ad-hoc
camelCase mapping I had started writing in the dashboard router.

**4. `email-validator` rejects `.test` and `.example` domains.**
Every demo account and every example in the brief uses them. My first fix gated the
check on `ENVIRONMENT != production` — which then made the seeded accounts unusable in
the compose stack, because that runs as production. That was a bad design: the same
input being valid or invalid depending on deployment is surprising, and inconsistent
when `check_deliverability=False` already means we never verify the domain resolves.
Removed the gate; reserved TLDs are always accepted, and the reasoning is in the code.

**5. Python classifies TEST-NET addresses as private; the Node regexes did not.**
`ipaddress.ip_address('203.0.113.42').is_private` is `True` — the RFC 5737
documentation ranges are in the special-use registry. My hand-written Node regexes
only covered RFC 1918, loopback and link-local, so the old probes used `203.0.113.42`
as a "public" visitor IP and geo enrichment ran. Under Python it was skipped and probe
4 proved nothing. **Python's behaviour is more correct** — those addresses genuinely
have no location — so I kept it and switched the probes to `8.8.8.8`.

**6. Repeated `X-Forwarded-For` headers.**
`headers.get()` returns only the first; RFC 7230 says repeated headers are equivalent
to one comma-joined value. A probe sending two of them got the already-limited IP back
and failed. Fixed with `getlist()` and a join — a correctness bug the test happened to
expose rather than a test artefact.

**7. FastAPI does not derive HEAD from a GET route.**
Express does. `curl -sI` — which the probe script uses to read the ETag, and which
monitors and caches use generally — got a `405`. Registered HEAD explicitly on the
public GET routes, out of the OpenAPI schema so each endpoint is still documented once.

**8. pytest-asyncio's default loop scoping.**
Session-scoped fixtures (the connection pool, the app lifespan) were created on one
event loop and the tests ran on another, so every test errored with *"attached to a
different loop"*. Fixed by pinning both fixture and test loop scope to the session.

### What I would tell someone choosing the lane

The hard parts of this project — CORS, abuse resistance, graceful degradation, the
outbox — are design problems, and they looked almost identical in both languages. The
differences that mattered were all at the framework boundary, and every one of them
was caught by tests and probes that already existed. That is the actual lesson: the
probes were worth more than either implementation.
