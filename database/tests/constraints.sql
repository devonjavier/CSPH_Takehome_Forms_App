\set ON_ERROR_STOP on
-- Fixtures and test helpers are rolled back, leaving the developer database intact.
BEGIN;
SET LOCAL search_path = public;

CREATE FUNCTION pg_temp.expect_failure(statement text, expected_state text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
        IF actual_state = expected_state THEN RETURN; END IF;
        RAISE EXCEPTION 'Expected SQLSTATE %, got % for %', expected_state, actual_state, statement;
    END;
    RAISE EXCEPTION 'Expected rejection (%) but statement succeeded: %', expected_state, statement;
END;
$$;

DO $$
DECLARE
    owner_id uuid := gen_random_uuid();
    first_form_id uuid := gen_random_uuid();
    second_form_id uuid := gen_random_uuid();
    first_version_id uuid := gen_random_uuid();
    second_version_id uuid := gen_random_uuid();
    foreign_version_id uuid := gen_random_uuid();
    publication_id uuid := gen_random_uuid();
    first_response_id uuid := gen_random_uuid();
    repeated_response_id uuid := gen_random_uuid();
    dropdown_question_id uuid;
    dropdown_answer_id uuid;
    empty_dropdown_answer_id uuid := gen_random_uuid();
    checkbox_question_id uuid;
    checkbox_answer_id uuid;
    text_question_id uuid;
    text_answer_id uuid;
    date_answer_id uuid;
    first_option_id uuid;
    second_option_id uuid;
    foreign_option_id uuid;
    historical_question_id uuid := gen_random_uuid();
    next_question_id uuid;
    next_answer_id uuid;
    next_type question_type;
    question_position integer := 0;
BEGIN
    INSERT INTO users(id, email, password_hash)
    VALUES (owner_id, owner_id::text || '@example.test', 'fixture-not-a-real-password-hash');
    INSERT INTO forms(id, owner_id) VALUES (first_form_id, owner_id), (second_form_id, owner_id);
    INSERT INTO form_drafts(form_id) VALUES (first_form_id), (second_form_id);
    INSERT INTO form_versions(id, form_id, version_number, publication_action_id, title)
    VALUES (first_version_id, first_form_id, 1, publication_id, 'All types'),
        (second_version_id, first_form_id, 2, gen_random_uuid(), 'Next version'),
        (foreign_version_id, second_form_id, 1, gen_random_uuid(), 'Other form');
    UPDATE forms SET current_version_id = first_version_id, is_published = true WHERE id = first_form_id;
    INSERT INTO responses(id, form_version_id, email)
    VALUES (first_response_id, first_version_id, 'repeat@example.test'),
        (repeated_response_id, first_version_id, 'repeat@example.test');

    -- Exercise valid native storage for each of the eight types.
    FOREACH next_type IN ARRAY enum_range(NULL::question_type) LOOP
        next_question_id := gen_random_uuid();
        next_answer_id := gen_random_uuid();
        INSERT INTO version_questions(id, form_version_id, label, type, position, scale_min, scale_max)
        VALUES (next_question_id, first_version_id, next_type::text, next_type, question_position,
            CASE WHEN next_type = 'linear_scale' THEN 1 END,
            CASE WHEN next_type = 'linear_scale' THEN 5 END);
        INSERT INTO answers(id, response_id, form_version_id, question_id, question_type, text_value, date_value, integer_value)
        VALUES (next_answer_id, first_response_id, first_version_id, next_question_id, next_type,
            CASE WHEN next_type = 'short_text' THEN 'Hello'
                WHEN next_type = 'long_text' THEN E'Line one\nLine two' END,
            CASE WHEN next_type = 'date' THEN DATE '2026-10-09' END,
            CASE WHEN next_type = 'linear_scale' THEN 3 END);
        IF next_type IN ('dropdown', 'multiple_choice', 'multi_select', 'checkboxes') THEN
            INSERT INTO question_options(question_id, question_type, label, position)
            VALUES (next_question_id, next_type, 'First', 0) RETURNING id INTO first_option_id;
            INSERT INTO question_options(question_id, question_type, label, position)
            VALUES (next_question_id, next_type, 'Second', 1) RETURNING id INTO second_option_id;
            INSERT INTO answer_selections(answer_id, question_id, question_type, option_id, selection_position)
            VALUES (next_answer_id, next_question_id, next_type, first_option_id, 0);
            IF next_type IN ('multi_select', 'checkboxes') THEN
                INSERT INTO answer_selections(answer_id, question_id, question_type, option_id, selection_position)
                VALUES (next_answer_id, next_question_id, next_type, second_option_id, 1);
            END IF;
        END IF;
        IF next_type = 'dropdown' THEN
            dropdown_question_id := next_question_id; dropdown_answer_id := next_answer_id;
        ELSIF next_type = 'checkboxes' THEN
            checkbox_question_id := next_question_id; checkbox_answer_id := next_answer_id;
            foreign_option_id := first_option_id;
        ELSIF next_type = 'short_text' THEN
            text_question_id := next_question_id; text_answer_id := next_answer_id;
        ELSIF next_type = 'date' THEN
            date_answer_id := next_answer_id;
        END IF;
        question_position := question_position + 1;
    END LOOP;

    INSERT INTO version_questions(id, form_version_id, label, type, position)
    VALUES (historical_question_id, second_version_id, 'Different version question', 'short_text', 0);
    INSERT INTO answers(id, response_id, form_version_id, question_id, question_type)
    VALUES (empty_dropdown_answer_id, repeated_response_id, first_version_id, dropdown_question_id, 'dropdown');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answers(response_id, form_version_id, question_id, question_type) VALUES (%L,%L,%L,''short_text'')',
        repeated_response_id, first_version_id, historical_question_id), '23503');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answers(response_id, form_version_id, question_id, question_type) VALUES (%L,%L,%L,''short_text'')',
        repeated_response_id, second_version_id, historical_question_id), '23503');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answer_selections VALUES (%L,%L,''dropdown'',%L,0)',
        empty_dropdown_answer_id, dropdown_question_id, foreign_option_id), '23503');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answer_selections VALUES (%L,%L,''checkboxes'',%L,2)',
        dropdown_answer_id, checkbox_question_id, foreign_option_id), '23503');
    PERFORM pg_temp.expect_failure(format(
        'UPDATE forms SET current_version_id = %L WHERE id = %L', foreign_version_id, first_form_id), '23503');

    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answers(response_id, form_version_id, question_id, question_type) VALUES (%L,%L,%L,''short_text'')',
        first_response_id, first_version_id, text_question_id), '23505');
    SELECT id INTO first_option_id FROM question_options WHERE question_id = dropdown_question_id AND position = 0;
    SELECT id INTO second_option_id FROM question_options WHERE question_id = dropdown_question_id AND position = 1;
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answer_selections VALUES (%L,%L,''dropdown'',%L,0)',
        dropdown_answer_id, dropdown_question_id, first_option_id), '23505');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answer_selections VALUES (%L,%L,''dropdown'',%L,1)',
        dropdown_answer_id, dropdown_question_id, second_option_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO answer_selections VALUES (%L,%L,''dropdown'',%L,0)',
        dropdown_answer_id, dropdown_question_id, second_option_id), '23505');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO question_options(question_id, question_type, label, position) VALUES (%L,''short_text'',''Wrong'',0)',
        text_question_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO question_options(question_id, question_type, label, position) VALUES (%L,''dropdown'','' First '',2)',
        dropdown_question_id), '23505');
    PERFORM pg_temp.expect_failure(format('UPDATE answers SET integer_value = 4 WHERE id = %L', text_answer_id), '23514');
    PERFORM pg_temp.expect_failure(format('UPDATE answers SET text_value = E'' \t\n '' WHERE id = %L', text_answer_id), '23514');
    PERFORM pg_temp.expect_failure(format('UPDATE answers SET text_value = E''one\ntwo'' WHERE id = %L', text_answer_id), '23514');
    PERFORM pg_temp.expect_failure(format('UPDATE answers SET date_value = ''infinity'' WHERE id = %L', date_answer_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO version_questions(form_version_id,label,type,position,scale_min,scale_max) VALUES (%L,''Bad scale'',''linear_scale'',20,5,1)',
        second_version_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO version_questions(form_version_id,label,type,position,scale_min) VALUES (%L,''Bad config'',''short_text'',20,1)',
        second_version_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO version_questions(form_version_id,label,type,position) VALUES (%L,''Missing config'',''linear_scale'',20)',
        second_version_id), '23514');
    PERFORM pg_temp.expect_failure(format(
        'INSERT INTO form_versions(form_id,version_number,publication_action_id,title) VALUES (%L,3,%L,''Replay'')',
        first_form_id, publication_id), '23505');
    PERFORM pg_temp.expect_failure(format('UPDATE form_versions SET title = ''Rewritten'' WHERE id = %L', first_version_id), '23514');
    PERFORM pg_temp.expect_failure(format('UPDATE version_questions SET label = ''Rewritten'' WHERE id = %L', text_question_id), '23514');
    PERFORM pg_temp.expect_failure(format('DELETE FROM question_options WHERE id = %L', foreign_option_id), '23514');
    PERFORM pg_temp.expect_failure(format('UPDATE forms SET deleted_at = now() WHERE id = %L', first_form_id), '23514');

    -- Optional blanks, incomplete drafts, and archive retention are valid.
    INSERT INTO answers(response_id,form_version_id,question_id,question_type)
    VALUES (repeated_response_id,first_version_id,text_question_id,'short_text');
    UPDATE form_drafts SET definition = '{"title":"","questions":[]}'::jsonb, updated_at = now()
        WHERE form_id = first_form_id;
    UPDATE forms SET is_published = false, deleted_at = now() WHERE id = first_form_id;
    IF (SELECT count(*) FROM responses WHERE form_version_id = first_version_id) <> 2 THEN
        RAISE EXCEPTION 'Archiving must retain responses';
    END IF;
    IF (SELECT date_value FROM answers WHERE id = date_answer_id) <> DATE '2026-10-09' THEN
        RAISE EXCEPTION 'Date-only answer changed';
    END IF;
    IF (SELECT count(*) FROM answers WHERE response_id = first_response_id) <> 8 THEN
        RAISE EXCEPTION 'Expected all eight answer types';
    END IF;
    RAISE NOTICE 'Constraint checks passed: all eight types, membership, duplicates, scalar shapes, history, archive retention.';
END;
$$;
ROLLBACK;
