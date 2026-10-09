-- Run through database/migrate.ps1: it supplies the transaction and migration ledger.
-- UUIDs identify records; foreign keys, not UUID secrecy, establish membership.
CREATE TYPE question_type AS ENUM (
    'short_text', 'long_text', 'date', 'dropdown', 'multi_select',
    'multiple_choice', 'checkboxes', 'linear_scale'
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL CHECK (password_hash ~ '[^[:space:]]'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_normalized CHECK (
        email = lower(btrim(email)) AND email ~ '[^[:space:]]'
    )
);

CREATE TABLE forms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    slug text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    is_published boolean NOT NULL DEFAULT false,
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT forms_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT forms_published_has_version CHECK (NOT is_published OR current_version_id IS NOT NULL),
    CONSTRAINT forms_archived_is_offline CHECK (deleted_at IS NULL OR NOT is_published)
);
CREATE INDEX forms_owner_created_idx ON forms(owner_id, created_at DESC, id);

CREATE TABLE form_drafts (
    form_id uuid PRIMARY KEY REFERENCES forms(id) ON DELETE RESTRICT,
    definition jsonb NOT NULL DEFAULT '{"title":"","description":null,"questions":[]}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT form_drafts_object CHECK (jsonb_typeof(definition) = 'object')
);

CREATE TABLE form_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id uuid NOT NULL REFERENCES forms(id) ON DELETE RESTRICT,
    version_number integer NOT NULL CHECK (version_number > 0),
    publication_action_id uuid NOT NULL,
    title text NOT NULL CHECK (title ~ '[^[:space:]]'),
    description text,
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (form_id, version_number),
    UNIQUE (form_id, publication_action_id),
    UNIQUE (form_id, id)
);

-- The pointer cannot accidentally make another form's version current.
-- NULL current_version_id is allowed before the first publication.
ALTER TABLE forms ADD CONSTRAINT forms_current_version_membership
    FOREIGN KEY (id, current_version_id)
    REFERENCES form_versions(form_id, id) ON DELETE RESTRICT;
CREATE INDEX forms_current_version_idx ON forms(current_version_id);

CREATE TABLE version_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id uuid NOT NULL REFERENCES form_versions(id) ON DELETE RESTRICT,
    label text NOT NULL CHECK (label ~ '[^[:space:]]'),
    type question_type NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    required boolean NOT NULL DEFAULT false,
    scale_min integer,
    scale_max integer,
    scale_min_label text,
    scale_max_label text,
    UNIQUE (form_version_id, position),
    UNIQUE (form_version_id, id, type),
    UNIQUE (id, type),
    CONSTRAINT version_questions_scale_configuration CHECK (
        (type = 'linear_scale' AND scale_min IS NOT NULL AND scale_max IS NOT NULL
            AND scale_min < scale_max)
        OR
        (type <> 'linear_scale' AND scale_min IS NULL AND scale_max IS NULL
            AND scale_min_label IS NULL AND scale_max_label IS NULL)
    )
);

CREATE TABLE question_options (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id uuid NOT NULL,
    question_type question_type NOT NULL,
    label text NOT NULL CHECK (label ~ '[^[:space:]]'),
    position integer NOT NULL CHECK (position >= 0),
    CONSTRAINT question_options_choice_type CHECK (
        question_type IN ('dropdown', 'multi_select', 'multiple_choice', 'checkboxes')
    ),
    FOREIGN KEY (question_id, question_type)
        REFERENCES version_questions(id, type) ON DELETE RESTRICT,
    UNIQUE (question_id, position),
    UNIQUE (question_id, id)
);
-- Ignore surrounding whitespace for duplicate choices, but preserve case distinctions.
CREATE UNIQUE INDEX question_options_label_unique ON question_options (
    question_id, (regexp_replace(label, '^[[:space:]]+|[[:space:]]+$', '', 'g'))
);

CREATE TABLE responses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_version_id uuid NOT NULL REFERENCES form_versions(id) ON DELETE RESTRICT,
    email text NOT NULL CHECK (email ~ '[^[:space:]]'),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, form_version_id)
);
-- Email is deliberately not unique: repeat submissions are separate responses.
CREATE INDEX responses_version_submitted_idx ON responses(form_version_id, submitted_at DESC, id);

CREATE TABLE answers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    question_id uuid NOT NULL,
    question_type question_type NOT NULL,
    text_value text,
    date_value date,
    integer_value integer,
    -- Sharing a version in both FKs prevents crossing question/response versions.
    FOREIGN KEY (response_id, form_version_id)
        REFERENCES responses(id, form_version_id) ON DELETE RESTRICT,
    FOREIGN KEY (form_version_id, question_id, question_type)
        REFERENCES version_questions(form_version_id, id, type) ON DELETE RESTRICT,
    UNIQUE (response_id, question_id),
    UNIQUE (id, question_id, question_type),
    CONSTRAINT answers_typed_scalar CHECK (
        (question_type IN ('short_text', 'long_text') AND date_value IS NULL AND integer_value IS NULL)
        OR (question_type = 'date' AND text_value IS NULL AND integer_value IS NULL)
        OR (question_type = 'linear_scale' AND text_value IS NULL AND date_value IS NULL)
        OR (question_type IN ('dropdown', 'multi_select', 'multiple_choice', 'checkboxes')
            AND text_value IS NULL AND date_value IS NULL AND integer_value IS NULL)
    ),
    CONSTRAINT answers_text_nonblank CHECK (text_value IS NULL OR text_value ~ '[^[:space:]]'),
    CONSTRAINT answers_short_text_single_line CHECK (
        question_type <> 'short_text' OR text_value IS NULL
        OR (strpos(text_value, chr(10)) = 0 AND strpos(text_value, chr(13)) = 0)
    ),
    CONSTRAINT answers_date_finite CHECK (date_value IS NULL OR isfinite(date_value))
);
CREATE INDEX answers_question_version_idx ON answers(form_version_id, question_id, question_type);

CREATE TABLE answer_selections (
    answer_id uuid NOT NULL,
    question_id uuid NOT NULL,
    question_type question_type NOT NULL,
    option_id uuid NOT NULL,
    selection_position integer NOT NULL CHECK (selection_position >= 0),
    PRIMARY KEY (answer_id, option_id),
    UNIQUE (answer_id, selection_position),
    FOREIGN KEY (answer_id, question_id, question_type)
        REFERENCES answers(id, question_id, question_type) ON DELETE RESTRICT,
    FOREIGN KEY (question_id, option_id)
        REFERENCES question_options(question_id, id) ON DELETE RESTRICT,
    CONSTRAINT answer_selections_choice_type CHECK (
        question_type IN ('dropdown', 'multi_select', 'multiple_choice', 'checkboxes')
    ),
    -- Single-choice rows must use slot zero. The unique slot permits at most one.
    CONSTRAINT answer_selections_single_choice CHECK (
        question_type NOT IN ('dropdown', 'multiple_choice') OR selection_position = 0
    )
);
CREATE INDEX answer_selections_option_idx ON answer_selections(question_id, option_id);

CREATE TABLE form_webhooks (
    form_id uuid PRIMARY KEY REFERENCES forms(id) ON DELETE RESTRICT,
    url text NOT NULL CHECK (url ~ '^https?://[^[:space:]]+$'),
    secret text NOT NULL CHECK (secret ~ '[^[:space:]]'),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    response_id uuid NOT NULL REFERENCES responses(id) ON DELETE RESTRICT,
    destination_url text NOT NULL CHECK (destination_url ~ '^https?://[^[:space:]]+$'),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    status_code integer CHECK (status_code BETWEEN 100 AND 599),
    error_message text,
    CONSTRAINT webhook_attempts_time_order CHECK (completed_at IS NULL OR completed_at >= started_at),
    CONSTRAINT webhook_attempts_completion CHECK (
        (completed_at IS NULL AND status_code IS NULL AND error_message IS NULL)
        OR (completed_at IS NOT NULL AND (status_code IS NOT NULL OR error_message IS NOT NULL))
    )
);
CREATE INDEX webhook_attempts_response_started_idx ON webhook_attempts(response_id, started_at DESC);

-- Published rows are append-only. Never edit/delete definitions to save a draft.
-- The publication service must insert the COMPLETE tree in one transaction and
-- expose no route that appends questions/options to an already committed version.
CREATE FUNCTION reject_published_definition_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Published definitions cannot be updated or deleted; publish a new version'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER form_versions_immutable BEFORE UPDATE OR DELETE ON form_versions
    FOR EACH ROW EXECUTE FUNCTION reject_published_definition_mutation();
CREATE TRIGGER version_questions_immutable BEFORE UPDATE OR DELETE ON version_questions
    FOR EACH ROW EXECUTE FUNCTION reject_published_definition_mutation();
CREATE TRIGGER question_options_immutable BEFORE UPDATE OR DELETE ON question_options
    FOR EACH ROW EXECUTE FUNCTION reject_published_definition_mutation();

COMMENT ON COLUMN form_drafts.definition IS 'Incomplete editor state; validate strictly before publishing into relational tables.';
COMMENT ON COLUMN form_versions.publication_action_id IS 'Client-generated UUID reused on retries of one confirmed publication.';
COMMENT ON COLUMN answers.form_version_id IS 'Intentional duplication enabling composite FKs to enforce shared version membership.';
COMMENT ON COLUMN form_webhooks.secret IS 'Server-only delivery credential; never select into public payloads or log it.';
