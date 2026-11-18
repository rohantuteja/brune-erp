-- 046_tally_ledgers_mark.sql
--
-- Accounting page: the ledgers the Tally file needs that are not in Tally yet are created by importing a ledgers file (ahead of the vouchers),
-- renamed by hand by the accountant, and then marked as done here so the checklist stops blocking.
--
--   * Myntra Commission is a ledger the ledger posts to (17 Nov 2026) but was never added to tally_ledgers: it is, as a ledger to create.
--   * tally_ledgers_mark(names) moves the named ledgers from will_create / will_rename to in_tally (admin only), and logs who did it.
--     It never moves a ledger anywhere else, and nothing can be un-marked from the page: a wrong mark is corrected in the table by hand.

CREATE TABLE IF NOT EXISTS public.tally_ledger_log (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  from_status text        NOT NULL,
  to_status   text        NOT NULL,
  by_name     text,
  at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tally_ledger_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.tally_ledger_log;
CREATE POLICY "admin read" ON public.tally_ledger_log FOR SELECT TO authenticated USING (public.finance_admin());

INSERT INTO public.tally_ledgers (name, "under", section, role, status, as_of)
SELECT 'Myntra Commission', 'Indirect Expenses', 'Indirect Expenses', 'expense', 'will_create', DATE '2026-09-30'
WHERE NOT EXISTS (SELECT 1 FROM public.tally_ledgers WHERE name = 'Myntra Commission');

CREATE OR REPLACE FUNCTION public.tally_ledgers_mark(p_names text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF coalesce(array_length(p_names, 1), 0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'between 1 and 100 ledgers'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  WITH moved AS (
    UPDATE tally_ledgers SET status = 'in_tally'
    WHERE name = ANY (p_names) AND status IN ('will_create', 'will_rename')
    RETURNING name, CASE WHEN renamed_from IS NULL THEN 'will_create' ELSE 'will_rename' END AS was
  ), logged AS (
    INSERT INTO tally_ledger_log (name, from_status, to_status, by_name) SELECT name, was, 'in_tally', v_name FROM moved RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.tally_ledgers_mark(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tally_ledgers_mark(text[]) TO authenticated;
