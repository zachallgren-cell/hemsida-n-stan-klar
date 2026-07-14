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

type DetailsPayload = {
  bookingId?: string | number | null;
  token?: string | null;
};

type BookingTokenState = {
  id: string | number;
  rut_choice?: string | null;
  rut_form_token_hash?: string | null;
  rut_form_token_expires_at?: string | null;
  rut_form_token_used_at?: string | null;
};

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

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
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
    console.error('rut-booking-details could not read token state', { status: response.status });
    throw new Error('Could not verify RUT token');
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
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
    if (Number.isFinite(contentLength) && contentLength > 4096) {
      return jsonResponse({ error: 'För stor begäran.' }, 413);
    }

    const payload = (await req.json()) as DetailsPayload;
    const bookingId = String(payload.bookingId || '').trim();
    const token = String(payload.token || '').trim();

    if (!isValidBookingId(bookingId) || !isValidToken(token)) {
      return jsonResponse({ error: 'RUT-länken är ogiltig eller saknas.' }, 403);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing for rut-booking-details');
      return jsonResponse({ error: 'Serverkonfiguration saknas.' }, 500);
    }

    const [booking, tokenHash] = await Promise.all([
      fetchBookingTokenState(supabaseUrl, serviceRoleKey, bookingId),
      sha256Hex(token)
    ]);
    const storedHash = String(booking?.rut_form_token_hash || '');
    const expiryTime = new Date(String(booking?.rut_form_token_expires_at || '')).getTime();

    if (!booking
      || !storedHash
      || !timingSafeEqual(tokenHash, storedHash)
      || booking.rut_form_token_used_at
      || !Number.isFinite(expiryTime)
      || expiryTime <= Date.now()) {
      return jsonResponse({ error: 'RUT-länken är ogiltig, förbrukad eller har gått ut.' }, 403);
    }

    if (!/^ja\b/i.test(String(booking.rut_choice || '').trim())) {
      return jsonResponse({ error: 'Den här bokningen är inte registrerad för RUT-avdrag.' }, 409);
    }

    return jsonResponse({
      success: true,
      bookingId: String(booking.id),
      ready: true
    });
  } catch {
    console.error('Unhandled rut-booking-details error');
    return jsonResponse({ error: 'RUT-länken kunde inte verifieras just nu.' }, 500);
  }
});
