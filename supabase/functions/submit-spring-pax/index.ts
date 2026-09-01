import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const PRODUCTION_ORIGINS = new Set([
  'https://bergafonsterputs.se',
  'https://www.bergafonsterputs.se'
]);
const MAX_BODY_BYTES = 12 * 1024;
const MIN_FORM_AGE_MS = 1_500;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1_000;
const PERIODS = new Set(['march', 'april', 'may', 'flexible']);
const SERVICES = new Set(['exterior', 'interior_exterior', 'unsure']);

type PaxPayload = {
  requestId?: string;
  formStartedAt?: string;
  website?: string;
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  requestedPeriod?: string;
  serviceInterest?: string;
  message?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  attributionRef?: string;
  landingPage?: string;
};

class RequestValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function isAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

function responseHeaders(req: Request) {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };

  if (isAllowedOrigin(req)) {
    headers['Access-Control-Allow-Origin'] = req.headers.get('origin') || '';
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return headers;
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders(req),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function assertText(value: string, label: string, min: number, max: number, allowNewlines = false) {
  const controlCharacters = allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    : /[\u0000-\u001F\u007F]/;
  if (value.length < min || value.length > max || controlCharacters.test(value)) {
    throw new RequestValidationError(`${label} måste innehålla ${min}–${max} tecken.`);
  }
}

function isValidEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string) {
  const normalized = value.replace(/[\s().-]/g, '');
  return value.length <= 30 && /^\+?\d{7,15}$/.test(normalized);
}

function assertFormGuards(payload: PaxPayload) {
  if (cleanText(payload.website)) {
    throw new RequestValidationError('Paxningen kunde inte skickas.');
  }
  const requestId = cleanText(payload.requestId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new RequestValidationError('Formulärets begäran är ogiltig. Ladda om sidan och försök igen.');
  }
  const startedAt = cleanText(payload.formStartedAt);
  if (!/^\d{13}$/.test(startedAt)) {
    throw new RequestValidationError('Formulärets tidskontroll saknas. Ladda om sidan och försök igen.');
  }
  const age = Date.now() - Number(startedAt);
  if (!Number.isFinite(age) || age < MIN_FORM_AGE_MS) {
    throw new RequestValidationError('Kontrollera uppgifterna och försök igen om ett ögonblick.');
  }
  if (age > MAX_FORM_AGE_MS) {
    throw new RequestValidationError('Formuläret har varit öppet för länge. Ladda om sidan och försök igen.');
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeAttribution(value: unknown) {
  const normalized = cleanText(value).slice(0, 160);
  return normalized && /^[A-Za-z0-9ÅÄÖåäö._~:/?&=%+\-]{1,160}$/u.test(normalized)
    ? normalized
    : null;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function consumeRateLimit(
  supabaseUrl: string,
  serviceRoleKey: string,
  namespace: string,
  rawKey: string,
  maxAttempts: number
) {
  const keyHash = await sha256Hex(`${serviceRoleKey}:spring-2027:${namespace}:${rawKey}`);
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_booking_rate_limit`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_key_hash: keyHash,
      p_max_attempts: maxAttempts,
      p_window_seconds: 3600
    })
  });
  if (!response.ok) throw new Error('RATE_LIMIT_UNAVAILABLE');
  return (await response.json()) === true;
}

async function sendEmail(
  apiKey: string,
  idempotencyKey: string,
  payload: Record<string, unknown>
) {
  return await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) return new Response(null, { status: 403, headers: responseHeaders(req) });
    return new Response(null, { status: 204, headers: responseHeaders(req) });
  }
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);
  if (!isAllowedOrigin(req)) return jsonResponse(req, { error: 'Origin is not allowed' }, 403);
  if (!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) {
    return jsonResponse(req, { error: 'Förfrågan måste skickas som JSON.' }, 415);
  }

  try {
    const payload = await readJsonWithLimit<PaxPayload>(req, MAX_BODY_BYTES);
    assertFormGuards(payload);

    const requestId = cleanText(payload.requestId);
    const name = cleanText(payload.name);
    const email = cleanText(payload.email).toLowerCase();
    const phone = cleanText(payload.phone);
    const normalizedPhone = phone.replace(/[^\d+]/g, '');
    const location = cleanText(payload.location);
    const requestedPeriod = cleanText(payload.requestedPeriod) || 'flexible';
    const serviceInterest = cleanText(payload.serviceInterest) || 'unsure';
    const message = cleanText(payload.message);

    assertText(name, 'Namnet', 2, 100);
    assertText(location, 'Ort eller postnummer', 2, 120);
    if (!isValidEmail(email)) throw new RequestValidationError('Ange en giltig e-postadress.');
    if (!isValidPhone(phone)) throw new RequestValidationError('Ange ett giltigt telefonnummer.');
    if (!PERIODS.has(requestedPeriod)) throw new RequestValidationError('Välj en giltig önskad period.');
    if (!SERVICES.has(serviceInterest)) throw new RequestValidationError('Välj en giltig tjänst.');
    if (message) assertText(message, 'Meddelandet', 1, 1500, true);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Spring reservation storage configuration is missing');
      return jsonResponse(req, { error: 'Paxningen är inte tillgänglig just nu. Försök igen senare.' }, 503);
    }

    const clientIp = cleanText(
      req.headers.get('cf-connecting-ip')
        || req.headers.get('x-real-ip')
        || req.headers.get('x-forwarded-for')?.split(',')[0]
        || 'unknown'
    ).slice(0, 80);

    let rateLimits: boolean[];
    try {
      rateLimits = await Promise.all([
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'ip', clientIp, 8),
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'email', email, 4),
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'phone', normalizedPhone, 4)
      ]);
    } catch {
      return jsonResponse(req, { error: 'Paxningsskyddet kunde inte kontrolleras. Försök igen om en stund.' }, 503);
    }
    if (rateLimits.some((allowed) => !allowed)) {
      return jsonResponse(req, { error: 'För många paxningar på kort tid. Vänta en stund eller kontakta oss.' }, 429);
    }

    const record = {
      request_id: requestId,
      name,
      email,
      phone,
      location,
      requested_period: requestedPeriod,
      service_interest: serviceInterest,
      message: message || null,
      utm_source: normalizeAttribution(payload.utmSource),
      utm_medium: normalizeAttribution(payload.utmMedium),
      utm_campaign: normalizeAttribution(payload.utmCampaign),
      utm_content: normalizeAttribution(payload.utmContent),
      utm_term: normalizeAttribution(payload.utmTerm),
      attribution_ref: payload.attributionRef === 'referral' ? 'referral' : null,
      landing_page: normalizeAttribution(payload.landingPage)
    };

    const insertResponse = await fetch(
      `${supabaseUrl}/rest/v1/spring_2027_reservations?on_conflict=request_id&select=id`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=representation'
        },
        body: JSON.stringify(record)
      }
    );
    if (!insertResponse.ok) {
      console.error('Spring reservation insert failed', { status: insertResponse.status });
      return jsonResponse(req, { error: 'Paxningen kunde inte sparas just nu. Försök igen senare.' }, 502);
    }

    const insertedRows = await insertResponse.json().catch(() => []);
    if (!Array.isArray(insertedRows) || insertedRows.length === 0) {
      return jsonResponse(req, { success: true, duplicate: true, receiptSent: false });
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    if (!resendApiKey || !fromEmail || !notificationEmail) {
      console.error('Spring reservation email configuration is incomplete');
      return jsonResponse(req, { success: true, receiptSent: false });
    }

    const periodLabels: Record<string, string> = {
      march: 'Mars', april: 'April', may: 'Maj', flexible: 'Flexibel'
    };
    const serviceLabels: Record<string, string> = {
      exterior: 'Utvändigt',
      interior_exterior: 'In- och utvändigt',
      unsure: 'Osäker'
    };
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone);
    const safeLocation = escapeHtml(location);
    const safeMessage = message ? escapeHtml(message).replaceAll('\n', '<br>') : 'Inget meddelande';

    let notificationSent = false;
    try {
      const notificationResponse = await sendEmail(
        resendApiKey,
        `spring-2027-admin-${requestId}`,
        {
          from: fromEmail,
          to: [notificationEmail],
          reply_to: email,
          subject: `Ny vårpaxning 2027 – ${location}`,
          html: `<div style="font-family:Arial,sans-serif;color:#173042;line-height:1.65"><h1 style="font-size:24px">Ny vårpaxning 2027</h1><table style="border-collapse:collapse"><tr><td style="padding:6px 18px 6px 0;font-weight:700">Namn</td><td>${safeName}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700">E-post</td><td>${safeEmail}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700">Telefon</td><td>${safePhone}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700">Ort/postnummer</td><td>${safeLocation}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700">Period</td><td>${periodLabels[requestedPeriod]}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700">Tjänst</td><td>${serviceLabels[serviceInterest]}</td></tr><tr><td style="padding:6px 18px 6px 0;font-weight:700;vertical-align:top">Meddelande</td><td>${safeMessage}</td></tr></table><p style="color:#5f7280">Paxningen är kostnadsfri och inte bindande.</p></div>`
        }
      );
      notificationSent = notificationResponse.ok;
      if (!notificationSent) console.error('Spring reservation notification failed', notificationResponse.status);
    } catch {
      console.error('Spring reservation notification request failed');
    }

    let receiptSent = false;
    try {
      const receiptResponse = await sendEmail(
        resendApiKey,
        `spring-2027-receipt-${requestId}`,
        {
          from: fromEmail,
          to: [email],
          reply_to: contactEmail,
          subject: 'Din plats till våren 2027 är paxad',
          html: `<div style="font-family:Arial,sans-serif;color:#173042;line-height:1.7"><h1 style="font-size:26px">Din plats är paxad!</h1><p>Hej ${safeName},</p><p>Tack! Du står nu på vår prioriteringslista inför våren 2027. Vi kontaktar dig innan de vanliga tiderna släpps så att du får möjlighet att välja ett passande datum.</p><p><strong>Paxningen är inte bindande.</strong> Bokningen blir giltig först när datum och pris har bekräftats.</p><p style="margin-top:24px">Berga Fönsterputs<br><a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></p></div>`
        }
      );
      receiptSent = receiptResponse.ok;
      if (!receiptSent) console.error('Spring reservation receipt failed', receiptResponse.status);
    } catch {
      console.error('Spring reservation receipt request failed');
    }

    return jsonResponse(req, { success: true, receiptSent, notificationSent });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse(req, { error: 'Förfrågan är för stor.' }, 413);
    }
    if (error instanceof InvalidJsonBodyError) {
      return jsonResponse(req, { error: 'Formulärdata kunde inte läsas.' }, 400);
    }
    if (error instanceof RequestValidationError) {
      return jsonResponse(req, { error: error.message }, error.status);
    }
    console.error('Unhandled spring reservation error', error);
    return jsonResponse(req, { error: 'Paxningen kunde inte hanteras just nu. Försök igen.' }, 500);
  }
});
