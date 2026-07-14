const ALLOWED_ORIGIN = 'https://bergafonsterputs.se';
const MAX_PHOTO_COUNT = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_PHOTO_BYTES = MAX_PHOTO_COUNT * MAX_PHOTO_BYTES;
const MAX_MULTIPART_BYTES = MAX_TOTAL_PHOTO_BYTES + (128 * 1024);
const MIN_FORM_AGE_MS = 3_000;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1_000;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

type EmailAttachment = {
  filename: string;
  content: string;
};

class RequestValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function isAllowedOrigin(req: Request) {
  return req.headers.get('origin') === ALLOWED_ORIGIN;
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
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getTextField(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function hasDisallowedControlCharacters(value: string, allowNewlines = false) {
  const pattern = allowNewlines
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    : /[\u0000-\u001F\u007F]/;
  return pattern.test(value);
}

function assertTextField(
  value: string,
  label: string,
  minLength: number,
  maxLength: number,
  allowNewlines = false
) {
  if (
    value.length < minLength
    || value.length > maxLength
    || hasDisallowedControlCharacters(value, allowNewlines)
  ) {
    throw new RequestValidationError(
      `${label} måste innehålla ${minLength}–${maxLength} tecken.`
    );
  }
}

function isValidEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string) {
  if (value.length > 30 || hasDisallowedControlCharacters(value)) return false;
  const normalized = value.replace(/[\s().-]/g, '');
  return /^\+?\d{7,15}$/.test(normalized);
}

function formatPostalCode(value: string) {
  const normalized = value.replace(/\s/g, '');
  if (!/^\d{5}$/.test(normalized)) {
    throw new RequestValidationError('Postnumret måste bestå av fem siffror.');
  }
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}

function assertFormTiming(formStartedAtValue: string) {
  if (!/^\d{13}$/.test(formStartedAtValue)) {
    throw new RequestValidationError('Formulärets tidskontroll saknas. Ladda om sidan och försök igen.');
  }

  const formStartedAt = Number(formStartedAtValue);
  const age = Date.now() - formStartedAt;

  if (!Number.isFinite(age) || age < MIN_FORM_AGE_MS) {
    throw new RequestValidationError('Formuläret skickades för snabbt. Kontrollera uppgifterna och försök igen.');
  }

  if (age > MAX_FORM_AGE_MS) {
    throw new RequestValidationError('Formuläret har varit öppet för länge. Ladda om sidan och försök igen.');
  }
}

function assertRequestId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RequestValidationError('Formulärets begäran är ogiltig. Ladda om sidan och försök igen.');
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
  const keyHash = await sha256Hex(`${serviceRoleKey}:photo-quote:${namespace}:${rawKey}`);
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

  if (!response.ok) {
    console.error('Photo quote rate limit check failed', { status: response.status });
    throw new Error('RATE_LIMIT_UNAVAILABLE');
  }

  return (await response.json()) === true;
}

async function readBodyWithLimit(req: Request, maxBytes: number) {
  const contentLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestValidationError('Förfrågan är för stor. Välj färre eller mindre bilder.', 413);
  }

  if (!req.body) {
    throw new RequestValidationError('Formulärdata saknas.');
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestValidationError('Förfrågan är för stor. Välj färre eller mindre bilder.', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function detectImageMimeType(bytes: Uint8Array) {
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

function bytesToBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

async function validatePhoto(file: File, index: number): Promise<EmailAttachment> {
  if (!file.name && file.size === 0) {
    throw new RequestValidationError('En av bildfilerna är tom.');
  }

  if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
    throw new RequestValidationError(
      `Bild ${index + 1} måste vara större än 0 byte och högst 5 MB.`
    );
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new RequestValidationError(
      `Bild ${index + 1} måste vara JPEG, PNG eller WebP.`
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedMimeType = detectImageMimeType(bytes);
  if (!detectedMimeType || detectedMimeType !== file.type) {
    throw new RequestValidationError(
      `Bild ${index + 1} har ett filinnehåll som inte stämmer med filtypen.`
    );
  }

  return {
    filename: `fonster-${index + 1}.${extensionForMimeType(detectedMimeType)}`,
    content: bytesToBase64(bytes)
  };
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
    if (!isAllowedOrigin(req)) {
      return new Response(null, { status: 403, headers: responseHeaders(req) });
    }
    return new Response(null, { status: 204, headers: responseHeaders(req) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  if (!isAllowedOrigin(req)) {
    return jsonResponse(req, { error: 'Origin is not allowed' }, 403);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Photo quote rate limit configuration is missing');
      return jsonResponse(req, { error: 'Offerttjänsten är inte tillgänglig just nu.' }, 503);
    }

    const clientIp = String(
      req.headers.get('cf-connecting-ip')
        || req.headers.get('x-real-ip')
        || req.headers.get('x-forwarded-for')?.split(',')[0]
        || 'unknown'
    ).trim().slice(0, 80);

    let ipAllowed = false;
    try {
      ipAllowed = await consumeRateLimit(supabaseUrl, serviceRoleKey, 'ip', clientIp, 4);
    } catch {
      return jsonResponse(req, { error: 'Offertskyddet kunde inte kontrolleras. Försök igen om en stund.' }, 503);
    }
    if (!ipAllowed) {
      return jsonResponse(req, { error: 'För många offertförfrågningar på kort tid. Vänta en stund eller mejla oss.' }, 429);
    }

    const contentType = req.headers.get('content-type') || '';
    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
      throw new RequestValidationError('Formuläret måste skickas som multipart/form-data.');
    }

    const rawBody = await readBodyWithLimit(req, MAX_MULTIPART_BYTES);
    let formData: FormData;
    try {
      const parsingRequest = new Request(req.url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: rawBody
      });
      formData = await parsingRequest.formData();
    } catch {
      throw new RequestValidationError('Formulärdata kunde inte läsas.');
    }

    const honeypot = getTextField(formData, 'website');
    if (honeypot) {
      throw new RequestValidationError('Förfrågan kunde inte skickas.', 400);
    }

    assertFormTiming(getTextField(formData, 'formStartedAt'));
    const requestId = getTextField(formData, 'requestId');
    assertRequestId(requestId);

    const name = getTextField(formData, 'name');
    const email = getTextField(formData, 'email').toLowerCase();
    const phone = getTextField(formData, 'phone');
    const address = getTextField(formData, 'address');
    const postalCode = formatPostalCode(getTextField(formData, 'postalCode'));
    const description = getTextField(formData, 'description');
    const consent = getTextField(formData, 'consent');

    assertTextField(name, 'Namnet', 2, 100);
    assertTextField(address, 'Adressen', 5, 240);
    assertTextField(description, 'Beskrivningen', 10, 2_500, true);

    if (!isValidEmail(email)) {
      throw new RequestValidationError('Ange en giltig e-postadress.');
    }
    if (!isValidPhone(phone)) {
      throw new RequestValidationError('Ange ett giltigt telefonnummer.');
    }
    if (consent !== 'accepted') {
      throw new RequestValidationError('Du behöver godkänna integritetsinformationen och offertvillkoren.');
    }

    let emailAllowed = false;
    try {
      emailAllowed = await consumeRateLimit(supabaseUrl, serviceRoleKey, 'email', email, 3);
    } catch {
      return jsonResponse(req, { error: 'Offertskyddet kunde inte kontrolleras. Försök igen om en stund.' }, 503);
    }
    if (!emailAllowed) {
      return jsonResponse(req, { error: 'För många offertförfrågningar för den här e-postadressen. Vänta en stund.' }, 429);
    }

    const photoEntries = formData.getAll('photos');
    if (photoEntries.some((entry) => !(entry instanceof File))) {
      throw new RequestValidationError('Bildfältet innehåller ogiltig data.');
    }

    const photos = (photoEntries as File[]).filter((file) => Boolean(file.name) || file.size > 0);
    if (photos.length > MAX_PHOTO_COUNT) {
      throw new RequestValidationError('Du kan bifoga högst tre bilder.');
    }

    const totalPhotoBytes = photos.reduce((total, file) => total + file.size, 0);
    if (totalPhotoBytes > MAX_TOTAL_PHOTO_BYTES) {
      throw new RequestValidationError('Bilderna får tillsammans vara högst 15 MB.', 413);
    }

    const attachments = await Promise.all(photos.map(validatePhoto));

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';

    if (!resendApiKey || !fromEmail || !notificationEmail) {
      console.error('Photo quote email configuration is incomplete');
      return jsonResponse(req, { error: 'Offerttjänsten är inte tillgänglig just nu.' }, 500);
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone);
    const safeAddress = escapeHtml(address);
    const safePostalCode = escapeHtml(postalCode);
    const safeDescription = escapeHtml(description).replaceAll('\n', '<br>');
    const photoLabel = attachments.length === 1
      ? '1 bifogad bild'
      : `${attachments.length} bifogade bilder`;

    const notificationHtml = `
      <div style="font-family:Arial,sans-serif;color:#173042;line-height:1.6;">
        <h1 style="font-size:24px;margin:0 0 18px;">Ny offertförfrågan</h1>
        <table style="width:100%;max-width:720px;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:700;">Namn</td><td style="padding:8px 0;">${safeName}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">E-post</td><td style="padding:8px 0;">${safeEmail}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Telefon</td><td style="padding:8px 0;">${safePhone}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Adress</td><td style="padding:8px 0;">${safeAddress}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Postnummer</td><td style="padding:8px 0;">${safePostalCode}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;vertical-align:top;">Beskrivning</td><td style="padding:8px 0;">${safeDescription}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Bilder</td><td style="padding:8px 0;">${photoLabel}</td></tr>
        </table>
        <p style="margin:18px 0 0;color:#5f7280;font-size:13px;">Bilderna är bilagor i detta mejl och har inte lagrats permanent av offertformuläret.</p>
      </div>
    `;

    const notificationText = [
      'Ny offertförfrågan',
      `Namn: ${name}`,
      `E-post: ${email}`,
      `Telefon: ${phone}`,
      `Adress: ${address}`,
      `Postnummer: ${postalCode}`,
      `Beskrivning: ${description}`,
      `Bilder: ${photoLabel}`,
      '',
      'Bilderna är mejlbilagor och har inte lagrats permanent av offertformuläret.'
    ].join('\n');

    const notificationRes = await sendEmail(
      resendApiKey,
      `photo-quote-notification-${requestId}`,
      {
        from: fromEmail,
        to: [notificationEmail],
        subject: `Ny offertförfrågan – ${postalCode}`,
        html: notificationHtml,
        text: notificationText,
        reply_to: email,
        ...(attachments.length ? { attachments } : {})
      }
    );

    if (!notificationRes.ok) {
      console.error('Photo quote notification email failed', notificationRes.status);
      return jsonResponse(req, { error: 'Offertförfrågan kunde inte skickas just nu. Försök igen senare.' }, 502);
    }

    const receiptHtml = `
      <div style="font-family:Arial,sans-serif;color:#173042;line-height:1.7;">
        <h1 style="font-size:24px;margin:0 0 14px;">Vi har tagit emot din offertförfrågan</h1>
        <p>Hej ${safeName},</p>
        <p>Tack! Vi har fått din beskrivning och ${photoLabel}. Vi går igenom underlaget och återkommer via e-post eller telefon.</p>
        <p>Detta är en offertförfrågan och ingen bokad tid. Pris och omfattning bekräftas innan något arbete planeras.</p>
        <p style="margin-top:22px;">Berga Fönsterputs<br><a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></p>
      </div>
    `;

    const receiptRes = await sendEmail(
      resendApiKey,
      `photo-quote-receipt-${requestId}`,
      {
        from: fromEmail,
        to: [email],
        subject: 'Vi har tagit emot din offertförfrågan',
        html: receiptHtml,
        text: [
          `Hej ${name},`,
          '',
          `Vi har fått din beskrivning och ${photoLabel}. Vi återkommer via e-post eller telefon.`,
          'Detta är en offertförfrågan och ingen bokad tid. Pris och omfattning bekräftas innan något arbete planeras.',
          '',
          'Berga Fönsterputs',
          contactEmail
        ].join('\n'),
        reply_to: contactEmail
      }
    );

    const receiptSent = receiptRes.ok;
    if (!receiptSent) {
      console.error('Photo quote receipt email failed', receiptRes.status);
    }

    return jsonResponse(req, {
      success: true,
      receiptSent,
      photoCount: attachments.length
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return jsonResponse(req, { error: error.message }, error.status);
    }

    console.error('Unhandled photo quote error', error instanceof Error ? error.name : 'unknown');
    return jsonResponse(req, { error: 'Ett oväntat fel inträffade. Försök igen senare.' }, 500);
  }
});
