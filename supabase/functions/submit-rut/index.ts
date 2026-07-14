import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://bergafonsterputs.se',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin'
};

const noStoreHeaders = {
  ...corsHeaders,
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff'
};

type RutPayload = {
  bookingId?: string | number | null;
  token?: string | null;
  socialSecurityNumber?: string | null;
  consentAccepted?: boolean;
  formStartedAt?: string;
  website?: string;
};

type BookingTokenState = {
  id: string | number;
  rut_choice?: string | null;
  rut_form_token_hash?: string | null;
  rut_form_token_expires_at?: string | null;
  rut_form_token_used_at?: string | null;
};

const textEncoder = new TextEncoder();
let encryptionKeyPromise: Promise<CryptoKey> | null = null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...noStoreHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function isValidBookingId(value: string) {
  return /^[a-z0-9_-]{1,80}$/i.test(value);
}

function isValidToken(value: string) {
  return /^[a-z0-9_-]{32,128}$/i.test(value);
}

function isSuspiciouslyFastSubmission(startedAt: string | undefined) {
  const startedTime = Number(startedAt || 0);
  return Number.isFinite(startedTime) && startedTime > 0 && Date.now() - startedTime < 1500;
}

function normalizePersonalNumber(value: string) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 10) return digits;

  const currentYear = new Date().getUTCFullYear();
  const shortYear = Number(digits.slice(0, 2));
  let fullYear = 2000 + shortYear;

  if (fullYear > currentYear) {
    fullYear -= 100;
  }

  return `${fullYear}${digits}`;
}

function hasValidLuhn(value: string) {
  const tenDigits = value.slice(-10);
  if (!/^\d{10}$/.test(tenDigits)) return false;

  let sum = 0;
  for (let index = 0; index < tenDigits.length; index += 1) {
    let digit = Number(tenDigits[index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  return sum % 10 === 0;
}

function isValidCalendarDate(value: string) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getTime() <= Date.now();
}

function isValidPersonalNumber(value: string) {
  return /^\d{12}$/.test(value)
    && isValidCalendarDate(value)
    && hasValidLuhn(value);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function tryDecodeBase64(value: string) {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function parseEncryptionKey(rawSecret: string) {
  const secret = rawSecret.trim();
  if (!secret) {
    throw new Error('RUT_ENCRYPTION_KEY saknas.');
  }

  const withoutHexPrefix = secret.replace(/^hex:/i, '');
  const hexBytes = hexToBytes(withoutHexPrefix);
  if (hexBytes) return hexBytes;

  const hasBase64Prefix = /^base64:/i.test(secret);
  const base64Candidate = secret.replace(/^base64:/i, '');
  const base64Bytes = tryDecodeBase64(base64Candidate);
  if (base64Bytes?.length === 32) return base64Bytes;

  if (hasBase64Prefix) {
    throw new Error('RUT_ENCRYPTION_KEY med base64:-prefix måste avkodas till exakt 32 byte.');
  }

  throw new Error('RUT_ENCRYPTION_KEY måste vara 64 hextecken eller base64: följt av exakt 32 slumpmässiga byte.');
}

function getEncryptionKey() {
  if (!encryptionKeyPromise) {
    encryptionKeyPromise = (async () => {
      const keyBytes = await parseEncryptionKey(Deno.env.get('RUT_ENCRYPTION_KEY') || '');
      return await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );
    })();
  }

  return encryptionKeyPromise;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function encryptPersonalNumber(personalNumber: string, bookingId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(`rut-submission:v1:${bookingId}`),
      tagLength: 128
    },
    await getEncryptionKey(),
    textEncoder.encode(personalNumber)
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv)
  };
}

async function fetchBookingTokenState(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string
): Promise<BookingTokenState | null> {
  const columns = [
    'id',
    'rut_choice',
    'rut_form_token_hash',
    'rut_form_token_expires_at',
    'rut_form_token_used_at'
  ].join(',');
  const response = await fetch(
    `${supabaseUrl}/rest/v1/bookings?select=${encodeURIComponent(columns)}&id=eq.${encodeURIComponent(bookingId)}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    console.error('submit-rut could not read token state', { status: response.status });
    throw new Error('RUT-länken kunde inte verifieras.');
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function storeEncryptedSubmission(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: {
    bookingId: string;
    tokenHash: string;
    ciphertext: string;
    iv: string;
  }
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/store_encrypted_rut_submission`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_booking_id: input.bookingId,
      p_token_hash: input.tokenHash,
      p_ciphertext: input.ciphertext,
      p_iv: input.iv
    })
  });

  if (!response.ok) {
    console.error('submit-rut could not store encrypted submission', { status: response.status });
    throw new Error('RUT-underlaget kunde inte sparas.');
  }

  return (await response.json().catch(() => false)) === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: noStoreHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(contentLength) && contentLength > 16_384) {
      return jsonResponse({ error: 'För stor begäran.' }, 413);
    }

    let payload: RutPayload;
    try {
      payload = await readJsonWithLimit<RutPayload>(req, 16_384);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: 'För stor begäran.' }, 413);
      }
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      }
      throw error;
    }

    if (payload.website) {
      return jsonResponse({ error: 'Formuläret innehåller ett ogiltigt extrafält. Ladda om sidan och försök igen.' }, 400);
    }

    if (isSuspiciouslyFastSubmission(payload.formStartedAt)) {
      return jsonResponse({ error: 'Vänta ett ögonblick och försök skicka igen.' }, 429);
    }

    if (payload.consentAccepted !== true) {
      return jsonResponse({ error: 'Du behöver godkänna personuppgiftshanteringen.' }, 400);
    }

    const bookingId = String(payload.bookingId || '').trim();
    const token = String(payload.token || '').trim();
    const personalNumber = normalizePersonalNumber(String(payload.socialSecurityNumber || ''));

    if (!isValidBookingId(bookingId) || !isValidToken(token)) {
      return jsonResponse({ error: 'RUT-länken är ogiltig eller saknas.' }, 403);
    }

    if (!isValidPersonalNumber(personalNumber)) {
      return jsonResponse({ error: 'Ange ett giltigt personnummer.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing for submit-rut');
      return jsonResponse({ error: 'Serverkonfiguration saknas.' }, 500);
    }

    const tokenHash = await sha256Hex(token);
    const booking = await fetchBookingTokenState(supabaseUrl, serviceRoleKey, bookingId);
    const storedHash = String(booking?.rut_form_token_hash || '');
    const expiryTime = new Date(String(booking?.rut_form_token_expires_at || '')).getTime();

    if (!booking
      || !storedHash
      || !timingSafeEqual(tokenHash, storedHash)
      || booking.rut_form_token_used_at
      || !Number.isFinite(expiryTime)
      || expiryTime <= Date.now()) {
      return jsonResponse({ error: 'RUT-länken är ogiltig, förbrukad eller har gått ut. Kontakta oss för en ny länk.' }, 403);
    }

    if (!/^ja\b/i.test(String(booking.rut_choice || '').trim())) {
      return jsonResponse({ error: 'Den här bokningen är inte registrerad för RUT-avdrag.' }, 409);
    }

    const encrypted = await encryptPersonalNumber(personalNumber, bookingId);
    const stored = await storeEncryptedSubmission(supabaseUrl, serviceRoleKey, {
      bookingId,
      tokenHash,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv
    });

    if (!stored) {
      return jsonResponse({ error: 'RUT-länken har redan använts eller gått ut. Kontakta oss för hjälp.' }, 409);
    }

    return jsonResponse({
      success: true,
      received: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error('Unhandled submit-rut error', { message: message || 'unknown error' });

    if (/RUT_ENCRYPTION_KEY/.test(message)) {
      return jsonResponse({ error: 'Säker lagring är inte konfigurerad ännu. Kontakta oss så hjälper vi dig.' }, 503);
    }

    return jsonResponse({ error: 'RUT-underlaget kunde inte tas emot just nu. Försök igen senare.' }, 500);
  }
});
