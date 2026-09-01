import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('vanlig onlinebokning ersätts av vårpaxning medan personliga inbjudningar bevaras', async () => {
  const html = await readFile(new URL('bokning.html', root), 'utf8');
  const client = await readFile(new URL('booking.js', root), 'utf8');
  const server = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');

  assert.match(html, /id="paxExperience"/);
  assert.match(html, /id="paxForm"/);
  assert.match(html, /id="regularBookingExperience"[^>]*hidden/);
  assert.match(html, /Paxa din fönsterputs till våren/);
  assert.match(html, /Vi är fullbokade för privatkunder resten av säsongen/);
  assert.match(client, /const REGULAR_BOOKING_SEASON_CLOSED = true;/);
  assert.match(client, /if \(REGULAR_BOOKING_SEASON_CLOSED && !activeInvitation\) return false;/);
  assert.match(client, /regularBookingExperience\.hidden = true;/);
  assert.match(client, /regularBookingExperience\.hidden = false;/);
  assert.match(client, /paxExperience\.hidden = true;/);
  assert.match(server, /const REGULAR_BOOKING_SEASON_CLOSED = true;/);
  assert.match(server, /if \(!invitationRecord && REGULAR_BOOKING_SEASON_CLOSED\)/);
  assert.match(server, /Berga Fönsterputs är fullbokade resten av säsongen/);
});
