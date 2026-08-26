import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('bokningen visar lägenhet och kräver val av fönstrens öppningsriktning', async () => {
  const html = await readFile(new URL('bokning.html', root), 'utf8');
  const client = await readFile(new URL('booking.js', root), 'utf8');

  assert.match(html, /name="housingType" value="Lägenhet"/);
  assert.match(html, /id="apartmentWindowOpeningGroup"[^>]*hidden/);
  assert.match(html, /name="apartmentWindowOpening" value="Fönstren öppnas inåt"/);
  assert.match(html, /name="apartmentWindowOpening" value="Fönstren öppnas utåt"/);
  assert.match(client, /checkedValue\('housingType'\) === 'Lägenhet' && !checkedValue\('apartmentWindowOpening'\)/);
});

test('lägenhet prissätts som enplansvilla inåt och flerplansvilla utåt i klient och server', async () => {
  const client = await readFile(new URL('booking.js', root), 'utf8');
  const server = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');

  assert.match(client, /return opening \? `Lägenhet – \$\{opening\.toLowerCase\(\)\}` : ''/);
  assert.match(client, /housingTypeLabel === 'Lägenhet – fönstren öppnas utåt'/);
  assert.match(server, /'Lägenhet – fönstren öppnas inåt'/);
  assert.match(server, /'Lägenhet – fönstren öppnas utåt'/);
  assert.match(server, /housingType === 'Lägenhet – fönstren öppnas utåt'/);
});

test('minimipriset inkluderar tio fönster i både kund- och serverberäkningen', async () => {
  const client = await readFile(new URL('booking.js', root), 'utf8');
  const server = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');
  const bookingPage = await readFile(new URL('bokning.html', root), 'utf8');
  const pricePage = await readFile(new URL('priser.html', root), 'utf8');

  assert.match(client, /const INCLUDED_WINDOWS = 10;/);
  assert.match(server, /const INCLUDED_WINDOWS = 10;/);
  assert.match(bookingPage, /Upp till 10 fönster ingår i startpriset/);
  assert.match(pricePage, /upp till 10 fönster och 150 kr material/i);
});
