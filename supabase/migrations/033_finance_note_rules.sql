-- 033_finance_note_rules.sql
--
-- Bank & card: the note you type on a UPI payment ("trims", "threads", "tea") says what it was for, and now decides the
-- bucket together with the payee. Three things change:
--
--   finance_note_rules      the list of note words and where each goes (editable on the page). Seeded from the engine's
--                           built-in table (a test keeps the two in step); a word the owner has already filed by hand,
--                           always under the same bucket, is seeded as 'learned', which the engine trusts (matched).
--   finance_lines.note      the note word of each line, worked out by the importer (like payee), so filing can remember it
--   finance_line_log.reason why the engine moved a line (action 'auto'): every automatic move of an undecided line to a
--                           different bucket is now written to the log
--
-- Also: remembering a payee never makes a rule from a bare mask ("xx"), and remembering is explicit for payee and note alike.
-- A payee rule that was made on a bare mask, or on a note word standing in for a payee, is cleaned up separately (see the PR).

-- ── The note words ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.finance_note_rules (
  note            text        PRIMARY KEY CHECK (note = lower(note) AND note !~ '\s' AND note <> ''),
  bucket          text        NOT NULL REFERENCES public.finance_buckets(name),
  origin          text        NOT NULL CHECK (origin IN ('built_in', 'learned')),
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.finance_note_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.finance_note_rules;
CREATE POLICY "admin read" ON public.finance_note_rules FOR SELECT TO authenticated USING (public.finance_admin());

-- Every row below is a word in the engine's built-in table (bank-match.ts NOTE_BUCKET). 'learned' = filed by hand, same bucket every time, by 14 Oct 2026.
INSERT INTO public.finance_note_rules (note, bucket, origin) VALUES
  ('fabric', 'Purchase Accounts', 'built_in'),
  ('fabricadv', 'Purchase Accounts', 'learned'),
  ('purchase', 'Purchase Accounts', 'built_in'),
  ('trims', 'Fabric and Consumbale', 'learned'),
  ('trim', 'Fabric and Consumbale', 'built_in'),
  ('trimsstationary', 'Fabric and Consumbale', 'learned'),
  ('zipper', 'Fabric and Consumbale', 'learned'),
  ('thread', 'Fabric and Consumbale', 'built_in'),
  ('threads', 'Fabric and Consumbale', 'learned'),
  ('cutting', 'Labour Charges', 'built_in'),
  ('pcrate', 'Labour Charges', 'learned'),
  ('marker', 'Labour Charges', 'learned'),
  ('pattern', 'Labour Charges', 'learned'),
  ('jobwork', 'Labour Charges', 'learned'),
  ('dorijobwork', 'Labour Charges', 'built_in'),
  ('transport', 'FREIGHT INWARD NON GST', 'built_in'),
  ('cab', 'Travelling Expenses', 'built_in'),
  ('tea', 'Staff Welfare Expenses', 'built_in'),
  ('cleaning', 'Cleaning Expenses Factory', 'learned'),
  ('maintenance', 'Repair & Maintenance', 'built_in'),
  ('servicing', 'Repair & Maintenance', 'built_in'),
  ('machine', 'Sewing Machine GST', 'built_in'),
  ('software', 'Software Expenses @ 18%', 'learned'),
  ('kwikchat', 'Goexcelsior Private Limited', 'built_in'),
  ('velocity', 'Velocity Prepaid Recharge Account', 'built_in'),
  ('rent', 'Rent Payable', 'built_in'),
  ('rentneb', 'Rent Payable', 'built_in'),
  ('ebbill', 'Electricity Expenses', 'built_in'),
  ('salary', 'Salary Payable', 'learned'),
  ('fsalary', 'Salary Payable', 'built_in'),
  ('advance', 'Suspense', 'built_in'),
  ('card', 'Suspense', 'built_in')
ON CONFLICT (note) DO NOTHING;

-- ── The note of each line, and a reason on the log ───────────────────────────────────────────
ALTER TABLE public.finance_lines    ADD COLUMN IF NOT EXISTS note   text;
ALTER TABLE public.finance_line_log ADD COLUMN IF NOT EXISTS reason text;

-- ── The engine's answers onto the lines. A line a person has decided is never touched. ────────
-- New: the note is stored, and a line the engine moves from one bucket to another is logged (action 'auto', by 'matching').
CREATE OR REPLACE FUNCTION public.finance_apply_matches(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH x AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS t(id bigint, status text, kind text, bucket text, match_ref text, reason text, needs_bill boolean, payee text, rule_id bigint, note text)
  ), before AS (
    SELECT l.id, l.bucket FROM finance_lines l JOIN x ON x.id = l.id WHERE l.decided_at IS NULL
  ), up AS (
    UPDATE finance_lines l SET status = x.status, kind = x.kind, bucket = x.bucket, match_ref = x.match_ref, reason = x.reason,
      needs_bill = coalesce(x.needs_bill, false), payee = x.payee, rule_id = x.rule_id, note = NULLIF(x.note, ''), updated_at = now()
    FROM x WHERE l.id = x.id AND l.decided_at IS NULL RETURNING l.id, l.bucket AS now_bucket
  ), lg AS (
    INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name, reason)
    SELECT up.id, 'auto', b.bucket, up.now_bucket, 'matching', x.reason
    FROM up JOIN before b ON b.id = up.id JOIN x ON x.id = up.id
    WHERE b.bucket IS NOT NULL AND b.bucket IS DISTINCT FROM up.now_bucket
    RETURNING 1
  )
  SELECT count(*) INTO n FROM up;
  RETURN n;
END $$;

-- Payee and note of lines a person has decided: derived data, kept current without touching the decision.
CREATE OR REPLACE FUNCTION public.finance_set_keys(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH x AS (SELECT * FROM jsonb_to_recordset(p_rows) AS t(id bigint, payee text, note text))
  UPDATE finance_lines l SET payee = x.payee, note = NULLIF(x.note, '')
  FROM x WHERE l.id = x.id AND l.decided_at IS NOT NULL
    AND (l.payee IS DISTINCT FROM x.payee OR l.note IS DISTINCT FROM NULLIF(x.note, ''));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.finance_apply_matches(jsonb), public.finance_set_keys(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_apply_matches(jsonb), public.finance_set_keys(jsonb) TO service_role;

-- ── Filing lines. Remembering is explicit: the payee, the note word, both or neither. ─────────
-- A bare mask ("xx") is never a payee. A payee rule re-points an existing rule for that payee (the screen shows how many
-- other lines that moves before you save).
DROP FUNCTION IF EXISTS public.finance_line_assign(bigint[], text, boolean);
CREATE OR REPLACE FUNCTION public.finance_line_assign(p_ids bigint[], p_bucket text, p_remember boolean DEFAULT false, p_remember_note boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_kind text; v_count integer; v_said text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT kind INTO v_kind FROM finance_buckets WHERE name = p_bucket;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'unknown bucket'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) = 0 OR array_length(p_ids, 1) > 1000 THEN RAISE EXCEPTION 'between 1 and 1000 lines'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();

  IF p_remember THEN
    INSERT INTO finance_rules (match_type, pattern, bucket, created_by_name)
    SELECT DISTINCT 'payee', payee, p_bucket, v_name FROM finance_lines WHERE id = ANY (p_ids) AND payee IS NOT NULL AND payee <> '' AND payee !~ '^x+$'
    ON CONFLICT (match_type, pattern) DO UPDATE SET bucket = EXCLUDED.bucket, created_by_name = EXCLUDED.created_by_name, created_at = now();
  END IF;
  IF p_remember_note THEN
    INSERT INTO finance_note_rules (note, bucket, origin, created_by_name)
    SELECT DISTINCT note, p_bucket, 'learned', v_name FROM finance_lines WHERE id = ANY (p_ids) AND note IS NOT NULL AND note <> ''
    ON CONFLICT (note) DO UPDATE SET bucket = EXCLUDED.bucket, origin = 'learned', created_by_name = EXCLUDED.created_by_name, updated_at = now();
  END IF;
  v_said := CASE WHEN p_remember AND p_remember_note THEN ' (remembered for this payee and note)' WHEN p_remember THEN ' (remembered for this payee)'
                 WHEN p_remember_note THEN ' (remembered for this note)' ELSE '' END;

  WITH before AS (SELECT id, bucket FROM finance_lines WHERE id = ANY (p_ids)),
  up AS (
    UPDATE finance_lines l SET bucket = p_bucket, status = CASE WHEN v_kind = 'ignore' THEN 'ignored' ELSE 'matched' END, kind = 'manual',
      reason = 'Filed by ' || v_name || v_said,
      needs_bill = (SELECT needs_bill FROM finance_buckets WHERE name = p_bucket), decided_by = auth.uid(), decided_by_name = v_name, decided_at = now(), updated_at = now()
    WHERE l.id = ANY (p_ids) RETURNING l.id
  ), lg AS (
    INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT up.id, 'assigned', b.bucket, p_bucket, v_name FROM up JOIN before b ON b.id = up.id RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

-- ── The note list, edited from the page ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_note_set(p_note text, p_bucket text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_key text := lower(regexp_replace(coalesce(p_note, ''), '\s+', '', 'g'));
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF v_key = '' OR length(v_key) > 40 THEN RAISE EXCEPTION 'type the note word as you write it on a payment'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_buckets WHERE name = p_bucket) THEN RAISE EXCEPTION 'unknown bucket'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  INSERT INTO finance_note_rules (note, bucket, origin, created_by_name) VALUES (v_key, p_bucket, 'learned', v_name)
  ON CONFLICT (note) DO UPDATE SET bucket = EXCLUDED.bucket, origin = 'learned', created_by_name = EXCLUDED.created_by_name, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.finance_note_delete(p_note text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  DELETE FROM finance_note_rules WHERE note = lower(regexp_replace(coalesce(p_note, ''), '\s+', '', 'g'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.finance_line_assign(bigint[], text, boolean, boolean), public.finance_note_set(text, text), public.finance_note_delete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_line_assign(bigint[], text, boolean, boolean), public.finance_note_set(text, text), public.finance_note_delete(text) TO authenticated;
