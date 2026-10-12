-- A version's entire definition must be constructed in its creation transaction.
-- Existing versions have NULL and are already sealed. xid8 avoids transaction-ID
-- wraparound ambiguity. The existing immutable trigger protects this marker.
ALTER TABLE form_versions ADD COLUMN build_transaction xid8;

CREATE FUNCTION mark_version_build_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.build_transaction := pg_current_xact_id();
    RETURN NEW;
END;
$$;
CREATE TRIGGER form_versions_build_transaction BEFORE INSERT ON form_versions
    FOR EACH ROW EXECUTE FUNCTION mark_version_build_transaction();

CREATE FUNCTION require_version_build_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    build_id xid8;
BEGIN
    IF TG_TABLE_NAME = 'version_questions' THEN
        SELECT build_transaction INTO build_id FROM form_versions
        WHERE id = NEW.form_version_id;
    ELSE
        SELECT v.build_transaction INTO build_id FROM form_versions v
        JOIN version_questions q ON q.form_version_id = v.id
        WHERE q.id = NEW.question_id;
    END IF;
    IF build_id IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'Published definitions are sealed; publish a new version'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER version_questions_build_only BEFORE INSERT ON version_questions
    FOR EACH ROW EXECUTE FUNCTION require_version_build_transaction();
CREATE TRIGGER question_options_build_only BEFORE INSERT ON question_options
    FOR EACH ROW EXECUTE FUNCTION require_version_build_transaction();

COMMENT ON COLUMN form_versions.build_transaction IS
    'Questions/options may only be inserted in this creation transaction. NULL marks legacy sealed versions.';
