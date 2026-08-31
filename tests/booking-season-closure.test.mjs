import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('vanlig onlinebokning är stängd för resten av säsongen', async () => {
  const html = await readFile(new URL('bokning.html', root), 'utf8');
  const client = await readFile(new URL('booking.js', root), 'utf8');
  const server = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');

  assert.match(html, /id="seasonBookingNotice"[^>]*hidden/);
  assert.match(html, /Berga Fönsterputs är fullbokade resten av säsongen/);
  assert.match(client, /const REGULAR_BOOKING_SEASON_CLOSED = true;/);
  assert.match(client, /if \(REGULAR_BOOKING_SEASON_CLOSED && !activeInvitation\) return false;/);
  assert.match(client, /calendarCard\.hidden = true;/);
  assert.match(client, /continueFromCalendarButton\.hidden = true;/);
  assert.match(server, /const REGULAR_BOOKING_SEASON_CLOSED = true;/);
  assert.match(server, /if \(!invitationRecord && REGULAR_BOOKING_SEASON_CLOSED\)/);
  assert.match(server, /Berga Fönsterputs är fullbokade resten av säsongen/);
});
