-- 038_channel_velocity.sql
--
-- Pipeline Health divided the stock by Shopify's sales alone, but the stock is one pool that Unicommerce pushes to
-- Shopify AND Myntra: Myntra is about 30% of the pieces sold (October 2026), so the days of stock left were overstated by
-- about 40%. The velocity is now Shopify's plus Myntra's.
--
--   myntra_order_lines   one row per piece of a Myntra order in Unicommerce (SKU, order date, cancelled, return), kept
--                        up to date by the myntra-velocity function every 30 minutes (docs in CLAUDE.md, "Sales velocity").
--   pipeline_health()    the same function as before (it was created in the dashboard and is first in the repo here), with
--                        one change: velocity = Shopify (ShopifyQL, shopify_sales_velocity) + Myntra (myntra_order_lines),
--                        and two new result columns shopify_velocity / myntra_velocity so the screen can show the split.
--
-- Myntra counts the way Shopify's "net items sold" does, over the same lookback (velocity_lookback_days: 7, 14 or 30):
--   + pieces ordered in the window, minus cancelled pieces
--   - pieces whose return was RECEIVED back in the window (a return still on its way has not restocked the shelf)
-- Days are IST days, today included, like ShopifyQL's "SINCE -30d UNTIL today". Never below zero for a SKU.
--
-- Until the table is filled the Myntra part is 0 and the result is exactly what it was.

CREATE TABLE IF NOT EXISTS public.myntra_order_lines (
  item_code      text         PRIMARY KEY,                       -- Unicommerce sale order item code: one per piece
  order_code     text         NOT NULL,
  sku            text         NOT NULL,
  style_code     text         NOT NULL,                          -- the SKU up to its last dash, as shopify-sync splits it
  size           text         NOT NULL,                          -- ...and after it
  ordered_at     timestamptz  NOT NULL,                          -- the order's created time in Unicommerce
  cancelled      boolean      NOT NULL DEFAULT false,
  return_state   text         CHECK (return_state IN ('expected', 'received')),
  returned_at    timestamptz,                                    -- when a return was received at the warehouse
  uc_updated_at  timestamptz  NOT NULL,                          -- the order's `updated` in Unicommerce when it was read
  synced_at      timestamptz  NOT NULL DEFAULT now(),
  CHECK ((COALESCE(return_state, '') = 'received') = (returned_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS myntra_order_lines_ordered  ON public.myntra_order_lines (ordered_at);
CREATE INDEX IF NOT EXISTS myntra_order_lines_returned ON public.myntra_order_lines (returned_at) WHERE returned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS myntra_order_lines_order    ON public.myntra_order_lines (order_code);

-- Written only by the myntra-velocity function (service role); pipeline_health() is SECURITY DEFINER; admins may read.
ALTER TABLE public.myntra_order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read" ON public.myntra_order_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- The result gains two columns, which CREATE OR REPLACE cannot do: drop and create (same transaction), same grants.
DROP FUNCTION IF EXISTS public.pipeline_health();

CREATE FUNCTION public.pipeline_health()
 RETURNS TABLE(run_id bigint, style_code text, size text, shopify_stock integer, daily_velocity numeric, days_of_stock numeric, effective_days numeric, cuttings_available integer, cuttings_in_production integer, alert_level text, has_active_run boolean, fabric_available boolean, shopify_velocity numeric, myntra_velocity numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prod_lead    integer;
  v_cut_lead     integer;
  v_fabric_lead  integer;
  v_buffer       integer;
  v_lookback     integer;
  v_issue_thresh integer;
  v_cut_thresh   integer;
  v_order_thresh integer;
  v_days         integer;
  v_since        timestamptz;
BEGIN
  SELECT COALESCE((value#>>'{}')::integer, 3)  INTO v_prod_lead   FROM app_settings WHERE key = 'pipeline_production_lead_days';
  IF NOT FOUND THEN v_prod_lead   := 3;  END IF;
  SELECT COALESCE((value#>>'{}')::integer, 3)  INTO v_cut_lead    FROM app_settings WHERE key = 'pipeline_cutting_lead_days';
  IF NOT FOUND THEN v_cut_lead    := 3;  END IF;
  SELECT COALESCE((value#>>'{}')::integer, 7)  INTO v_fabric_lead FROM app_settings WHERE key = 'pipeline_fabric_lead_days';
  IF NOT FOUND THEN v_fabric_lead := 7;  END IF;
  SELECT COALESCE((value#>>'{}')::integer, 1)  INTO v_buffer      FROM app_settings WHERE key = 'pipeline_safety_buffer_days';
  IF NOT FOUND THEN v_buffer      := 1;  END IF;
  SELECT COALESCE((value#>>'{}')::integer, 30) INTO v_lookback    FROM app_settings WHERE key = 'velocity_lookback_days';
  IF NOT FOUND THEN v_lookback    := 30; END IF;

  v_issue_thresh := v_prod_lead + v_buffer;
  v_cut_thresh   := v_cut_lead  + v_prod_lead + v_buffer;
  v_order_thresh := v_fabric_lead + v_cut_lead + v_prod_lead + v_buffer;

  -- The same window shopify-sync keeps for Shopify (7, 14 or else 30 days), counted back from the start of today in IST.
  v_days  := CASE v_lookback WHEN 7 THEN 7 WHEN 14 THEN 14 ELSE 30 END;
  v_since := (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => v_days)) AT TIME ZONE 'Asia/Kolkata';

  RETURN QUERY
  WITH
  discontinued_styles AS (
    SELECT UPPER(sc.code) AS style_code
    FROM style_codes sc
    WHERE sc.discontinued = true
  ),
  active_runs AS (
    SELECT r.id, r.style_code
    FROM runs r
    WHERE
      (
        EXISTS (
          SELECT 1 FROM production_batches pb
          WHERE pb.run_id = r.id AND pb.status != 'completed'
        )
        OR
        EXISTS (
          SELECT 1 FROM run_pieces rp
          WHERE rp.run_id = r.id
            AND rp.quantity > COALESCE((
              SELECT SUM(s.value::integer)
              FROM production_batches pb
              CROSS JOIN LATERAL jsonb_each_text(COALESCE(pb.issued_sizes, '{}'::jsonb)) s
              WHERE pb.run_id = r.id AND s.key = rp.size
            ), 0)
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM discontinued_styles ds
        WHERE ds.style_code = UPPER(r.style_code)
      )
  ),
  active_run_sizes AS (
    SELECT
      ar.id                        AS run_id,
      ar.style_code,
      v->>'size'                   AS size,
      COALESCE(rp.quantity, 0)     AS total_cut
    FROM active_runs ar
    INNER JOIN shopify_inventory si ON UPPER(si.style_code) = UPPER(ar.style_code)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(si.variants, '[]'::jsonb)) v
    LEFT JOIN run_pieces rp
           ON rp.run_id = ar.id AND UPPER(rp.size) = UPPER(v->>'size')
    WHERE jsonb_array_length(COALESCE(si.variants, '[]'::jsonb)) > 0
  ),
  issued_all AS (
    SELECT pb.run_id, s.key AS size, SUM(s.value::integer) AS total_issued
    FROM production_batches pb
    INNER JOIN active_runs ar ON ar.id = pb.run_id
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(pb.issued_sizes, '{}'::jsonb)) s
    GROUP BY pb.run_id, s.key
  ),
  issued_in_prod AS (
    SELECT pb.run_id, s.key AS size, SUM(s.value::integer) AS in_production
    FROM production_batches pb
    INNER JOIN active_runs ar ON ar.id = pb.run_id
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(pb.issued_sizes, '{}'::jsonb)) s
    WHERE pb.status != 'completed'
    GROUP BY pb.run_id, s.key
  ),
  shopify_by_size AS (
    SELECT
      si.style_code,
      v->>'size'           AS size,
      (v->>'qty')::integer AS stock
    FROM shopify_inventory si
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(si.variants, '[]'::jsonb)) v
    WHERE jsonb_array_length(COALESCE(si.variants, '[]'::jsonb)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM discontinued_styles ds
        WHERE ds.style_code = UPPER(si.style_code)
      )
  ),
  run_fabric AS (
    SELECT
      ar.id AS run_id,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM run_entries re WHERE re.run_id = ar.id
        ) THEN NULL
        WHEN NOT EXISTS (
          SELECT 1 FROM run_entries re
          JOIN run_entry_usage reu ON reu.entry_id = re.id
          WHERE re.run_id = ar.id
        ) THEN NULL
        WHEN EXISTS (
          SELECT inv2.fabric_type_id, inv2.color
          FROM run_entries re2
          JOIN run_entry_usage reu2 ON reu2.entry_id = re2.id
          JOIN inventory inv2 ON inv2.id = reu2.inventory_id
          WHERE re2.run_id = ar.id
          EXCEPT
          SELECT inv3.fabric_type_id, inv3.color
          FROM inventory inv3
          WHERE inv3.status = 'available'
            AND (
              (inv3.format = 'roll' AND COALESCE(inv3.current_weight_kg, 0) > 0)
              OR
              (inv3.format = 'than' AND COALESCE(inv3.current_length_m,  0) > 0)
            )
        ) THEN FALSE
        ELSE TRUE
      END AS fabric_available
    FROM active_runs ar
  ),
  latest_run_per_style AS (
    SELECT DISTINCT ON (UPPER(r.style_code)) r.id AS run_id, r.style_code
    FROM runs r
    ORDER BY UPPER(r.style_code), r.id DESC
  ),
  style_fabric_fallback AS (
    SELECT
      lr.style_code,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM run_entries re WHERE re.run_id = lr.run_id
        ) THEN NULL
        WHEN NOT EXISTS (
          SELECT 1 FROM run_entries re
          JOIN run_entry_usage reu ON reu.entry_id = re.id
          WHERE re.run_id = lr.run_id
        ) THEN NULL
        WHEN EXISTS (
          SELECT inv2.fabric_type_id, inv2.color
          FROM run_entries re2
          JOIN run_entry_usage reu2 ON reu2.entry_id = re2.id
          JOIN inventory inv2 ON inv2.id = reu2.inventory_id
          WHERE re2.run_id = lr.run_id
          EXCEPT
          SELECT inv3.fabric_type_id, inv3.color
          FROM inventory inv3
          WHERE inv3.status = 'available'
            AND (
              (inv3.format = 'roll' AND COALESCE(inv3.current_weight_kg, 0) > 0)
              OR
              (inv3.format = 'than' AND COALESCE(inv3.current_length_m,  0) > 0)
            )
        ) THEN FALSE
        ELSE TRUE
      END AS fabric_available
    FROM latest_run_per_style lr
  ),
  shopify_vel AS (
    SELECT
      sv.style_code,
      sv.size,
      CASE v_lookback
        WHEN 7  THEN COALESCE(sv.daily_velocity_7d,  0)
        WHEN 14 THEN COALESCE(sv.daily_velocity_14d, 0)
        ELSE         COALESCE(sv.daily_velocity,      0)
      END AS vel
    FROM shopify_sales_velocity sv
  ),
  myntra_vel AS (
    SELECT
      UPPER(l.style_code) AS style_code,
      UPPER(l.size)       AS size,
      ROUND(
        GREATEST(0,
          COUNT(*) FILTER (WHERE NOT l.cancelled AND l.ordered_at >= v_since)
          - COUNT(*) FILTER (WHERE l.returned_at >= v_since)
        )::numeric / v_days, 4
      ) AS vel
    FROM myntra_order_lines l
    WHERE l.ordered_at >= v_since OR l.returned_at >= v_since
    GROUP BY UPPER(l.style_code), UPPER(l.size)
  ),
  velocity_effective AS (
    SELECT
      COALESCE(sv.style_code, mv.style_code)     AS style_code,
      COALESCE(sv.size,       mv.size)           AS size,
      COALESCE(sv.vel, 0)                        AS shopify_vel,
      COALESCE(mv.vel, 0)                        AS myntra_vel,
      COALESCE(sv.vel, 0) + COALESCE(mv.vel, 0)  AS vel
    FROM shopify_vel sv
    FULL JOIN myntra_vel mv
           ON UPPER(sv.style_code) = mv.style_code
          AND UPPER(sv.size)       = mv.size
  ),
  base_rows AS (
    SELECT ars.run_id, ars.style_code, ars.size, TRUE AS has_active_run, ars.total_cut
    FROM active_run_sizes ars
    UNION
    SELECT NULL::bigint, sbs.style_code, sbs.size, FALSE, 0
    FROM shopify_by_size sbs
    WHERE NOT EXISTS (
      SELECT 1 FROM active_run_sizes ars
      WHERE UPPER(ars.style_code) = UPPER(sbs.style_code)
        AND UPPER(ars.size)       = UPPER(sbs.size)
    )
    AND EXISTS (
      SELECT 1 FROM shopify_by_size sbs2
      WHERE UPPER(sbs2.style_code) = UPPER(sbs.style_code)
        AND sbs2.stock > 0
    )
  )
  SELECT
    br.run_id,
    br.style_code,
    br.size,
    COALESCE(sbs.stock, 0)::integer                                      AS shopify_stock,
    COALESCE(ve.vel, 0)                                                  AS daily_velocity,
    CASE
      WHEN COALESCE(ve.vel, 0) = 0 THEN NULL
      ELSE ROUND(GREATEST(0, COALESCE(sbs.stock, 0))::numeric / ve.vel, 1)
    END                                                                  AS days_of_stock,
    CASE
      WHEN COALESCE(ve.vel, 0) = 0 THEN NULL
      ELSE ROUND(
        (GREATEST(0, COALESCE(sbs.stock, 0)) + COALESCE(iip.in_production, 0))::numeric
        / ve.vel, 1
      )
    END                                                                  AS effective_days,
    GREATEST(0, br.total_cut - COALESCE(ia.total_issued, 0))::integer   AS cuttings_available,
    COALESCE(iip.in_production, 0)::integer                             AS cuttings_in_production,
    CASE
      WHEN COALESCE(ve.vel, 0) = 0 THEN 'ok'
      WHEN ROUND(
        (GREATEST(0, COALESCE(sbs.stock, 0)) + COALESCE(iip.in_production, 0))::numeric
        / ve.vel, 1
      ) < v_issue_thresh THEN 'critical'
      WHEN ROUND(
        (GREATEST(0, COALESCE(sbs.stock, 0)) + COALESCE(iip.in_production, 0))::numeric
        / ve.vel, 1
      ) < v_cut_thresh THEN 'warning'
      WHEN ROUND(
        (GREATEST(0, COALESCE(sbs.stock, 0)) + COALESCE(iip.in_production, 0))::numeric
        / ve.vel, 1
      ) < v_order_thresh THEN 'watch'
      ELSE 'ok'
    END                                                                  AS alert_level,
    br.has_active_run,
    COALESCE(rf.fabric_available, sfb.fabric_available)                  AS fabric_available,
    COALESCE(ve.shopify_vel, 0)                                          AS shopify_velocity,
    COALESCE(ve.myntra_vel, 0)                                           AS myntra_velocity
  FROM base_rows br
  LEFT JOIN shopify_by_size sbs
         ON UPPER(sbs.style_code) = UPPER(br.style_code)
        AND UPPER(sbs.size)       = UPPER(br.size)
  LEFT JOIN velocity_effective ve
         ON UPPER(ve.style_code)  = UPPER(br.style_code)
        AND UPPER(ve.size)        = UPPER(br.size)
  LEFT JOIN issued_all ia
         ON ia.run_id = br.run_id AND UPPER(ia.size) = UPPER(br.size)
  LEFT JOIN issued_in_prod iip
         ON iip.run_id = br.run_id AND UPPER(iip.size) = UPPER(br.size)
  LEFT JOIN run_fabric rf ON rf.run_id = br.run_id
  LEFT JOIN style_fabric_fallback sfb ON UPPER(sfb.style_code) = UPPER(br.style_code);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.pipeline_health() TO anon, authenticated, service_role;

-- Schedule: twice an hour (same key as the other jobs, migration 006). Reads Unicommerce through public.uc_post only.
SELECT cron.schedule('myntra-velocity', '7,37 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/myntra-velocity',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 150000
  )
$$);
