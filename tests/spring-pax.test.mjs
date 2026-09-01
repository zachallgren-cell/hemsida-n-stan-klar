import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('startsidan gör vårpaxningen till tydligaste handlingen', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const siteJs = await readFile(new URL('site.js', root), 'utf8');

  assert.match(html, /Våren 2027 – paxningen är öppen/i);
  assert.match(html, /Paxa din fönsterputs till våren/);
  assert.match(html, /Kostnadsfritt[\s\S]*Inte bindande[\s\S]*Tar mindre än en minut/);
  assert.match(html, /data-pax-cta[^>]*>Paxa en plats till våren</);
  assert.match(html, /Företag kan fortfarande boka/);
  assert.match(html, /kontakt\.html\?arende=foretag#foretagskontakt/);
  assert.match(siteJs, /spring_2027_pax_cta_click/);
});

test('paxningsformuläret frågar bara efter avsedda uppgifter och visar rätt bekräftelse', async () => {
  const html = await readFile(new URL('bokning.html', root), 'utf8');
  const client = await readFile(new URL('paxning.js', root), 'utf8');

  for (const name of ['name', 'phone', 'email', 'location']) {
    assert.match(html, new RegExp(`name="${name}"[^>]*required`));
  }
  for (const name of ['requestedPeriod', 'serviceInterest', 'message']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /data-clarity-mask="true"/);
  assert.match(html, />Paxa min plats</);
  assert.match(html, /Paxningen är kostnadsfri och inte bindande\. Du förbinder dig inte till ett datum eller köp\./);
  assert.match(html, /Din plats är paxad!/);
  assert.match(html, /Bokningen blir giltig först när datum och pris har bekräftats\./);
  assert.match(client, /submit-spring-pax/);
  assert.match(client, /spring_2027_pax_completed/);
});

test('paxningar valideras, hastighetsbegränsas och lagras bakom RLS', async () => {
  const fn = await readFile(new URL('supabase/functions/submit-spring-pax/index.ts', root), 'utf8');
  const migration = await readFile(new URL('supabase/migrations/20260901000000_add_spring_2027_reservations.sql', root), 'utf8');
  const config = await readFile(new URL('supabase/config.toml', root), 'utf8');

  assert.match(fn, /readJsonWithLimit<PaxPayload>/);
  assert.match(fn, /consumeRateLimit/);
  assert.match(fn, /spring_2027_reservations\?on_conflict=request_id&select=id/);
  assert.match(fn, /resolution=ignore-duplicates/);
  assert.match(fn, /spring-2027-admin-/);
  assert.match(fn, /spring-2027-receipt-/);
  assert.match(migration, /create table if not exists public\.spring_2027_reservations/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.spring_2027_reservations from anon, authenticated/);
  assert.match(config, /\[functions\.submit-spring-pax\][\s\S]*verify_jwt = false/);
});
