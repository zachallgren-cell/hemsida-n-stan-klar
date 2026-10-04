import { validateApplication } from '../../../job-application-shared.mjs';
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
type JobPayload = { requestId?: string; formStartedAt?: string; website?: string; [key: string]: unknown };

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

function assertFormGuards(payload: JobPayload) {
  if (cleanText(payload.website)) {
    throw new RequestValidationError('Ansökan kunde inte skickas.');
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
  const keyHash = await sha256Hex(`${serviceRoleKey}:job-application:${namespace}:${rawKey}`);
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
    const payload = await readJsonWithLimit<JobPayload>(req, MAX_BODY_BYTES);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RequestValidationError('Formulärdata kunde inte läsas.');
    assertFormGuards(payload);

    const requestId = cleanText(payload.requestId);
    let answers;
    try { answers = validateApplication(payload); }
    catch (error) { throw new RequestValidationError(error instanceof Error ? error.message : 'Kontrollera dina svar.'); }
    const email = answers.email;
    const normalizedPhone = answers.phone.replace(/[^\d+]/g, '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Job application storage configuration is missing');
      return jsonResponse(req, { error: 'Ansökan är inte tillgänglig just nu. Försök igen senare.' }, 503);
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
      return jsonResponse(req, { error: 'Formulärskyddet kunde inte kontrolleras. Försök igen om en stund.' }, 503);
    }
    if (rateLimits.some((allowed) => !allowed)) {
      return jsonResponse(req, { error: 'För många ansökningar på kort tid. Vänta en stund eller kontakta oss.' }, 429);
    }

    const record = { request_id: requestId, answers };

    const insertResponse = await fetch(
      `${supabaseUrl}/rest/v1/job_applications?on_conflict=request_id&select=id`,
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
      console.error('Job application insert failed', { status: insertResponse.status });
      return jsonResponse(req, { error: 'Ansökan kunde inte sparas just nu. Försök igen senare.' }, 502);
    }

    const insertedRows = await insertResponse.json();
    let applicationId = insertedRows?.[0]?.id;
    // Keep the same request ID across retries after an uncertain network result.
    if (!applicationId) {
      const existing = await fetch(`${supabaseUrl}/rest/v1/job_applications?request_id=eq.${encodeURIComponent(requestId)}&select=id`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      });
      if (!existing.ok) throw new Error('Receipt lookup failed');
      applicationId = (await existing.json())?.[0]?.id;
    }
    if (!applicationId) throw new Error('Missing receipt');
    return jsonResponse(req, { success: true, applicationId });
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
    console.error('Unhandled job application error', error);
    return jsonResponse(req, { error: 'Ansökan kunde inte hanteras just nu. Försök igen.' }, 500);
  }
});
