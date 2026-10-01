-- 007_drop_cancel_recheck.sql
--
-- Shopify cancellations before shipping are handled by Unicommerce: it cancels
-- its copy of the order and releases the held piece (#37715 on 30 Sep 2026 was
-- cancelled in Unicommerce within a second of Shopify). The ERP no longer
-- restocks cancellations, so the re-check job from migration 006 is dropped.
-- returnprime-sweep stays.

SELECT cron.unschedule('shopify-cancel-recheck');
