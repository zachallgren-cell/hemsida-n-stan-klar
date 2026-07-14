const CLAIM_LIMIT = 25;
const MAX_TOTAL_BATCH = CLAIM_LIMIT * 2;

type BookingRow = Record<string, unknown>;

type RuntimeConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  resendApiKey: string;
  fromEmail: string;
  contactEmail: string;
  siteUrl: string;
};

type DeliveryCounts = {
  reminders_claimed: number;
  reminders_sent: number;
  reminders_failed: number;
  reminders_skipped: number;
  recurrence_claimed: number;
  recurrence_sent: number;
  recurrence_failed: number;
  recurrence_skipped: number;
  claim_errors: number;
  claim_release_errors: number;
};

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff'
};

function emptyCounts(): DeliveryCounts {
  return {
    reminders_claimed: 0,
    reminders_sent: 0,
    reminders_failed: 0,
    reminders_skipped: 0,
    recurrence_claimed: 0,
    recurrence_sent: 0,
    recurrence_failed: 0,
    recurrence_skipped: 0,
    claim_errors: 0,
    claim_release_errors: 0
  };
}

function countsResponse(counts: DeliveryCounts, status = 200, allowPost = false) {
  return new Response(JSON.stringify(counts), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      ...(allowPost ? { Allow: 'POST' } : {})
    }
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeSingleLine(value: unknown, maxLength: number) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeBookingId(value: unknown) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? '').trim();
  if (!email || email.length > 254 || /[\r\n]/.test(email)) return null;
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeHttpUrl(value: string, requireHttps = false) {
  try {
    const url = new URL(value);
    if (requireHttps ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function formatBookingDate(value: unknown) {
  const dateString = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;

  const date = new Date(`${dateString}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) {
    return null;
  }

  return new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Stockholm'
  }).format(date);
}

function formatBookingTime(value: unknown) {
  const time = String(value ?? '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(time)) {
    return null;
  }
  return time.slice(0, 5);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function idempotencyKey(parts: Array<string | number>) {
  return parts
    .map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, '-'))
    .join('-')
    .slice(0, 240);
}

function emailShell(preheader: string, title: string, content: string, contactEmail: string) {
  const safeContactEmail = escapeHtml(contactEmail);
  return `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;background:#f3f7f8;color:#102b3c;font-family:Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7f8;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dfeaec;">
            <tr>
              <td style="background:#123f55;padding:24px 28px;color:#ffffff;">
                <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#bfe6d0;font-weight:700;">Berga Fönsterputs</div>
                <h1 style="margin:8px 0 0;font-size:26px;line-height:1.25;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-size:16px;line-height:1.65;">${content}</td>
            </tr>
            <tr>
              <td style="padding:20px 28px;background:#edf5f2;color:#45606e;font-size:13px;line-height:1.5;">
                Frågor? Svara på mejlet eller kontakta
                <a href="mailto:${safeContactEmail}" style="color:#17663d;">${safeContactEmail}</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildReminderEmail(booking: BookingRow, contactEmail: string) {
  const id = normalizeBookingId(booking.id);
  const email = normalizeEmail(booking.email);
  const dateValue = String(booking.booking_date ?? '').trim();
  const date = formatBookingDate(dateValue);
  const time = formatBookingTime(booking.booking_time);
  const address = normalizeSingleLine(booking.address, 500);
  const name = normalizeSingleLine(booking.customer_name, 120) || '';

  if (!id || !email || !date || !time || !address) {
    throw new Error('invalid_reminder_row');
  }

  const safeGreeting = name ? `Hej ${escapeHtml(name)}!` : 'Hej!';
  const content = `
    <p style="margin:0 0 18px;">${safeGreeting}</p>
    <p style="margin:0 0 20px;">Det här är en påminnelse om att din fönsterputsning är bokad om cirka 24 timmar.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7faf9;border-radius:10px;">
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e2ece8;color:#5b6f79;">Datum</td>
        <td style="padding:12px 16px;border-bottom:1px solid #e2ece8;text-align:right;font-weight:700;">${escapeHtml(date)}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e2ece8;color:#5b6f79;">Tid</td>
        <td style="padding:12px 16px;border-bottom:1px solid #e2ece8;text-align:right;font-weight:700;">${escapeHtml(time)}</td>
      </tr>
      <tr>
        <td style="padding:12px 16px;color:#5b6f79;vertical-align:top;">Adress</td>
        <td style="padding:12px 16px;text-align:right;font-weight:700;">${escapeHtml(address)}</td>
      </tr>
    </table>
    <p style="margin:20px 0 0;">Vi ses snart!</p>`;

  const subject = `Påminnelse: fönsterputs ${dateValue} kl. ${time}`;
  const html = emailShell(
    `Din fönsterputsning är bokad ${date} klockan ${time}.`,
    'Påminnelse om din bokning',
    content,
    contactEmail
  );
  const text = [
    name ? `Hej ${name}!` : 'Hej!',
    '',
    'Det här är en påminnelse om att din fönsterputsning är bokad om cirka 24 timmar.',
    `Datum: ${date}`,
    `Tid: ${time}`,
    `Adress: ${address}`,
    '',
    'Vi ses snart!',
    `Frågor? Svara på mejlet eller kontakta ${contactEmail}.`
  ].join('\n');

  return {
    id,
    email,
    subject,
    html,
    text,
    key: idempotencyKey(['booking-reminder-v1', id, dateValue, time])
  };
}

async function buildRecurrenceEmail(
  booking: BookingRow,
  token: string,
  siteUrl: string,
  contactEmail: string
) {
  const id = normalizeBookingId(booking.id);
  const email = normalizeEmail(booking.email);
  const name = normalizeSingleLine(booking.customer_name, 120) || '';
  const weeks = Number(booking.recurrence_weeks);

  if (!id || !email || (weeks !== 8 && weeks !== 12)) {
    throw new Error('invalid_recurrence_row');
  }

  const fragment = new URLSearchParams({ bookingId: id, token }).toString();
  const managementUrl = `${siteUrl}/hantera-bokning.html#${fragment}`;
  const safeManagementUrl = escapeHtml(managementUrl);
  const safeGreeting = name ? `Hej ${escapeHtml(name)}!` : 'Hej!';
  const content = `
    <p style="margin:0 0 18px;">${safeGreeting}</p>
    <p style="margin:0 0 18px;">Det har nu gått ${weeks} veckor sedan ditt senaste besök. Vill du boka samma fönsterputsning igen?</p>
    <p style="margin:24px 0;">
      <a href="${safeManagementUrl}" style="display:inline-block;background:#218a50;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:8px;">Boka samma igen</a>
    </p>
    <p style="margin:0;color:#5b6f79;font-size:14px;">En ny bokning skapas aldrig automatiskt. Du väljer själv datum innan något bokas.</p>`;

  const html = emailShell(
    `Vill du boka samma fönsterputsning igen efter ${weeks} veckor?`,
    'Dags för rena fönster igen?',
    content,
    contactEmail
  );
  const text = [
    name ? `Hej ${name}!` : 'Hej!',
    '',
    `Det har nu gått ${weeks} veckor sedan ditt senaste besök.`,
    'Vill du boka samma fönsterputsning igen?',
    '',
    `Boka samma igen: ${managementUrl}`,
    '',
    'En ny bokning skapas aldrig automatiskt. Du väljer själv datum innan något bokas.',
    `Frågor? Svara på mejlet eller kontakta ${contactEmail}.`
  ].join('\n');
  const tokenDigest = await sha256Hex(token);

  return {
    id,
    email,
    subject: `Boka samma fönsterputsning igen efter ${weeks} veckor`,
    html,
    text,
    key: idempotencyKey(['booking-recurrence-v1', id, weeks, tokenDigest.slice(0, 24)])
  };
}

async function claimRows(
  config: RuntimeConfig,
  rpcName: 'claim_due_booking_reminders' | 'claim_due_recurrence_invitations'
) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_limit: CLAIM_LIMIT })
  });

  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new Error('claim_rpc_failed');
  }

  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    throw new Error('claim_rpc_invalid_json');
  }

  if (!Array.isArray(rows)) {
    throw new Error('claim_rpc_invalid_shape');
  }

  return rows.slice(0, CLAIM_LIMIT).map((row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? row as BookingRow
      : {} as BookingRow
  );
}

async function patchBooking(
  config: RuntimeConfig,
  bookingId: string,
  update: Record<string, unknown>,
  filters: Record<string, string> = {}
) {
  const query = new URLSearchParams({ id: `eq.${bookingId}` });
  Object.entries(filters).forEach(([column, filter]) => query.set(column, filter));
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/bookings?${query.toString()}`,
    {
      method: 'PATCH',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(update)
    }
  );

  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new Error('booking_patch_failed');
  }

  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function fetchCurrentBooking(config: RuntimeConfig, bookingId: string) {
  const query = new URLSearchParams({
    id: `eq.${bookingId}`,
    select: '*',
    limit: '1'
  });
  const response = await fetch(`${config.supabaseUrl}/rest/v1/bookings?${query.toString()}`, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new Error('booking_recheck_failed');
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
    ? rows[0] as BookingRow
    : null;
}

async function sendEmail(
  config: RuntimeConfig,
  message: { email: string; subject: string; html: string; text: string; key: string }
) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': message.key
    },
    body: JSON.stringify({
      from: config.fromEmail,
      to: [message.email],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: config.contactEmail
    })
  });

  await response.text().catch(() => undefined);
  if (!response.ok) {
    throw new Error('resend_failed');
  }
}

async function releaseClaim(
  config: RuntimeConfig,
  booking: BookingRow,
  claimColumn: 'reminder_claimed_at' | 'recurrence_invitation_claimed_at'
) {
  const id = normalizeBookingId(booking.id);
  if (!id) throw new Error('invalid_booking_id');
  const claimedAt = normalizeSingleLine(booking[claimColumn], 60);
  if (!claimedAt) return;
  await patchBooking(
    config,
    id,
    { [claimColumn]: null },
    { [claimColumn]: `eq.${claimedAt}` }
  );
}

async function processReminder(
  config: RuntimeConfig,
  booking: BookingRow
) {
  const id = normalizeBookingId(booking.id);
  const claimedAt = normalizeSingleLine(booking.reminder_claimed_at, 60);
  if (!id || !claimedAt) return false;
  const current = await fetchCurrentBooking(config, id);
  const claimIsCurrent = current
    && ['pending', 'confirmed'].includes(String(current.status || ''))
    && Boolean(current.email_confirmed_at)
    && !current.reminder_sent_at
    && String(current.reminder_claimed_at || '') === claimedAt
    && String(current.booking_date || '') === String(booking.booking_date || '')
    && String(current.booking_time || '') === String(booking.booking_time || '');
  if (!claimIsCurrent || !current) {
    await releaseClaim(config, booking, 'reminder_claimed_at');
    return false;
  }

  const message = buildReminderEmail(current, config.contactEmail);
  await sendEmail(config, message);
  await patchBooking(
    config,
    message.id,
    {
      reminder_sent_at: new Date().toISOString(),
      reminder_claimed_at: null
    },
    {
      reminder_claimed_at: `eq.${claimedAt}`,
      booking_date: `eq.${String(current.booking_date || '')}`,
      booking_time: `eq.${String(current.booking_time || '')}`,
      status: 'in.(pending,confirmed)'
    }
  );
  return true;
}

async function processRecurrenceInvitation(
  config: RuntimeConfig,
  booking: BookingRow
) {
  const id = normalizeBookingId(booking.id);
  const claimedAt = normalizeSingleLine(booking.recurrence_invitation_claimed_at, 60);
  if (!id || !claimedAt) return false;
  const current = await fetchCurrentBooking(config, id);
  const weeks = Number(current?.recurrence_weeks);
  const claimIsCurrent = current
    && (weeks === 8 || weeks === 12)
    && Boolean(current.recurrence_opt_in_at)
    && !current.recurrence_paused_at
    && !current.recurrence_invitation_sent_at
    && String(current.recurrence_invitation_claimed_at || '') === claimedAt
    && String(current.completed_at || '') === String(booking.completed_at || '');
  if (!claimIsCurrent || !current) {
    await releaseClaim(config, booking, 'recurrence_invitation_claimed_at');
    return false;
  }

  // Derive the same high-entropy token for every retry of this exact
  // invitation. Resend can then de-duplicate an ambiguous delivery and a
  // transient database failure can never strand a one-off raw token.
  const token = await hmacSha256Hex(
    config.serviceRoleKey,
    ['booking-recurrence-v1', id, weeks, String(current.completed_at || '')].join('|')
  );
  const tokenHash = await sha256Hex(token);
  const message = await buildRecurrenceEmail(
    current,
    token,
    config.siteUrl,
    config.contactEmail
  );
  const previousTokenHash = typeof current.management_token_hash === 'string'
    ? current.management_token_hash
    : null;
  const previousTokenExpiry = typeof current.management_token_expires_at === 'string'
    ? current.management_token_expires_at
    : null;
  // Rotate the token while the claim is still current. The invitation is only
  // marked as sent after the provider accepts the idempotent email request.
  const invitationPrepared = await patchBooking(
    config,
    id,
    { management_token: token },
    {
      recurrence_invitation_claimed_at: `eq.${claimedAt}`,
      recurrence_invitation_sent_at: 'is.null',
      recurrence_paused_at: 'is.null',
      recurrence_weeks: `eq.${weeks}`
    }
  );
  if (!invitationPrepared) return false;
  let deliveryAccepted = false;
  try {
    const prepared = await fetchCurrentBooking(config, id);
    if (!prepared
      || prepared.recurrence_paused_at
      || Number(prepared.recurrence_weeks) !== weeks
      || prepared.recurrence_invitation_sent_at
      || String(prepared.recurrence_invitation_claimed_at || '') !== claimedAt
      || String(prepared.management_token_hash || '') !== tokenHash) {
      return false;
    }

    await sendEmail(config, message);
    deliveryAccepted = true;

    await patchBooking(
      config,
      id,
      {
        recurrence_invitation_sent_at: new Date().toISOString(),
        recurrence_invitation_claimed_at: null
      },
      {
        recurrence_invitation_claimed_at: `eq.${claimedAt}`,
        recurrence_invitation_sent_at: 'is.null',
        management_token_hash: `eq.${tokenHash}`,
        recurrence_paused_at: 'is.null',
        recurrence_weeks: `eq.${weeks}`
      }
    );
    return true;
  } finally {
    if (!deliveryAccepted) {
      // Keep the customer's previous management link usable if anything fails
      // before the provider accepts the email. A conditional rollback cannot
      // overwrite a newer worker's token.
      await patchBooking(
        config,
        id,
        {
          management_token_hash: previousTokenHash,
          management_token_expires_at: previousTokenExpiry
        },
        {
          recurrence_invitation_claimed_at: `eq.${claimedAt}`,
          recurrence_invitation_sent_at: 'is.null',
          management_token_hash: `eq.${tokenHash}`
        }
      );
    }
  }
}

function getRuntimeConfig() {
  const supabaseUrl = normalizeHttpUrl(Deno.env.get('SUPABASE_URL') || '');
  const serviceRoleKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  const resendApiKey = (Deno.env.get('RESEND_API_KEY') || '').trim();
  const fromEmail = (Deno.env.get('BOOKING_FROM_EMAIL') || '').trim();
  const configuredContactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
  const contactEmail = normalizeEmail(configuredContactEmail) || 'info@bergafonsterputs.se';
  const siteUrl = normalizeHttpUrl(
    Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se',
    true
  );

  if (
    !supabaseUrl ||
    !serviceRoleKey ||
    !resendApiKey ||
    !fromEmail ||
    fromEmail.length > 320 ||
    !siteUrl
  ) {
    return null;
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    resendApiKey,
    fromEmail,
    contactEmail,
    siteUrl
  } satisfies RuntimeConfig;
}

Deno.serve(async (req) => {
  const counts = emptyCounts();

  // This endpoint is intended for a server-side cron POST. It deliberately has
  // no CORS headers and never returns booking data or upstream error bodies.
  if (req.method !== 'POST') {
    return countsResponse(counts, 405, true);
  }

  const config = getRuntimeConfig();
  if (!config) {
    return countsResponse(counts, 503);
  }

  const [reminderClaim, recurrenceClaim] = await Promise.allSettled([
    claimRows(config, 'claim_due_booking_reminders'),
    claimRows(config, 'claim_due_recurrence_invitations')
  ]);

  const reminderRows = reminderClaim.status === 'fulfilled' ? reminderClaim.value : [];
  const recurrenceRows = recurrenceClaim.status === 'fulfilled' ? recurrenceClaim.value : [];

  if (reminderClaim.status === 'rejected') {
    counts.claim_errors += 1;
    console.error('Reminder claim RPC failed');
  }
  if (recurrenceClaim.status === 'rejected') {
    counts.claim_errors += 1;
    console.error('Recurrence claim RPC failed');
  }

  counts.reminders_claimed = reminderRows.length;
  counts.recurrence_claimed = recurrenceRows.length;

  // Both RPC calls are capped at 25, so one public invocation can process at
  // most 50 rows even if it is called repeatedly or concurrently.
  const totalClaimed = reminderRows.length + recurrenceRows.length;
  if (totalClaimed > MAX_TOTAL_BATCH) {
    return countsResponse(counts, 500);
  }

  for (const booking of reminderRows) {
    try {
      if (await processReminder(config, booking)) counts.reminders_sent += 1;
      else counts.reminders_skipped += 1;
    } catch {
      counts.reminders_failed += 1;
      console.error('Reminder delivery failed');
      try {
        await releaseClaim(config, booking, 'reminder_claimed_at');
      } catch {
        counts.claim_release_errors += 1;
        console.error('Reminder claim release failed');
      }
    }
  }

  for (const booking of recurrenceRows) {
    try {
      if (await processRecurrenceInvitation(config, booking)) counts.recurrence_sent += 1;
      else counts.recurrence_skipped += 1;
    } catch {
      counts.recurrence_failed += 1;
      console.error('Recurrence invitation delivery failed');
      try {
        await releaseClaim(config, booking, 'recurrence_invitation_claimed_at');
      } catch {
        counts.claim_release_errors += 1;
        console.error('Recurrence claim release failed');
      }
    }
  }

  const hasFailures = counts.claim_errors > 0
    || counts.claim_release_errors > 0
    || counts.reminders_failed > 0
    || counts.recurrence_failed > 0;
  return countsResponse(counts, hasFailures ? 502 : 200);
});
