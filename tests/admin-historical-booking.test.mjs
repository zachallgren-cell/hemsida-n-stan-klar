import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('adminen har ett separat formulär för bokningar i efterhand', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');

  assert.match(html, /id="historicalBookingToggle"[^>]*>\+ Bokning i efterhand</);
  assert.match(html, /id="historicalBookingForm"/);
  assert.match(html, /historicalBookingDate\.max = stockholmToday\(\)/);
  assert.match(html, /bookingDate > stockholmToday\(\)/);
  assert.match(html, /\.rpc\('admin_create_historical_booking'/);
  assert.match(html, /Inget bokningsmejl skickas automatiskt/);
});

test('historiska bokningar skapas endast av MFA-verifierad admin', async () => {
  const sql = await readFile(
    new URL('supabase/migrations/20260907000000_add_historical_admin_bookings.sql', root),
    'utf8'
  );

  assert.match(sql, /if not private\.is_booking_admin\(\) then/i);
  assert.match(sql, /p_booking_date\s*>\s*\(now\(\) at time zone 'Europe\/Stockholm'\)::date/i);
  assert.match(sql, /insert into public\.bookings/i);
  assert.match(sql, /historical_booking_created/i);
  assert.match(sql, /revoke all on function public\.admin_create_historical_booking[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.admin_create_historical_booking[\s\S]*to authenticated/i);
});

test('redan betalda efterhandsbokningar ber inte om ett nytt betalningsmejl', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');

  assert.match(html, /workCompleted && !paymentPaid && !booking\.payment_email_sent/);
  assert.match(html, /booking\.payment_email_sent \|\| paymentIsPaid \? 'disabled'/);
});
