import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('bokningsinbjudningar lagrar bara tokenhash och låser datumkapaciteten', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260828000000_add_booking_invitations.sql', root), 'utf8');

  assert.match(sql, /create table if not exists public\.booking_invitations/i);
  assert.match(sql, /token_hash text not null unique/i);
  assert.doesNotMatch(sql, /\btoken\s+text/i);
  assert.match(sql, /alter table public\.booking_invitations enable row level security/i);
  assert.match(sql, /revoke all on table public\.booking_invitations from public, anon, authenticated/i);
  assert.match(sql, /private\.enforce_booking_invitation_capacity\(\)/i);
  assert.match(sql, /public\.booking_invitations[\s\S]*status = 'active'[\s\S]*expires_at > now\(\)/i);
});

test('inbjudan slutförs atomärt och räknas som verifierad bokning', async () => {
  const sql = await readFile(new URL('supabase/migrations/20260828000000_add_booking_invitations.sql', root), 'utf8');

  assert.match(sql, /public\.finalize_booking_invitation\(/i);
  assert.match(sql, /where token_hash = p_token_hash[\s\S]*for update/i);
  assert.match(sql, /set status = 'completed'/i);
  assert.match(sql, /set status = 'pending',[\s\S]*email_confirmed_at = coalesce\(email_confirmed_at, now\(\)\)/i);
  assert.match(sql, /grant execute on function public\.finalize_booking_invitation\(text, text\) to service_role/i);
});

test('adminfunktionen kräver AAL2 och adminallowlist före skapande och listning', async () => {
  const edge = await readFile(new URL('supabase/functions/booking-invitation/index.ts', root), 'utf8');

  assert.match(edge, /getJwtAssuranceLevel\(authHeader\) !== 'aal2'/);
  assert.match(edge, /rpc\/is_booking_invitation_admin/);
  assert.match(edge, /const admin = await verifyAdmin/);
  assert.match(edge, /if \(action === 'list'\)/);
  assert.match(edge, /if \(action === 'cancel'\)/);
  assert.match(edge, /if \(action !== 'create'\)/);
  assert.match(edge, /const tokenHash = await sha256Hex\(token\)/);
  assert.match(edge, /token_hash: tokenHash/);
  assert.doesNotMatch(edge, /token:\s*token[,\n]/);
});

test('admininbjudan använder samma kalender och bokningsbara datum som kundsidan', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');
  const edge = await readFile(new URL('supabase/functions/booking-invitation/index.ts', root), 'utf8');

  assert.match(html, /id="invitationCalendarGrid"/);
  assert.match(html, /const BOOKED_SLOTS_URL = `\$\{SUPABASE_URL\}\/functions\/v1\/booked-slots`/);
  assert.match(html, /fetch\(BOOKED_SLOTS_URL/);
  assert.match(html, /function isInvitationWeekend\(dateString\)/);
  assert.match(html, /function isInvitationDateSelectable\(dateString\)/);
  assert.match(html, /invitationBlockedDates\.some/);
  assert.match(html, /usedCapacity < getInvitationCapacity\(dateString\)/);
  assert.doesNotMatch(html, /Inbjudan fungerar även för vardagar/);
  assert.match(edge, /!\[0, 6\]\.includes\(parsed\.getUTCDay\(\)\)/);
});

test('kundlänken låser mejl och bevarar stöd för ett reserverat datum', async () => {
  const html = await readFile(new URL('bokning.html', root), 'utf8');
  const client = await readFile(new URL('booking.js', root), 'utf8');

  assert.match(html, /id="invitationBookingNotice"[^>]*hidden/);
  assert.match(client, /url\.searchParams\.delete\('invite'\)/);
  assert.match(client, /url\.searchParams\.get\('reserved'\) === '1'/);
  assert.match(client, /if \(!queryToken && !shouldResumeInvitation\) \{[\s\S]*safelyRemoveSession\(INVITATION_SESSION_KEY\)/);
  assert.match(client, /url\.searchParams\.set\('reserved', '1'\)/);
  assert.match(client, /sessionStorage\.setItem\(INVITATION_SESSION_KEY, invitationToken\)/);
  assert.match(client, /byId\('email'\)\.readOnly = true/);
  assert.match(client, /selectedDate = isSpringPriorityInvitation\(\) \? '' : activeInvitation\.date/);
  assert.match(client, /if \(activeInvitation\?\.date === dateString\) return BOOKABLE_TIMES/);
  assert.match(client, /invitationToken: booking\.invitationToken \|\| null/);
});

test('vanlig tillgänglighet räknar aktiva reservationer och servern löser rätt inbjudan', async () => {
  const slots = await readFile(new URL('supabase/functions/booked-slots/index.ts', root), 'utf8');
  const createBooking = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');

  assert.match(slots, /booking_invitations\?select=booking_date&invitation_type=eq\.reserved_date&booking_date=not\.is\.null&status=eq\.active/);
  assert.match(slots, /\.\.\.activeInvitations\.map/);
  assert.match(createBooking, /await sha256Hex\(invitationToken\)/);
  assert.match(createBooking, /booking_invitations\?select=id,email,booking_date,invitation_type,window_start,window_end,status,expires_at/);
  assert.match(createBooking, /otherInvitationCount/);
  assert.match(createBooking, /'finalize_booking_invitation'/);
  assert.match(createBooking, /const requiresEmailConfirmation = !invitationRecord/);
});

test('vårpaxningar kan öppnas för alla lediga helger 1 mars till 15 juni 2027', async () => {
  const migration = await readFile(new URL('supabase/migrations/20260901010000_add_spring_booking_access.sql', root), 'utf8');
  const edge = await readFile(new URL('supabase/functions/booking-invitation/index.ts', root), 'utf8');
  const client = await readFile(new URL('booking.js', root), 'utf8');
  const createBooking = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');
  const admin = await readFile(new URL('admin.html', root), 'utf8');

  assert.match(migration, /invitation_type text not null default 'reserved_date'/);
  assert.match(migration, /'spring_priority'/);
  assert.match(migration, /window_start date/);
  assert.match(migration, /window_end date/);
  assert.match(migration, /new\.invitation_type <> 'reserved_date'/);
  assert.match(migration, /extract\(isodow from target_booking\.booking_date\) in \(6, 7\)/);
  assert.match(migration, /update public\.spring_2027_reservations[\s\S]*set status = 'booked'/);

  assert.match(edge, /SPRING_BOOKING_WINDOW_START = '2027-03-01'/);
  assert.match(edge, /SPRING_BOOKING_WINDOW_END = '2027-06-15'/);
  assert.match(edge, /action === 'list-spring-reservations'/);
  assert.match(edge, /action === 'create-spring-access'/);
  assert.match(edge, /invitation_type: 'spring_priority'/);

  assert.match(admin, /data-admin-view="springPax"/);
  assert.match(admin, /id="springPaxList"/);
  assert.match(admin, /class="button button-primary action-open-spring-booking"/);
  assert.match(admin, /callBookingInvitation\('create-spring-access', \{ reservationId \}\)/);

  assert.match(client, /function isSpringPriorityInvitation\(\)/);
  assert.match(client, /isDateWithinInvitationWindow\(date\)/);
  assert.match(client, /Välj en ledig lördag eller söndag mellan 1 mars och 15 juni 2027/);
  assert.match(createBooking, /invitationRecord\.invitation_type === 'spring_priority'/);
  assert.match(createBooking, /payload\.date >= invitationRecord\.window_start/);
  assert.match(createBooking, /isBookableTime\(payload\.time, payload\.date\)/);
});

test('tacksidan skiljer reserverad inbjudan från vanlig mejlbekräftelse', async () => {
  const html = await readFile(new URL('betalning.html', root), 'utf8');

  assert.match(html, /confirmationValue\('requiresEmailConfirmation', true\)/);
  assert.match(html, /if \(hasBookingSummary && !requiresEmailConfirmation\)/);
  assert.match(html, /Ditt datum är reserverat/);
});

test('kundsidor och kundmejl ger en tydlig förberedelsechecklista', async () => {
  const bookingPage = await readFile(new URL('bokning.html', root), 'utf8');
  const paymentPage = await readFile(new URL('betalning.html', root), 'utf8');
  const managePage = await readFile(new URL('hantera-bokning.html', root), 'utf8');
  const bookingEmail = await readFile(new URL('supabase/functions/create-booking/index.ts', root), 'utf8');
  const invitationEmail = await readFile(new URL('supabase/functions/booking-invitation/index.ts', root), 'utf8');
  const reminderEmail = await readFile(new URL('supabase/functions/send-booking-reminders/index.ts', root), 'utf8');
  const changeEmail = await readFile(new URL('supabase/functions/manage-booking/index.ts', root), 'utf8');

  for (const source of [bookingPage, paymentPage, managePage, bookingEmail, invitationEmail, reminderEmail, changeEmail]) {
    assert.match(source, /Töm alla fönsterbrädor|töm alla fönsterbrädor/i);
    assert.match(source, /alla fönster|samtliga fönster/i);
    assert.match(source, /åtkomliga/i);
  }

  assert.match(reminderEmail, /Påminnelse inför fönsterputs – förbered fönstren/);
  assert.match(reminderEmail, /VIKTIGT ATT GÖRA INNAN VI KOMMER/);
  assert.match(changeEmail, /action === 'reschedule'/);
});
