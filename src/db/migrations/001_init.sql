-- Tenants ------------------------------------------------------------------
-- One row per customer of the platform. Every other table hangs off this id,
-- and every query in the repositories filters by it.
CREATE TABLE tenants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL,
    name          text        NOT NULL,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Emails are compared case-insensitively; a functional unique index gives that
-- without needing the citext extension.
CREATE UNIQUE INDEX tenants_email_lower_key ON tenants (lower(email));

-- Widgets ------------------------------------------------------------------
CREATE TYPE widget_type   AS ENUM ('signup_form', 'contact_form', 'cta_popover');
CREATE TYPE widget_status AS ENUM ('active', 'paused');

CREATE TABLE widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid          NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- The id that appears in the public <script> URL. Random, not sequential,
    -- so a widget config cannot be enumerated.
    public_id       text          NOT NULL,
    name            text          NOT NULL,
    type            widget_type   NOT NULL,
    status          widget_status NOT NULL DEFAULT 'active',
    title           text          NOT NULL,
    description     text,
    button_text     text          NOT NULL DEFAULT 'Submit',
    success_message text          NOT NULL DEFAULT 'Thanks! We will be in touch.',
    fields          jsonb         NOT NULL DEFAULT '[]'::jsonb,
    display         jsonb         NOT NULL DEFAULT '{}'::jsonb,
    -- Name of the hidden field bots fill in. Per-widget so it can be rotated.
    honeypot_field  text          NOT NULL DEFAULT 'company_website',
    -- Empty array = accept submissions from any origin (the default for a
    -- widget meant to be pasted anywhere). Non-empty = allow-list.
    allowed_origins text[]        NOT NULL DEFAULT '{}',
    webhook_url     text,
    notify_email    text,
    -- Bumped on every config change; part of the config ETag.
    revision        integer       NOT NULL DEFAULT 1,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE UNIQUE INDEX widgets_public_id_key ON widgets (public_id);
-- Listing a tenant's widgets, newest first — the dashboard's hot path.
CREATE INDEX widgets_tenant_created_idx ON widgets (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- Submissions --------------------------------------------------------------
CREATE TYPE submission_status AS ENUM ('stored', 'spam');

CREATE TABLE submissions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    widget_id       uuid              NOT NULL REFERENCES widgets (id) ON DELETE CASCADE,
    -- Denormalised from widgets so every dashboard query can filter by tenant
    -- without a join — tenant isolation stays one WHERE clause, never a JOIN
    -- someone can forget.
    tenant_id       uuid              NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    status          submission_status NOT NULL DEFAULT 'stored',
    spam_reason     text,
    data            jsonb             NOT NULL,
    email           text,
    ip_address      inet,
    user_agent      text,
    origin          text,
    referer         text,
    page_url        text,
    -- Geo enrichment. NULL columns are a successful submission whose provider
    -- chain was exhausted — enrichment degrades, it never fails the request.
    geo_provider    text,
    geo_status      text              NOT NULL DEFAULT 'skipped',
    country         text,
    country_code    text,
    region          text,
    city            text,
    latitude        double precision,
    longitude       double precision,
    idempotency_key text,
    created_at      timestamptz       NOT NULL DEFAULT now()
);

-- The dashboard reads submissions per widget and per tenant, newest first.
CREATE INDEX submissions_widget_created_idx ON submissions (widget_id, created_at DESC);
CREATE INDEX submissions_tenant_created_idx ON submissions (tenant_id, created_at DESC);
-- Geo breakdown aggregation.
CREATE INDEX submissions_tenant_country_idx ON submissions (tenant_id, country_code) WHERE country_code IS NOT NULL;
-- Idempotency: a retried POST with the same key must not create a second row.
CREATE UNIQUE INDEX submissions_idempotency_key ON submissions (widget_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Background jobs ----------------------------------------------------------
-- A transactional outbox: side effects are enqueued in the same transaction
-- that stores the submission, then run off the request path with retries.
CREATE TYPE job_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead');

CREATE TABLE jobs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type         text        NOT NULL,
    payload      jsonb       NOT NULL,
    status       job_status  NOT NULL DEFAULT 'pending',
    attempts     integer     NOT NULL DEFAULT 0,
    max_attempts integer     NOT NULL DEFAULT 5,
    run_at       timestamptz NOT NULL DEFAULT now(),
    last_error   text,
    locked_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The worker's claim query: pending jobs whose run_at has arrived, oldest first.
CREATE INDEX jobs_claim_idx ON jobs (status, run_at) WHERE status = 'pending';
