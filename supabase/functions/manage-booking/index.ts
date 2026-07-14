const ALLOWED_ORIGIN = 'https://bergafonsterputs.se';
const MAX_BODY_BYTES = 8_192;
const BOOKABLE_TIMES = new Set([
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00'
]);
const RUT_YES = 'Ja, skicka säkert RUT-formulär via bekräftelsemejl';

type ManageAction = 'details' | 'confirm' | 'cancel' | 'reschedule' | 'set_recurrence';

type ManagePayload = {
  action?: unknown;
  bookingId?: unknown;
  token?: unknown;
  newDate?: unknown;
  newTime?: unknown;
  recurrenceWeeks?: unknown;
};

type BookingRow = {
  id: string | number;
  customer_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  postal_code?: string | null;
  housing_type?: string | null;
  window_count?: string | null;
  service_scope?: string | null;
  addons?: string | null;
  transport_type?: string | null;
  sea_miles?: string | null;
  coordinates?: string | null;
  booking_date?: string | null;
  booking_time?: string | null;
  price?: string | number | null;
  status?: string | null;
  rut_choice?: string | null;
  recurrence_weeks?: number | null;
  email_confirmation_expires_at?: string | null;
  email_confirmed_at?: string | null;
  customer_confirmation_email_sent_at?: string | null;
  cancelled_at?: string | null;
  rescheduled_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
};

type RpcResult = {
  ok?: boolean;
  code?: string;
  status?: string;
  already_done?: boolean;
  booking_date?: string;
  booking_time?: string;
  recurrence_weeks?: number | null;
};

type EmailConfig = {
  apiKey: string;
  from: string;
  contactEmail: string;
  notificationEmail: string;
  siteUrl: string;
};

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function securityHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin'
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function originIsAllowed(req: Request) {
  const origin = req.headers.get('origin');
  return !origin || origin === ALLOWED_ORIGIN;
}

async function readJsonWithLimit(req: Request): Promise<ManagePayload> {
  const contentLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }

  if (!req.body) throw new InvalidJsonError();

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidJsonError();
    }
    return parsed as ManagePayload;
  } catch (error) {
    if (error instanceof InvalidJsonError) throw error;
    throw new InvalidJsonError();
  }
}

function normalizeBookingId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === 'string' ? value : '';
}

function isValidBookingId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
}

function isValidRawToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function getStockholmDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '';
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidBookableDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = getStockholmDateString();
  return value >= addDays(today, 2) && value <= addDays(today, 365);
}

function isValidBookableTime(value: unknown): value is string {
  return typeof value === 'string' && BOOKABLE_TIMES.has(value);
}

function parseAndValidatePayload(payload: ManagePayload) {
  const action = payload.action;
  const bookingId = normalizeBookingId(payload.bookingId);
  const token = payload.token;

  if (typeof action !== 'string'
    || !['details', 'confirm', 'cancel', 'reschedule', 'set_recurrence'].includes(action)
    || !isValidBookingId(bookingId)
    || !isValidRawToken(token)) {
    return null;
  }

  if (action === 'reschedule') {
    if (!isValidBookableDate(payload.newDate) || !isValidBookableTime(payload.newTime)) return null;
    if (payload.recurrenceWeeks !== undefined) return null;
  } else if (action === 'set_recurrence') {
    if (payload.recurrenceWeeks !== null
      && payload.recurrenceWeeks !== 8
      && payload.recurrenceWeeks !== 12) return null;
    if (payload.newDate !== undefined || payload.newTime !== undefined) return null;
  } else if (payload.newDate !== undefined
    || payload.newTime !== undefined
    || payload.recurrenceWeeks !== undefined) {
    return null;
  }

  return {
    action: action as ManageAction,
    bookingId,
    token: token.toLowerCase(),
    newDate: action === 'reschedule' ? payload.newDate as string : null,
    newTime: action === 'reschedule' ? payload.newTime as string : null,
    recurrenceWeeks: action === 'set_recurrence' ? payload.recurrenceWeeks as 8 | 12 | null : null
  };
}

function serviceHeaders(serviceRoleKey: string, extra: Record<string, string> = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function consumeRateLimit(
  supabaseUrl: string,
  serviceRoleKey: string,
  req: Request,
  bookingId: string,
  tokenHash: string,
  action: ManageAction
) {
  const clientIp = String(
    req.headers.get('cf-connecting-ip')
      || req.headers.get('x-real-ip')
      || req.headers.get('x-forwarded-for')?.split(',')[0]
      || 'unknown'
  ).trim().slice(0, 80);
  const bucket = action === 'details' ? 'read' : 'change';
  const limits = [
    {
      scope: 'ip',
      rawKey: clientIp,
      maxAttempts: 30,
      windowSeconds: 600
    },
    {
      scope: bucket,
      rawKey: `${clientIp}:${bookingId}:${tokenHash}`,
      maxAttempts: action === 'details' ? 60 : 12,
      windowSeconds: action === 'details' ? 600 : 900
    }
  ];

  for (const limit of limits) {
    const keyHash = await sha256Hex(
      `${serviceRoleKey}:manage-booking:v2:${limit.scope}:${limit.rawKey}`
    );
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_booking_rate_limit`, {
      method: 'POST',
      headers: serviceHeaders(serviceRoleKey),
      body: JSON.stringify({
        p_key_hash: keyHash,
        p_max_attempts: limit.maxAttempts,
        p_window_seconds: limit.windowSeconds
      })
    });

    if (!response.ok) {
      console.error('manage-booking rate limit check failed', { status: response.status });
      throw new Error('RATE_LIMIT_UNAVAILABLE');
    }
    if ((await response.json()) !== true) return false;
  }

  return true;
}

const BOOKING_COLUMNS = [
  'id',
  'customer_name',
  'email',
  'phone',
  'address',
  'postal_code',
  'housing_type',
  'window_count',
  'service_scope',
  'addons',
  'transport_type',
  'sea_miles',
  'coordinates',
  'booking_date',
  'booking_time',
  'price',
  'status',
  'rut_choice',
  'recurrence_weeks',
  'email_confirmation_expires_at',
  'email_confirmed_at',
  'customer_confirmation_email_sent_at',
  'cancelled_at',
  'rescheduled_at',
  'completed_at',
  'created_at'
].join(',');

async function fetchVerifiedBooking(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  tokenHash: string
): Promise<BookingRow | null> {
  const query = new URLSearchParams({
    select: BOOKING_COLUMNS,
    id: `eq.${bookingId}`,
    management_token_hash: `eq.${tokenHash}`,
    management_token_expires_at: `gt.${new Date().toISOString()}`,
    limit: '1'
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/bookings?${query.toString()}`, {
    headers: serviceHeaders(serviceRoleKey)
  });

  if (!response.ok) {
    console.error('manage-booking verified lookup failed', { status: response.status });
    throw new Error('BOOKING_LOOKUP_FAILED');
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] as BookingRow || null : null;
}

function limitedText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maxLength);
}

function parseWindowCounts(addons: unknown) {
  const text = limitedText(addons, 300);
  const regular = text.match(/(\d{1,3})\s+utan spröjs/i);
  const muntins = text.match(/(\d{1,3})\s+med spröjs/i);
  return {
    regularWindowCount: regular ? Math.min(Number(regular[1]), 999) : 0,
    muntinsCount: muntins ? Math.min(Number(muntins[1]), 999) : 0
  };
}

function timestampSequence(values: Array<string | null | undefined>) {
  const latest = values.reduce((maximum, value) => {
    const milliseconds = value ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(milliseconds) ? Math.max(maximum, milliseconds) : maximum;
  }, 0);
  return Math.min(2_147_483_647, Math.max(0, Math.floor(latest / 1000)));
}

function publicBooking(row: BookingRow) {
  const status = ['awaiting_confirmation', 'pending', 'confirmed', 'completed', 'cancelled', 'expired']
    .includes(String(row.status || ''))
    ? String(row.status)
    : 'pending';
  const confirmationExpiry = new Date(String(row.email_confirmation_expires_at || '')).getTime();
  const recurrenceWeeks = row.recurrence_weeks === 8 || row.recurrence_weeks === 12
    ? row.recurrence_weeks
    : null;
  const counts = parseWindowCounts(row.addons);

  return {
    id: limitedText(row.id, 80),
    customerName: limitedText(row.customer_name, 120),
    email: limitedText(row.email, 254),
    phone: limitedText(row.phone, 40),
    address: limitedText(row.address, 300),
    postalCode: limitedText(row.postal_code, 10),
    housingType: limitedText(row.housing_type, 80),
    windowCount: limitedText(row.window_count, 80),
    regularWindowCount: counts.regularWindowCount,
    muntinsCount: counts.muntinsCount,
    serviceScope: limitedText(row.service_scope, 100),
    addons: limitedText(row.addons, 300),
    transportType: limitedText(row.transport_type, 80),
    seaMiles: limitedText(row.sea_miles, 30),
    coordinates: limitedText(row.coordinates, 120),
    bookingDate: limitedText(row.booking_date, 10),
    bookingTime: limitedText(row.booking_time, 5),
    price: limitedText(row.price, 40),
    status,
    rutChoice: limitedText(row.rut_choice, 120),
    recurrenceWeeks,
    confirmationExpiresAt: status === 'awaiting_confirmation'
      ? limitedText(row.email_confirmation_expires_at, 40)
      : null,
    confirmationReceiptSent: Boolean(row.customer_confirmation_email_sent_at),
    calendarSequence: timestampSequence([
      row.email_confirmed_at,
      row.rescheduled_at,
      row.cancelled_at,
      row.completed_at
    ]),
    capabilities: {
      canConfirm: (status === 'awaiting_confirmation'
        && Number.isFinite(confirmationExpiry)
        && confirmationExpiry > Date.now())
        || (['pending', 'confirmed'].includes(status)
          && Boolean(row.email_confirmed_at)
          && !row.customer_confirmation_email_sent_at),
      canReschedule: status === 'pending' || status === 'confirmed',
      canCancel: ['awaiting_confirmation', 'pending', 'confirmed'].includes(status),
      canSetRecurrence: ['pending', 'confirmed', 'completed'].includes(status),
      canDownloadCalendar: ['pending', 'confirmed', 'completed', 'cancelled'].includes(status),
      canRebook: true
    }
  };
}

async function callManagementRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  tokenHash: string,
  action: Exclude<ManageAction, 'details'>,
  newDate: string | null,
  newTime: string | null,
  recurrenceWeeks: 8 | 12 | null
): Promise<RpcResult> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/manage_customer_booking`, {
    method: 'POST',
    headers: serviceHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_booking_id: bookingId,
      p_token_hash: tokenHash,
      p_action: action,
      p_new_date: newDate,
      p_new_time: newTime,
      p_recurrence_weeks: recurrenceWeeks
    })
  });

  if (!response.ok) {
    console.error('manage-booking action RPC failed', { status: response.status });
    throw new Error('MANAGEMENT_RPC_FAILED');
  }
  const result = await response.json();
  return (Array.isArray(result) ? result[0] : result) as RpcResult;
}

function rpcErrorResponse(result: RpcResult) {
  const code = String(result.code || 'invalid_request');
  const errors: Record<string, { status: number; message: string }> = {
    invalid_request: { status: 400, message: 'Begäran innehåller ogiltiga uppgifter.' },
    invalid_date: { status: 400, message: 'Välj ett giltigt datum och en giltig tid.' },
    invalid_recurrence: { status: 400, message: 'Välj 8 veckor, 12 veckor eller stoppa återkommande putsning.' },
    invalid_or_expired: { status: 403, message: 'Länken är ogiltig eller har gått ut.' },
    confirmation_expired: { status: 410, message: 'Tiden för att bekräfta bokningen har gått ut.' },
    date_unavailable: { status: 409, message: 'Datumet är inte längre ledigt. Välj ett annat datum.' },
    not_changeable: { status: 409, message: 'Bokningen kan inte ändras i sitt nuvarande läge.' }
  };
  const error = errors[code] || errors.invalid_request;
  return jsonResponse({ ok: false, code, error: error.message }, error.status);
}

async function patchBooking(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  body: Record<string, unknown>
) {
  const query = new URLSearchParams({ id: `eq.${bookingId}` });
  const response = await fetch(`${supabaseUrl}/rest/v1/bookings?${query.toString()}`, {
    method: 'PATCH',
    headers: serviceHeaders(serviceRoleKey, { Prefer: 'return=minimal' }),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    console.error('manage-booking update failed', { status: response.status });
  }
  return response.ok;
}

async function callBooleanRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: 'issue_rut_form_token_hash' | 'finish_rut_form_token_email',
  body: Record<string, unknown>
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: serviceHeaders(serviceRoleKey),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    console.error('manage-booking RUT link RPC failed', {
      functionName,
      status: response.status
    });
    return false;
  }
  return (await response.json().catch(() => false)) === true;
}

function escapeHtml(value: unknown) {
  return limitedText(value, 1_000)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isValidEmail(value: unknown) {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatDate(value: unknown) {
  const dateValue = limitedText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue || 'Ej angivet';
  const parsed = new Date(`${dateValue}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(parsed);
}

function formatPrice(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${Math.round(amount).toLocaleString('sv-SE')} kr`
    : limitedText(value, 40) || 'Ej angivet';
}

function buildFragmentUrl(siteUrl: string, page: string, bookingId: string, token: string) {
  const fragment = new URLSearchParams({ bookingId, token });
  return `${siteUrl}/${page}#${fragment.toString()}`;
}

function toIcsUtcStamp(value: unknown) {
  const date = new Date(String(value || ''));
  const safeDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
  return safeDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsEscape(value: unknown) {
  return limitedText(value, 500)
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

function foldIcsLine(line: string) {
  const encoder = new TextEncoder();
  const folded: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of line) {
    const characterBytes = encoder.encode(character).byteLength;
    const limit = folded.length ? 74 : 75;
    if (current && currentBytes + characterBytes > limit) {
      folded.push(folded.length ? ` ${current}` : current);
      current = character;
      currentBytes = characterBytes;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  folded.push(folded.length ? ` ${current}` : current);
  return folded.join('\r\n');
}

function createCalendar(row: BookingRow, kind: 'confirmed' | 'rescheduled' | 'cancelled', contactEmail: string) {
  const date = limitedText(row.booking_date, 10);
  const time = limitedText(row.booking_time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !BOOKABLE_TIMES.has(time)) return '';

  const compactDate = date.replaceAll('-', '');
  const hour = Number(time.slice(0, 2));
  const startTime = `${String(hour).padStart(2, '0')}0000`;
  const endTime = `${String(hour + 1).padStart(2, '0')}0000`;
  const cancelled = kind === 'cancelled';
  const eventTimestamp = kind === 'cancelled'
    ? row.cancelled_at
    : kind === 'rescheduled' ? row.rescheduled_at : row.email_confirmed_at;
  const sequence = timestampSequence([eventTimestamp]);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Berga Fönsterputs//Bokning//SV',
    `METHOD:${cancelled ? 'CANCEL' : 'REQUEST'}`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:booking-${limitedText(row.id, 80)}@bergafonsterputs.se`,
    `DTSTAMP:${toIcsUtcStamp(row.created_at)}`,
    `SEQUENCE:${sequence}`,
    `DTSTART;TZID=Europe/Stockholm:${compactDate}T${startTime}`,
    `DTEND;TZID=Europe/Stockholm:${compactDate}T${endTime}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${icsEscape('Fönsterputs – Berga Fönsterputs')}`,
    `LOCATION:${icsEscape(row.address)}`,
    `DESCRIPTION:${icsEscape(`Boknings-ID: ${limitedText(row.id, 80)}. Kontakt: ${contactEmail}`)}`,
    `ORGANIZER;CN=Berga Fönsterputs:mailto:${contactEmail}`,
    ...(isValidEmail(row.email)
      ? [`ATTENDEE;CN=${icsEscape(row.customer_name)};RSVP=FALSE:mailto:${limitedText(row.email, 254)}`]
      : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bookingDetailRows(row: BookingRow) {
  const rows = [
    ['Datum', formatDate(row.booking_date)],
    ['Tid', limitedText(row.booking_time, 5)],
    ['Adress', limitedText(row.address, 300)],
    ['Tjänst', limitedText(row.service_scope, 100)],
    ['Fönster', limitedText(row.window_count, 80)],
    ['Pris', formatPrice(row.price)]
  ];
  return rows.map(([label, value]) => `
    <tr>
      <td style="padding:9px 0;color:#607281;border-bottom:1px solid #e5edf2;">${escapeHtml(label)}</td>
      <td style="padding:9px 0;color:#102d3e;font-weight:700;text-align:right;border-bottom:1px solid #e5edf2;">${escapeHtml(value)}</td>
    </tr>`).join('');
}

function customerEmailHtml(
  title: string,
  intro: string,
  row: BookingRow,
  manageUrl: string,
  rutUrl: string | null
) {
  const rutSection = rutUrl ? `
    <div style="margin:22px 0;padding:18px;background:#edf8f1;border:1px solid #cce8d6;border-radius:14px;">
      <h2 style="margin:0 0 8px;font-size:18px;color:#175d35;">Säkert RUT-formulär</h2>
      <p style="margin:0 0 14px;color:#36584a;line-height:1.6;">Fyll i personnumret via den säkra länken. Uppgiften skickas inte i e-post.</p>
      <a href="${escapeHtml(rutUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#237a45;color:#fff;text-decoration:none;font-weight:800;">FYLL I RUT-UPPGIFTER</a>
    </div>` : '';

  return `
    <div style="margin:0;padding:28px 12px;background:#f2f6f8;font-family:Arial,Helvetica,sans-serif;color:#102d3e;">
      <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 12px 34px rgba(15,38,56,.10);">
        <div style="padding:24px;background:#102d3e;color:#fff;text-align:center;">
          <div style="font-size:20px;font-weight:800;">Berga Fönsterputs</div>
        </div>
        <div style="padding:30px;">
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;color:#102d3e;">${escapeHtml(title)}</h1>
          <p style="margin:0 0 20px;color:#526674;line-height:1.7;">Hej ${escapeHtml(row.customer_name)}, ${escapeHtml(intro)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;">${bookingDetailRows(row)}</table>
          ${rutSection}
          <div style="margin-top:22px;padding:18px;background:#fff8ec;border:1px solid #f2d298;border-radius:14px;">
            <strong>Betalning efter utfört arbete</strong>
            <p style="margin:7px 0 0;color:#665332;line-height:1.6;">När jobbet är klart får du ett separat klartmejl med belopp, Swish-nummer och referens.</p>
          </div>
          <p style="margin:24px 0 14px;color:#526674;line-height:1.6;">Du kan använda den säkra bokningssidan för att se status, boka om eller avboka.</p>
          <a href="${escapeHtml(manageUrl)}" style="display:inline-block;padding:13px 20px;border-radius:999px;background:#f2a33a;color:#102d3e;text-decoration:none;font-weight:800;">HANTERA BOKNINGEN</a>
          <p style="margin:24px 0 0;color:#73828d;font-size:12px;line-height:1.6;">Kalenderfilen är bifogad. Svara på mejlet om du behöver hjälp.</p>
        </div>
      </div>
    </div>`;
}

function customerEmailText(
  title: string,
  intro: string,
  row: BookingRow,
  manageUrl: string,
  rutUrl: string | null
) {
  return [
    title,
    '',
    `Hej ${limitedText(row.customer_name, 120)}, ${intro}`,
    '',
    `Datum: ${formatDate(row.booking_date)}`,
    `Tid: ${limitedText(row.booking_time, 5)}`,
    `Adress: ${limitedText(row.address, 300)}`,
    `Pris: ${formatPrice(row.price)}`,
    '',
    ...(rutUrl ? ['Säkert RUT-formulär:', rutUrl, ''] : []),
    'Hantera bokningen:',
    manageUrl,
    '',
    'Efter utfört arbete får du ett separat klartmejl med belopp, Swish-nummer och referens.',
    '',
    'Berga Fönsterputs'
  ].join('\n');
}

async function sendEmail(
  config: EmailConfig,
  payload: Record<string, unknown>,
  idempotencyKey: string
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(payload)
      });
      if (response.ok) return true;
      if (response.status !== 429 && response.status < 500) {
        console.error('manage-booking email rejected', { status: response.status });
        return false;
      }
      if (attempt === 1) {
        console.error('manage-booking email unavailable', { status: response.status });
      }
    } catch {
      if (attempt === 1) console.error('manage-booking email request failed');
    }
  }
  return false;
}

async function eventKey(scope: string, row: BookingRow, before: BookingRow | null = null) {
  const fingerprint = [
    scope,
    limitedText(row.id, 80),
    limitedText(before?.booking_date, 10),
    limitedText(before?.booking_time, 5),
    limitedText(row.booking_date, 10),
    limitedText(row.booking_time, 5),
    limitedText(row.status, 30)
  ].join('|');
  return `manage-${scope}-${(await sha256Hex(fingerprint)).slice(0, 48)}`;
}

function getEmailConfig(): EmailConfig | null {
  const apiKey = Deno.env.get('RESEND_API_KEY') || '';
  const from = Deno.env.get('BOOKING_FROM_EMAIL') || '';
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    contactEmail: Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se',
    notificationEmail: Deno.env.get('BOOKING_NOTIFICATION_EMAIL') || 'bokning@bergafonsterputs.se',
    siteUrl: (Deno.env.get('PUBLIC_SITE_URL') || ALLOWED_ORIGIN).replace(/\/+$/, '')
  };
}

async function sendCustomerChangeEmail(
  config: EmailConfig,
  action: 'confirm' | 'reschedule' | 'cancel',
  row: BookingRow,
  before: BookingRow,
  managementToken: string,
  rutToken: string | null
) {
  if (!isValidEmail(row.email)) return false;

  const content = action === 'confirm'
    ? {
        title: 'Din bokning är bekräftad',
        intro: 'din tid är nu reserverad.',
        subject: `Bokningen är bekräftad – ${limitedText(row.booking_date, 10)}`,
        calendarKind: 'confirmed' as const
      }
    : action === 'reschedule'
      ? {
          title: 'Din bokning har bokats om',
          intro: 'vi har uppdaterat datum och tid enligt ditt val.',
          subject: `Bokningen är ombokad – ${limitedText(row.booking_date, 10)}`,
          calendarKind: 'rescheduled' as const
        }
      : {
          title: 'Din bokning är avbokad',
          intro: 'bokningen är nu avbokad.',
          subject: `Bokningen är avbokad – ${limitedText(row.booking_date, 10)}`,
          calendarKind: 'cancelled' as const
        };
  const manageUrl = buildFragmentUrl(config.siteUrl, 'hantera-bokning.html', limitedText(row.id, 80), managementToken);
  const rutUrl = rutToken
    ? buildFragmentUrl(config.siteUrl, 'rut.html', limitedText(row.id, 80), rutToken)
    : null;
  const calendar = createCalendar(row, content.calendarKind, config.contactEmail);
  const key = await eventKey(`${action}-customer`, row, before);

  return await sendEmail(config, {
    from: config.from,
    to: [limitedText(row.email, 254)],
    reply_to: config.contactEmail,
    subject: content.subject,
    html: customerEmailHtml(content.title, content.intro, row, manageUrl, rutUrl),
    text: customerEmailText(content.title, content.intro, row, manageUrl, rutUrl),
    ...(calendar ? {
      attachments: [{
        filename: `berga-fonsterputs-${limitedText(row.id, 80)}.ics`,
        content: utf8Base64(calendar),
        content_type: 'text/calendar; charset=utf-8'
      }]
    } : {})
  }, key);
}

async function sendAdminConfirmationEmail(config: EmailConfig, row: BookingRow, before: BookingRow) {
  const key = await eventKey('confirm-admin', row, before);
  return await sendEmail(config, {
    from: config.from,
    to: [config.notificationEmail],
    reply_to: isValidEmail(row.email) ? limitedText(row.email, 254) : config.contactEmail,
    subject: `Bekräftad bokning ${limitedText(row.booking_date, 10)} ${limitedText(row.booking_time, 5)}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#102d3e;line-height:1.6;">
        <h1 style="font-size:22px;">Bokningen är bekräftad</h1>
        <p><strong>Boknings-ID:</strong> ${escapeHtml(row.id)}</p>
        <p><strong>Kund:</strong> ${escapeHtml(row.customer_name)}<br>
        <strong>Datum:</strong> ${escapeHtml(row.booking_date)} ${escapeHtml(row.booking_time)}<br>
        <strong>Adress:</strong> ${escapeHtml(row.address)}</p>
      </div>`,
    text: [
      'Bokningen är bekräftad',
      `Boknings-ID: ${limitedText(row.id, 80)}`,
      `Kund: ${limitedText(row.customer_name, 120)}`,
      `Datum: ${limitedText(row.booking_date, 10)} ${limitedText(row.booking_time, 5)}`,
      `Adress: ${limitedText(row.address, 300)}`
    ].join('\n')
  }, key);
}

Deno.serve(async (req) => {
  if (!originIsAllowed(req)) {
    return jsonResponse({ ok: false, error: 'Origin not allowed' }, 403);
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: securityHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    let rawPayload: ManagePayload;
    try {
      rawPayload = await readJsonWithLimit(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return jsonResponse({ ok: false, error: 'För stor begäran.' }, 413);
      }
      if (error instanceof InvalidJsonError) {
        return jsonResponse({ ok: false, error: 'Begäran innehåller inte giltig JSON.' }, 400);
      }
      throw error;
    }

    const payload = parseAndValidatePayload(rawPayload);
    if (!payload) {
      return jsonResponse({ ok: false, error: 'Bokningslänken eller begäran är ogiltig.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('manage-booking Supabase configuration is missing');
      return jsonResponse({ ok: false, error: 'Tjänsten är tillfälligt otillgänglig.' }, 500);
    }

    const tokenHash = await sha256Hex(payload.token);
    let rateLimitAllowed = false;
    try {
      rateLimitAllowed = await consumeRateLimit(
        supabaseUrl,
        serviceRoleKey,
        req,
        payload.bookingId,
        tokenHash,
        payload.action
      );
    } catch {
      return jsonResponse({ ok: false, error: 'Bokningsskyddet kunde inte kontrolleras. Försök igen.' }, 503);
    }
    if (!rateLimitAllowed) {
      return jsonResponse({ ok: false, error: 'För många försök. Vänta en stund och försök igen.' }, 429);
    }

    const before = await fetchVerifiedBooking(
      supabaseUrl,
      serviceRoleKey,
      payload.bookingId,
      tokenHash
    );
    if (!before) {
      return jsonResponse({ ok: false, error: 'Bokningslänken är ogiltig eller har gått ut.' }, 403);
    }

    if (payload.action === 'details') {
      return jsonResponse({ ok: true, booking: publicBooking(before) });
    }

    if (payload.action === 'reschedule'
      && limitedText(before.booking_date, 10) === payload.newDate
      && limitedText(before.booking_time, 5) === payload.newTime) {
      return jsonResponse({
        ok: true,
        alreadyDone: true,
        status: limitedText(before.status, 30),
        booking: publicBooking(before)
      });
    }

    if (payload.action === 'set_recurrence') {
      const currentRecurrence = before.recurrence_weeks === 8 || before.recurrence_weeks === 12
        ? before.recurrence_weeks
        : null;
      if (currentRecurrence === payload.recurrenceWeeks) {
        return jsonResponse({
          ok: true,
          alreadyDone: true,
          status: limitedText(before.status, 30),
          booking: publicBooking(before)
        });
      }
    }

    const rpcResult = await callManagementRpc(
      supabaseUrl,
      serviceRoleKey,
      payload.bookingId,
      tokenHash,
      payload.action,
      payload.newDate,
      payload.newTime,
      payload.recurrenceWeeks
    );
    if (rpcResult?.ok !== true) return rpcErrorResponse(rpcResult || {});

    const after = await fetchVerifiedBooking(
      supabaseUrl,
      serviceRoleKey,
      payload.bookingId,
      tokenHash
    );
    if (!after) {
      return jsonResponse({ ok: false, error: 'Bokningen uppdaterades men kunde inte läsas in på nytt.' }, 500);
    }

    const notification: {
      customerEmailSent?: boolean;
      adminEmailSent?: boolean;
      rutLinkPrepared?: boolean;
    } = {};
    const firstMutation = rpcResult.already_done !== true;
    const shouldSendChangeEmail = firstMutation
      || (payload.action === 'confirm' && !before.customer_confirmation_email_sent_at);

    if (shouldSendChangeEmail && ['confirm', 'reschedule', 'cancel'].includes(payload.action)) {
      const emailConfig = getEmailConfig();
      let rutToken: string | null = null;
      let rutTokenHash: string | null = null;

      if (!emailConfig) {
        console.error('manage-booking email configuration is missing');
        notification.customerEmailSent = false;
        if (payload.action === 'confirm') notification.adminEmailSent = false;
      } else {
        if (payload.action === 'confirm' && limitedText(after.rut_choice, 120) === RUT_YES) {
          const candidate = await sha256Hex(`berga-rut-link:v1:${payload.bookingId}:${payload.token}`);
          const candidateHash = await sha256Hex(candidate);
          const issued = await callBooleanRpc(
            supabaseUrl,
            serviceRoleKey,
            'issue_rut_form_token_hash',
            {
              p_booking_id: payload.bookingId,
              p_token_hash: candidateHash
            }
          );
          notification.rutLinkPrepared = issued;
          if (issued) {
            rutToken = candidate;
            rutTokenHash = candidateHash;
          }
        }

        notification.customerEmailSent = await sendCustomerChangeEmail(
          emailConfig,
          payload.action as 'confirm' | 'reschedule' | 'cancel',
          after,
          before,
          payload.token,
          rutToken
        );

        if (payload.action === 'confirm') {
          notification.adminEmailSent = await sendAdminConfirmationEmail(emailConfig, after, before);
          if (rutTokenHash) {
            const rutDeliveryFinalized = await callBooleanRpc(
              supabaseUrl,
              serviceRoleKey,
              'finish_rut_form_token_email',
              {
                p_booking_id: payload.bookingId,
                p_token_hash: rutTokenHash,
                p_delivered: notification.customerEmailSent === true
              }
            );
            notification.rutLinkPrepared = rutDeliveryFinalized
              && notification.customerEmailSent === true;
          }
          if (notification.customerEmailSent) {
            const sentAt = new Date().toISOString();
            const confirmationSaved = await patchBooking(supabaseUrl, serviceRoleKey, payload.bookingId, {
              customer_confirmation_email_sent_at: sentAt
            });
            if (confirmationSaved) {
              after.customer_confirmation_email_sent_at = sentAt;
            }
          }
        }
      }
    }

    return jsonResponse({
      ok: true,
      alreadyDone: rpcResult.already_done === true,
      status: limitedText(rpcResult.status || after.status, 30),
      booking: publicBooking(after),
      ...(Object.keys(notification).length ? { notification } : {})
    });
  } catch {
    console.error('Unhandled manage-booking error');
    return jsonResponse({ ok: false, error: 'Bokningen kunde inte hanteras just nu. Försök igen.' }, 500);
  }
});
