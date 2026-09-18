CREATE FUNCTION json_extract(document text, path text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT document::jsonb #>> string_to_array(substr(path,3),'.') $$;
CREATE FUNCTION json_valid(document text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN PERFORM document::jsonb; RETURN true; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END $$;
CREATE FUNCTION datetime(value text) RETURNS text
LANGUAGE sql STABLE STRICT AS $$ SELECT to_char(CASE WHEN value='now' THEN CURRENT_TIMESTAMP ELSE value::timestamptz END AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') $$;
