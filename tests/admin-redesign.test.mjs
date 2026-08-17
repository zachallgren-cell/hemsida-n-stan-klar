import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('adminen använder arbetsnavigation och progressiv informationsvisning', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');

  for (const view of ['overview', 'calendar', 'bookings', 'customers', 'followUp', 'payments', 'discountCodes', 'blockedDates']) {
    assert.match(html, new RegExp(`data-admin-view="${view}"`));
  }

  assert.match(html, /id="bookingsList"/);
  assert.match(html, /id="bookingDrawer"/);
  assert.match(html, /function renderBookingTable\(\)/);
  assert.match(html, /function buildBookingDetail\(booking\)/);
  assert.match(html, /data-booking-filter="unpaid">Utförda men obetalda/);
  assert.match(html, />Visa webbplatsen</);
});

test('befintliga Swish- och RUT-kontrakt är kvar i den nya drawern', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');

  assert.match(html, /COMPLETE_BOOKING_URL/);
  assert.match(html, /ADMIN_RUT_DETAILS_URL/);
  assert.match(html, /SWISH_NUMBER_DISPLAY = '123 677 43 84'/);
  assert.match(html, /action-show-rut/);
  assert.match(html, /window\.setTimeout\(\(\) => hideRutNumber\(card\), 60_000\)/);
  assert.match(html, /action-purge-rut/);
});

test('spärrade datum grupperas och konflikter stoppar sparandet', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');

  assert.match(html, /function groupBlockedDates\(blockedDates\)/);
  assert.match(html, /data-blocked-date-ids/);
  assert.match(html, /Ingen bokning har flyttats eller tagits bort/);
  assert.match(html, /\.in\('status', \['pending', 'confirmed'\]\)/);
});

test('CRM-migrationen är additiv och har idempotensskydd', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260818000000_add_admin_crm_foundation.sql', root), 'utf8');

  assert.doesNotMatch(sql, /alter table public\.bookings/i);
  assert.doesNotMatch(sql, /(?:delete|update)\s+(?:from\s+)?public\.bookings/i);
  assert.match(sql, /unique \(idempotency_key\)/i);
  assert.match(sql, /unique \(automation_id, idempotency_key\)/i);
  assert.match(sql, /review_status.*not_requested.*reminder_sent.*received.*do_not_contact/is);
  assert.match(sql, /active\s+boolean\s+not null default false/i);
  assert.match(sql, /private\.is_booking_admin\(\)/);
});

test('adminlayouten har explicita desktop- och mobilregler', async () => {
  const css = await readFile(new URL('admin-v2.css', root), 'utf8');

  assert.match(css, /body\.is-admin-ready\s*\{[^}]*padding-left:\s*248px/s);
  assert.match(css, /@media \(max-width: 920px\)/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /\.booking-drawer/);
  assert.match(css, /:focus-visible/);
}
);
