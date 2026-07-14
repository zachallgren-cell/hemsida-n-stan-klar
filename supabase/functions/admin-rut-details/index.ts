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

type AdminAction = 'get' | 'resend_link' | 'confirm' | 'mark_completed' | 'mark_paid' | 'mark_processed' | 'approve' | 'reject' | 'purge';

type AdminPayload = {
  action?: AdminAction;
  bookingId?: string | number | null;
};

type BookingAdminState = {
  id: string | number;
  completed_at?: string | null;
  payment_status?: string | null;
  customer_name?: string | null;
  email?: string | null;
  rut_choice?: string | null;
  rut_application_status?: string | null;
};

type RutSubmission = {
  booking_id: string;
  personal_number_ciphertext: string;
  personal_number_iv: string;
  encryption_version: number;
  submitted_at: string;
  expires_at: string;
  processed_at?: string | null;
};

type AdminCheckResult =
  | { ok: true; userId: string; booking: BookingAdminState }
  | { ok: false; response: Response };

const textEncoder = new TextEncoder();
let decryptionKeyPromise: Promise<CryptoKey> | null = null;

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

function isRutBooking(value: unknown) {
  return /^ja\b/i.test(String(value || '').trim());
}

function isValidEmail(value: unknown) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getJwtAssuranceLevel(authHeader: string) {
  try {
    const token = authHeader.replace(/^bearer\s+/i, '');
    const payloadPart = token.split('.')[1] || '';
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return String(payload?.aal || 'aal1');
  } catch {
    return 'invalid';
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
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

  const hexBytes = hexToBytes(secret.replace(/^hex:/i, ''));
  if (hexBytes) return hexBytes;

  const hasBase64Prefix = /^base64:/i.test(secret);
  const base64Bytes = tryDecodeBase64(secret.replace(/^base64:/i, ''));
  if (base64Bytes?.length === 32) return base64Bytes;

  if (hasBase64Prefix) {
    throw new Error('RUT_ENCRYPTION_KEY med base64:-prefix måste avkodas till exakt 32 byte.');
  }

  throw new Error('RUT_ENCRYPTION_KEY måste vara 64 hextecken eller base64: följt av exakt 32 slumpmässiga byte.');
}

function getDecryptionKey() {
  if (!decryptionKeyPromise) {
    decryptionKeyPromise = (async () => {
      const keyBytes = await parseEncryptionKey(Deno.env.get('RUT_ENCRYPTION_KEY') || '');
      return await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
    })();
  }

  return decryptionKeyPromise;
}

async function decryptPersonalNumber(submission: RutSubmission, bookingId: string) {
  if (submission.encryption_version !== 1) {
    throw new Error('Unsupported RUT encryption version');
  }

  const ciphertext = tryDecodeBase64(submission.personal_number_ciphertext);
  const iv = tryDecodeBase64(submission.personal_number_iv);
  if (!ciphertext || !iv || iv.length !== 12) {
    throw new Error('Invalid encrypted RUT data');
  }

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(`rut-submission:v1:${bookingId}`),
      tagLength: 128
    },
    await getDecryptionKey(),
    ciphertext
  );
  const personalNumber = new TextDecoder().decode(decrypted);

  if (!/^\d{12}$/.test(personalNumber)) {
    throw new Error('Invalid decrypted RUT data');
  }

  return personalNumber;
}

async function requireBookingAdmin(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string
): Promise<AdminCheckResult> {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, response: jsonResponse({ error: 'Admininloggning krävs.' }, 401) };
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader
    }
  });

  if (!userResponse.ok) {
    return { ok: false, response: jsonResponse({ error: 'Adminsessionen kunde inte verifieras.' }, 401) };
  }

  const user = await userResponse.json();
  const userId = String(user?.id || '');
  if (!userId) {
    return { ok: false, response: jsonResponse({ error: 'Adminsessionen saknar användar-ID.' }, 401) };
  }

  // The Auth server has just validated the token above, so its signed AAL
  // claim can now be used for the explicit API-level MFA gate. RLS below also
  // requires a currently verified factor, protecting against a stale JWT.
  if (getJwtAssuranceLevel(authHeader) !== 'aal2') {
    return {
      ok: false,
      response: jsonResponse({ error: 'Tvåstegsverifiering krävs för adminåtgärden.', code: 'mfa_required' }, 403)
    };
  }

  // The authenticated user's JWT is deliberately used for this query. The
  // bookings RLS policy invokes private.is_booking_admin(), which is the
  // project's authoritative admin allowlist.
  const publicApiKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey;
  const bookingResponse = await fetch(
    `${supabaseUrl}/rest/v1/bookings?select=id,completed_at,payment_status,customer_name,email,rut_choice,rut_application_status&id=eq.${encodeURIComponent(bookingId)}&limit=1`,
    {
      headers: {
        apikey: publicApiKey,
        Authorization: authHeader,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!bookingResponse.ok) {
    console.error('admin-rut-details could not verify booking admin', { status: bookingResponse.status });
    return { ok: false, response: jsonResponse({ error: 'Adminbehörigheten kunde inte verifieras.' }, 403) };
  }

  const rows = await bookingResponse.json();
  const booking = Array.isArray(rows) ? rows[0] as BookingAdminState | undefined : undefined;
  if (!booking) {
    return { ok: false, response: jsonResponse({ error: 'Adminbehörighet krävs.' }, 403) };
  }

  return { ok: true, userId, booking };
}

async function fetchSubmission(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string
): Promise<RutSubmission | null> {
  const columns = [
    'booking_id',
    'personal_number_ciphertext',
    'personal_number_iv',
    'encryption_version',
    'submitted_at',
    'expires_at',
    'processed_at'
  ].join(',');
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rut_submissions?select=${encodeURIComponent(columns)}&booking_id=eq.${encodeURIComponent(bookingId)}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    console.error('admin-rut-details could not read submission', { status: response.status });
    throw new Error('Could not read RUT submission');
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function writeAuditLog(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  userId: string,
  action: 'viewed' | 'link_issued'
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rut_submission_access_log`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      booking_id: bookingId,
      admin_user_id: userId,
      action
    })
  });

  if (!response.ok) {
    console.error('admin-rut-details could not write audit log', { status: response.status });
    throw new Error('Could not write mandatory RUT audit log');
  }
}

async function callRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: string,
  parameters: Record<string, unknown>
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(parameters)
  });

  if (!response.ok) {
    console.error('admin-rut-details RPC failed', {
      functionName,
      status: response.status
    });
    throw new Error('Could not complete atomic RUT operation');
  }

  return await response.json().catch(() => null);
}

function getManagementError(code: unknown) {
  const messages: Record<string, string> = {
    not_allowed: 'Adminbehörigheten kunde inte verifieras.',
    booking_not_found: 'Bokningen finns inte.',
    not_rut_booking: 'Bokningen är inte registrerad för RUT-avdrag.',
    work_pending: 'Markera arbetet som slutfört innan Swishbetalningen registreras.',
    work_or_payment_pending: 'Arbetet måste vara slutfört och Swishbetalningen verifierad innan RUT markeras som ansökt.',
    submission_not_found: 'Inget RUT-underlag finns för bokningen.',
    not_ready: 'RUT-underlaget är inte redo att markeras som ansökt.',
    not_submitted: 'RUT måste markeras som ansökt innan beslut registreras.'
  };
  return messages[String(code || '')] || 'RUT-åtgärden kunde inte genomföras.';
}

async function manageRutSubmission(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  userId: string,
  action: Exclude<AdminAction, 'get' | 'resend_link'>
) {
  const rpcName = action === 'mark_completed'
    ? 'admin_mark_booking_completed'
    : action === 'confirm'
      ? 'admin_confirm_booking'
      : 'admin_manage_rut_submission';
  const parameters = action === 'mark_completed' || action === 'confirm'
    ? {
        p_booking_id: bookingId,
        p_admin_user_id: userId
      }
    : {
        p_booking_id: bookingId,
        p_admin_user_id: userId,
        p_action: action
      };

  const result = await callRpc(
    supabaseUrl,
    serviceRoleKey,
    rpcName,
    parameters
  );

  if (!result || result.ok !== true) {
    return { ok: false as const, code: result?.code || 'unknown' };
  }

  return { ok: true as const, result };
}

async function finishRutLink(
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string,
  tokenHash: string,
  delivered: boolean
) {
  return await callRpc(
    supabaseUrl,
    serviceRoleKey,
    'finish_rut_form_token_email',
    {
      p_booking_id: bookingId,
      p_token_hash: tokenHash,
      p_delivered: delivered
    }
  );
}

async function sendReplacementRutLink(
  booking: BookingAdminState,
  bookingId: string,
  token: string,
  tokenHash: string
) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL') || Deno.env.get('FROM_EMAIL');
  const siteUrl = (
    Deno.env.get('PUBLIC_SITE_URL')
    || Deno.env.get('SITE_URL')
    || 'https://bergafonsterputs.se'
  ).replace(/\/+$/, '');
  const configuredRutFormUrl = Deno.env.get('BOOKING_RUT_FORM_URL')
    || Deno.env.get('RUT_FORM_URL')
    || `${siteUrl}/rut.html`;

  if (!resendApiKey || !fromEmail) {
    throw new Error('Email secrets are missing for replacement RUT link');
  }

  const rutUrl = new URL(configuredRutFormUrl);
  rutUrl.search = '';
  rutUrl.hash = new URLSearchParams({ bookingId, token }).toString();
  const safeRutUrl = escapeHtml(rutUrl.toString());
  const safeName = escapeHtml(booking.customer_name || '');
  const textName = String(booking.customer_name || '').trim();
  const greeting = textName ? `Hej ${textName},` : 'Hej,';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `rut-link-${bookingId}-${tokenHash.slice(0, 16)}`
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [String(booking.email || '').trim()],
      subject: 'Ny säker länk för ditt RUT-underlag',
      html: `
        <div style="margin:0;padding:32px 16px;background:#f3f6f8;font-family:Arial,Helvetica,sans-serif;color:#0f2638;">
          <div style="max-width:640px;margin:0 auto;padding:28px;background:#ffffff;border-radius:18px;">
            <h1 style="margin:0 0 14px;font-size:26px;">Ny säker RUT-länk</h1>
            <p style="line-height:1.7;">${safeName ? `Hej ${safeName},` : 'Hej,'}</p>
            <p style="line-height:1.7;">Här är en ny engångslänk för att lämna personnumret till din bokning hos Berga Fönsterputs. Personnumret skickas inte med e-post.</p>
            <p style="margin:24px 0;text-align:center;"><a href="${safeRutUrl}" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#247a43;color:#ffffff;font-weight:700;text-decoration:none;">Öppna säkert RUT-formulär</a></p>
            <p style="line-height:1.7;color:#536574;">Länken kan användas en gång och gäller i 30 dagar. Om du inte har begärt en ny länk kan du bortse från mejlet.</p>
          </div>
        </div>
      `,
      text: `${greeting}\n\nHär är en ny engångslänk för att lämna personnumret till din bokning hos Berga Fönsterputs. Personnumret skickas inte med e-post.\n\n${rutUrl.toString()}\n\nLänken kan användas en gång och gäller i 30 dagar.`
    })
  });

  if (!response.ok) {
    console.error('admin-rut-details could not send replacement RUT link', { status: response.status });
    throw new Error('Kunde inte skicka den nya RUT-länken.');
  }
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

    let payload: AdminPayload;
    try {
      payload = await readJsonWithLimit<AdminPayload>(req, 4096);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: 'För stor begäran.' }, 413);
      }
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      }
      throw error;
    }
    const action = payload.action || 'get';
    const bookingId = String(payload.bookingId || '').trim();

    if (!['get', 'resend_link', 'confirm', 'mark_completed', 'mark_paid', 'mark_processed', 'approve', 'reject', 'purge'].includes(action)) {
      return jsonResponse({ error: 'Ogiltig åtgärd.' }, 400);
    }

    if (!isValidBookingId(bookingId)) {
      return jsonResponse({ error: 'Ogiltigt boknings-ID.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing for admin-rut-details');
      return jsonResponse({ error: 'Serverkonfiguration saknas.' }, 500);
    }

    const adminCheck = await requireBookingAdmin(req, supabaseUrl, serviceRoleKey, bookingId);
    if (!adminCheck.ok) return adminCheck.response;

    if (action === 'resend_link') {
      if (!isRutBooking(adminCheck.booking.rut_choice)) {
        return jsonResponse({ error: 'Bokningen är inte registrerad för RUT-avdrag.' }, 409);
      }

      if (['submitted', 'approved'].includes(String(adminCheck.booking.rut_application_status || '').toLowerCase())) {
        return jsonResponse({ error: 'RUT-ärendet är redan ansökt eller godkänt. En ny länk får inte skickas.' }, 409);
      }

      if (!isValidEmail(adminCheck.booking.email)) {
        return jsonResponse({ error: 'Kundens e-postadress är ogiltig.' }, 409);
      }

      if (await fetchSubmission(supabaseUrl, serviceRoleKey, bookingId)) {
        return jsonResponse({ error: 'RUT-underlaget är redan mottaget. Ingen ny länk behövs.' }, 409);
      }

      const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash = await sha256Hex(token);
      const issued = await callRpc(
        supabaseUrl,
        serviceRoleKey,
        'issue_rut_form_token_hash',
        {
          p_booking_id: bookingId,
          p_token_hash: tokenHash
        }
      );

      if (issued !== true) {
        return jsonResponse({ error: 'En ny RUT-länk kunde inte utfärdas för bokningen.' }, 409);
      }

      try {
        await writeAuditLog(supabaseUrl, serviceRoleKey, bookingId, adminCheck.userId, 'link_issued');
        await sendReplacementRutLink(adminCheck.booking, bookingId, token, tokenHash);
        const delivered = await finishRutLink(supabaseUrl, serviceRoleKey, bookingId, tokenHash, true);
        if (delivered !== true) throw new Error('Could not finalize replacement RUT email');
      } catch (error) {
        await finishRutLink(supabaseUrl, serviceRoleKey, bookingId, tokenHash, false).catch(() => null);
        throw error;
      }

      return jsonResponse({ success: true, bookingId, sent: true });
    }

    if (action !== 'get') {
      const managed = await manageRutSubmission(
        supabaseUrl,
        serviceRoleKey,
        bookingId,
        adminCheck.userId,
        action
      );

      if (!managed.ok) {
        const status = managed.code === 'booking_not_found' || managed.code === 'submission_not_found'
          ? 404
          : managed.code === 'not_allowed' ? 403 : 409;
        return jsonResponse({ error: getManagementError(managed.code) }, status);
      }

      return jsonResponse({ success: true, bookingId, ...managed.result });
    }

    if (!isRutBooking(adminCheck.booking.rut_choice)) {
      return jsonResponse({ error: 'Bokningen är inte registrerad för RUT-avdrag.' }, 409);
    }

    // The number is not needed during planning. It can only be revealed once
    // the work has actually been marked complete; payment is still allowed to
    // follow afterwards because the number may be needed on the manual invoice.
    if (!adminCheck.booking.completed_at) {
      return jsonResponse({ error: 'Markera arbetet som slutfört innan personnumret öppnas.' }, 409);
    }

    const submission = await fetchSubmission(supabaseUrl, serviceRoleKey, bookingId);
    if (!submission) {
      return jsonResponse({ error: 'Inget RUT-underlag finns för bokningen.' }, 404);
    }

    const expiryTime = new Date(submission.expires_at).getTime();
    if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
      await manageRutSubmission(
        supabaseUrl,
        serviceRoleKey,
        bookingId,
        adminCheck.userId,
        'purge'
      );
      return jsonResponse({ error: 'RUT-underlaget har gallrats eftersom lagringstiden gått ut.' }, 410);
    }

    const personalNumber = await decryptPersonalNumber(submission, bookingId);
    const formattedPersonalNumber = `${personalNumber.slice(0, 8)}-${personalNumber.slice(8)}`;
    const maskedPersonalNumber = `********-${personalNumber.slice(-4)}`;
    await writeAuditLog(supabaseUrl, serviceRoleKey, bookingId, adminCheck.userId, 'viewed');

    return jsonResponse({
      success: true,
      bookingId,
      socialSecurityNumber: formattedPersonalNumber,
      maskedPersonalNumber,
      submittedAt: submission.submitted_at,
      expiresAt: submission.expires_at,
      processedAt: submission.processed_at || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    console.error('Unhandled admin-rut-details error', { message: message || 'unknown error' });

    if (/RUT_ENCRYPTION_KEY/.test(message)) {
      return jsonResponse({ error: 'Säker RUT-lagring är inte konfigurerad.' }, 503);
    }

    if (/Kunde inte skicka den nya RUT-länken/.test(message)) {
      return jsonResponse({ error: message }, 502);
    }

    return jsonResponse({ error: 'RUT-underlaget kunde inte hanteras just nu.' }, 500);
  }
});
