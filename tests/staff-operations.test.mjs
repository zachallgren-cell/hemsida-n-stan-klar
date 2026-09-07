import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('personalmodulen separerar bokning från personalens jobbkopia', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260903000000_add_staff_operations.sql', root), 'utf8');

  assert.match(sql, /create table if not exists public\.staff_jobs/i);
  assert.match(sql, /Operativ och minimerad jobbkopia/i);
  assert.match(sql, /revoke all on table public\.%I from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant\s+select\s+on\s+(?:table\s+)?public\.bookings\s+to\s+authenticated/i);
  assert.match(sql, /case when has_assignment then job_record\.customer_name else null end/i);
  assert.match(sql, /case when has_assignment then job_record\.address else null end/i);
  assert.match(sql, /sync_staff_job_after_booking_update/i);
  assert.match(sql, /Kundbokningen avbröts/i);
});

test('paxning och timer skyddas atomiskt i databasen', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260903000000_add_staff_operations.sql', root), 'utf8');

  assert.match(sql, /create or replace function public\.staff_claim_job/i);
  assert.match(sql, /where id = p_job_id for update/i);
  assert.match(sql, /assigned_count >= job_record\.required_staff/i);
  assert.match(sql, /staff_time_entries_one_running_idx[\s\S]*where ended_at is null/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /Slutför alla obligatoriska checklistpunkter först/i);
});

test('provisionen är 20 procent exklusive moms och fryses efter godkännande', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260903000000_add_staff_operations.sql', root), 'utf8');

  assert.match(sql, /commission_rate_basis_points integer not null default 2000/i);
  assert.match(sql, /round\(gross_ore::numeric \* 10000 \/ 12500\)::bigint/i);
  assert.match(sql, /status in \('approved', 'paid'\)/i);
  assert.match(sql, /sum\(worked_seconds\) over \(\)/i);
  assert.match(sql, /unique \(job_id, staff_user_id\)/i);
});

test('personalportalen innehåller pass, checklista, timer och provision utan adminflöden', async () => {
  const html = await readFile(new URL('personal.html', root), 'utf8');
  const js = await readFile(new URL('personal.js', root), 'utf8');

  assert.match(html, />Lediga pass</);
  assert.match(html, /Intjänad provision/);
  assert.match(js, /staff_claim_job/);
  assert.match(js, /staff_start_job_time/);
  assert.match(js, /staff_set_checklist_item/);
  assert.doesNotMatch(html, /RUT|personnummer|Betalningar/);
  assert.doesNotMatch(html, /<script\s+type="module">/);
});

test('adminen har arbetsytor för personal, bemanning och jobbekonomi', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');
  const js = await readFile(new URL('admin-workforce.js', root), 'utf8');

  for (const view of ['workforce', 'staff', 'checklists', 'staffFinance']) {
    assert.match(html, new RegExp(`data-admin-view="${view}"`));
  }
  assert.match(js, /admin_upsert_staff_job_from_booking/);
  assert.match(js, /admin_set_staff_commission_status/);
  assert.match(js, /Täckningsbidrag/);
  assert.match(js, /payroll_oncost/);
});

test('personalinbjudan kräver både AAL2 och adminallowlist', async () => {
  const source = await readFile(new URL('supabase/functions/staff-operations/index.ts', root), 'utf8');

  assert.match(source, /getJwtAssuranceLevel\(authHeader\) !== 'aal2'/);
  assert.match(source, /rest\/v1\/admin_users\?select=user_id/);
  assert.match(source, /auth\/v1\/invite\?redirect_to=/);
  assert.match(source, /staff_profiles\?on_conflict=user_id/);
});
