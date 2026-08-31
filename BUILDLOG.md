# Build log

Required honest account of where AI helped, where it was wrong, and what I changed.
The rule I held myself to: I have to be able to explain any 2–3 lines a reviewer
points at. Where I could not, I rewrote them.

**AI usage:** Claude (Opus), as a pair-programmer in the terminal, for essentially
the whole build. It wrote most of the first draft of every file. What follows is
what it got right, what it got wrong, and what I had to change.

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
