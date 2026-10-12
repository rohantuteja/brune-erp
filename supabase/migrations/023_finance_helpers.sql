-- 023_finance_helpers.sql
-- Two helpers for the finance-import function (service role only; browsers cannot call them).

-- Velocity's COD payouts as the ledger knows them: one row per bank reference (UTR).
CREATE OR REPLACE FUNCTION public.finance_velocity_payouts()
RETURNS TABLE (utr text, paid_on date, amount numeric, payments integer)
LANGUAGE sql STABLE AS $$
  SELECT facts->'remitted'->>'utr', (facts->'remitted'->>'date')::date,
         round(sum((facts->'remitted'->>'amount')::numeric), 2), count(*)::integer
  FROM ledger_orders WHERE facts->'remitted' IS NOT NULL GROUP BY 1, 2
$$;

-- Write the engine's answers onto lines. A line a person has decided is never touched.
CREATE OR REPLACE FUNCTION public.finance_apply_matches(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH x AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS t(id bigint, status text, kind text, bucket text, match_ref text, reason text, needs_bill boolean, payee text, rule_id bigint)
  )
  UPDATE finance_lines l SET status = x.status, kind = x.kind, bucket = x.bucket, match_ref = x.match_ref, reason = x.reason,
    needs_bill = coalesce(x.needs_bill, false), payee = x.payee, rule_id = x.rule_id, updated_at = now()
  FROM x WHERE l.id = x.id AND l.decided_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.finance_velocity_payouts(), public.finance_apply_matches(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_velocity_payouts(), public.finance_apply_matches(jsonb) TO service_role;
