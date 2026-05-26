const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type RutPayload = {
  name: string;
  email: string;
  phone: string;
  bookingId?: string;
  token?: string;
  referenceDocumentType?: 'INVOICE' | 'ORDER' | 'OFFER';
  referenceNumber?: string;
  socialSecurityNumber: string;
  askedAmount: number | string;
  propertyDesignation?: string;
  residenceAssociationOrganisationNumber?: string;
  consentAccepted?: boolean;
  formStartedAt?: string;
  website?: string;
};

type FortnoxResult = {
  posted: boolean;
  reason?: string;
  fortnoxStatus?: number;
  fortnoxResponse?: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function normalizeDigits(value: string) {
  return String(value || '').replace(/\D/g, '');
}

function escapeHtml(value: string) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizePersonalNumber(value: string) {
  const digits = normalizeDigits(value);
  if (digits.length === 10) {
    const yearPrefix = Number(digits.slice(0, 2)) > Number(String(new Date().getFullYear()).slice(2)) ? '19' : '20';
    return `${yearPrefix}${digits}`;
  }
  return digits;
}

function hasValidLuhn(value: string) {
  const tenDigits = value.slice(-10);
  let sum = 0;

  for (let index = 0; index < tenDigits.length; index += 1) {
    let digit = Number(tenDigits[index]);
    if (Number.isNaN(digit)) return false;
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  return sum % 10 === 0;
}

function isValidPersonalNumber(value: string) {
  const normalized = normalizePersonalNumber(value);
  if (!/^\d{12}$/.test(normalized)) return false;
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && hasValidLuhn(normalized);
}

function parseAmount(value: number | string) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const parsed = Number(String(value || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isSuspiciouslyFastSubmission(startedAt: string | undefined) {
  const startedTime = Number(startedAt || 0);
  return Number.isFinite(startedTime) && startedTime > 0 && Date.now() - startedTime < 1500;
}

function isValidToken(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

async function verifyBookingToken(supabaseUrl: string, serviceRoleKey: string, bookingId: string, token: string) {
  if (!/^[a-z0-9_-]{1,80}$/i.test(bookingId) || !isValidToken(token)) {
    return false;
  }

  const bookingRes = await fetch(
    `${supabaseUrl}/rest/v1/bookings?select=id&id=eq.${encodeURIComponent(bookingId)}&rut_form_token=eq.${encodeURIComponent(token)}&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!bookingRes.ok) {
    console.error('Could not verify RUT booking token', await bookingRes.text());
    throw new Error('Kunde inte verifiera RUT-länken.');
  }

  const bookings = await bookingRes.json();
  return Array.isArray(bookings) && Boolean(bookings[0]);
}

async function markRutReceived(supabaseUrl: string, serviceRoleKey: string, bookingId: string) {
  const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      rut_status: 'Mottaget',
      rut_received_at: new Date().toISOString()
    })
  });

  if (!updateRes.ok) {
    console.error('Could not mark RUT as received', await updateRes.text());
    return false;
  }

  return true;
}

async function postToFortnox(payload: RutPayload, askedAmount: number): Promise<FortnoxResult> {
  const fortnoxAccessToken = Deno.env.get('FORTNOX_ACCESS_TOKEN');
  const referenceDocumentType = String(payload.referenceDocumentType || '').toUpperCase();

  if (!fortnoxAccessToken) {
    return {
      posted: false,
      reason: 'FORTNOX_ACCESS_TOKEN saknas'
    };
  }

  if (!payload.referenceNumber || !referenceDocumentType) {
    return {
      posted: false,
      reason: 'Fortnox-dokument saknas'
    };
  }

  if (!['INVOICE', 'ORDER', 'OFFER'].includes(referenceDocumentType)) {
    return {
      posted: false,
      reason: 'Fortnox-dokumenttypen är ogiltig'
    };
  }

  const taxReduction: Record<string, unknown> = {
    SocialSecurityNumber: normalizePersonalNumber(payload.socialSecurityNumber),
    AskedAmount: askedAmount,
    ReferenceDocumentType: referenceDocumentType,
    ReferenceNumber: payload.referenceNumber
  };

  if (payload.propertyDesignation) {
    taxReduction.PropertyDesignation = payload.propertyDesignation.trim();
  }

  if (payload.residenceAssociationOrganisationNumber) {
    taxReduction.ResidenceAssociationOrganisationNumber = normalizeDigits(payload.residenceAssociationOrganisationNumber);
  }

  const fortnoxRes = await fetch('https://api.fortnox.se/3/taxreductions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fortnoxAccessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ TaxReduction: taxReduction })
  });

  const bodyText = await fortnoxRes.text();

  if (!fortnoxRes.ok) {
    console.error('Fortnox RUT submission failed', {
      status: fortnoxRes.status,
      body: bodyText
    });
    throw new Error('Fortnox kunde inte ta emot RUT-underlaget.');
  }

  let parsedResponse: unknown = null;
  if (bodyText) {
    try {
      parsedResponse = JSON.parse(bodyText);
    } catch {
      parsedResponse = bodyText;
    }
  }

  return {
    posted: true,
    fortnoxStatus: fortnoxRes.status,
    fortnoxResponse: parsedResponse
  };
}

async function sendNotification(payload: RutPayload, askedAmount: number, fortnoxResult: FortnoxResult) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
  const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL') || 'bokning@bergafonsterputs.se';

  if (!resendApiKey || !fromEmail) return false;

  const subjectSuffix = fortnoxResult.posted ? 'skickat till Fortnox' : 'behöver Fortnox-koppling';
  const html = `
    <div style="font-family: Arial, sans-serif; color: #173042; line-height: 1.6;">
      <h2>RUT-underlag mottaget (${subjectSuffix})</h2>
      <p>RUT-formuläret har skickats via den säkra Edge Functionen. Personnummer visas inte i detta mail.</p>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 8px 0; font-weight: 700;">Namn</td><td>${escapeHtml(payload.name)}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">E-post</td><td>${escapeHtml(payload.email)}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Telefon</td><td>${escapeHtml(payload.phone)}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Boknings-ID</td><td>${escapeHtml(payload.bookingId || 'Ej angivet')}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Fortnox dokument</td><td>${escapeHtml(`${payload.referenceDocumentType || 'Ej angivet'} ${payload.referenceNumber || ''}`)}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Begärt RUT-belopp</td><td>${askedAmount} kr</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Fastighetsbeteckning</td><td>${escapeHtml(payload.propertyDesignation || 'Ej angivet')}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Fortnox-status</td><td>${escapeHtml(String(fortnoxResult.posted ? 'Skickat' : fortnoxResult.reason || 'Ej skickat'))}</td></tr>
      </table>
    </div>
  `;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [notificationEmail],
      subject: `RUT-underlag ${payload.bookingId ? `för bokning ${payload.bookingId}` : ''} - ${subjectSuffix}`,
      html,
      reply_to: isValidEmail(payload.email) ? payload.email.trim() : undefined
    })
  });

  if (!emailRes.ok) {
    console.error('RUT notification email failed', await emailRes.text());
    return false;
  }

  return true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const payload = (await req.json()) as RutPayload;

    if (payload.website || isSuspiciouslyFastSubmission(payload.formStartedAt)) {
      return jsonResponse({ success: true, received: true, fortnoxPosted: false });
    }

    if (!payload.name || !payload.email || !payload.phone || !payload.socialSecurityNumber || !payload.askedAmount) {
      return jsonResponse({ error: 'Fyll i alla obligatoriska fält.' }, 400);
    }

    if (!payload.consentAccepted) {
      return jsonResponse({ error: 'Samtycke krävs för att skicka RUT-underlaget.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const bookingId = String(payload.bookingId || '').trim();
    const token = String(payload.token || '').trim();

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Server configuration saknas.' }, 500);
    }

    if (!bookingId || !token) {
      return jsonResponse({ error: 'Säkerhetslänken saknas. Använd länken från bokningsbekräftelsen.' }, 403);
    }

    const hasValidBookingToken = await verifyBookingToken(supabaseUrl, serviceRoleKey, bookingId, token);
    if (!hasValidBookingToken) {
      return jsonResponse({ error: 'RUT-länken är ogiltig eller har bytts ut. Kontakta oss så skickar vi en ny.' }, 403);
    }

    if (!isValidEmail(payload.email)) {
      return jsonResponse({ error: 'Ange en giltig e-postadress.' }, 400);
    }

    if (!isValidPersonalNumber(payload.socialSecurityNumber)) {
      return jsonResponse({ error: 'Ange ett giltigt personnummer.' }, 400);
    }

    const askedAmount = parseAmount(payload.askedAmount);
    if (askedAmount === null || askedAmount < 0) {
      return jsonResponse({ error: 'Ange ett giltigt RUT-belopp.' }, 400);
    }

    const fortnoxResult = await postToFortnox(payload, askedAmount);
    const allowNoFortnox = Deno.env.get('RUT_ALLOW_NO_FORTNOX') === 'true';
    const notificationSent = await sendNotification(payload, askedAmount, fortnoxResult);

    if (!fortnoxResult.posted && !allowNoFortnox) {
      return jsonResponse({
        error: 'RUT-formuläret är säkert, men Fortnox-kopplingen är inte helt klar ännu. Kontakta oss så hjälper vi dig.',
        received: false,
        fortnoxPosted: false,
        notificationSent
      }, 409);
    }

    const rutMarkedReceived = await markRutReceived(supabaseUrl, serviceRoleKey, bookingId);

    return jsonResponse({
      success: true,
      received: true,
      fortnoxPosted: fortnoxResult.posted,
      notificationSent,
      rutMarkedReceived
    });
  } catch (error) {
    console.error('Unhandled submit-rut error', error instanceof Error ? error.message : error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Okänt fel.' }, 500);
  }
});
