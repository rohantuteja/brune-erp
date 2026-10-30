import test from 'node:test';
import assert from 'node:assert/strict';
import { ago, myntraSyncNote, velocitySplit, MYNTRA_SYNC_STALE_MS } from './pipelineVelocity.js';

test('the split shows Shopify and Myntra only when Myntra adds something', () => {
  assert.deepEqual(velocitySplit({ daily_velocity: '1.2667', shopify_velocity: '0.5333', myntra_velocity: '0.7333' }),
    { shopify: '0.53', myntra: '0.73', text: '0.53 + 0.73', title: 'Shopify 0.53 + Myntra 0.73 per day' });
  assert.equal(velocitySplit({ daily_velocity: 0.5, shopify_velocity: 0.5, myntra_velocity: 0 }), null);
  assert.equal(velocitySplit({ daily_velocity: 0.5 }), null);                       // an older cached result without the new columns
  assert.equal(velocitySplit(null), null);
  assert.equal(velocitySplit({ myntra_velocity: 0.2 }).shopify, '0.00');            // a SKU only Myntra sells
});

test('how long ago, in the biggest sensible unit', () => {
  assert.equal(ago(0), '0 minutes');
  assert.equal(ago(60_000), '1 minute');
  assert.equal(ago(12 * 60_000), '12 minutes');
  assert.equal(ago(60 * 60_000), '1 hour');
  assert.equal(ago(5 * 3_600_000), '5 hours');
  assert.equal(ago(72 * 3_600_000), '3 days');
  assert.equal(ago(-5000), '0 minutes');
});

test('the Myntra sync note: fresh is ok; missing, failed or stale is a warning', () => {
  const NOW = Date.parse('2026-10-31T10:00:00Z');
  const at = (msAgo) => new Date(NOW - msAgo).toISOString();
  assert.deepEqual(myntraSyncNote({ ok: true, at: at(12 * 60_000) }, NOW), { tone: 'ok', text: 'Myntra sales synced 12 minutes ago.' });
  assert.equal(myntraSyncNote({ ok: true, at: at(MYNTRA_SYNC_STALE_MS - 60_000) }, NOW).tone, 'ok');
  const stale = myntraSyncNote({ ok: true, at: at(MYNTRA_SYNC_STALE_MS + 60_000) }, NOW);
  assert.equal(stale.tone, 'warn'); assert.match(stale.text, /last synced 3 hours ago/);
  const failed = myntraSyncNote({ ok: false, at: at(30 * 60_000), error: 'Unicommerce Myntra order search failed: HTTP 403' }, NOW);
  assert.equal(failed.tone, 'warn'); assert.match(failed.text, /last sync failed 30 minutes ago \(Unicommerce Myntra order search failed: HTTP 403\)/);
  const never = myntraSyncNote(null, NOW);
  assert.equal(never.tone, 'warn'); assert.match(never.text, /velocity is Shopify only/);
  assert.equal(myntraSyncNote({ ok: true, at: 'garbage' }, NOW).tone, 'warn');
});
