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
  customerNumber?: string;
  invoiceNumber?: string;
  referenceDocumentType?: 'INVOICE' | 'ORDER' | 'OFFER';
  referenceNumber?: string;
};

type BookingRecord = {
  id: number | string;
  customer_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  booking_date?: string | null;
  booking_time?: string | null;
  housing_type?: string | null;
  window_count?: string | null;
  service_scope?: string | null;
  addons?: string | null;
  transport_type?: string | null;
  sea_miles?: string | null;
  coordinates?: string | null;
  price?: string | number | null;
  original_price?: string | number | null;
  rut_form_token?: string | null;
  fortnox_customer_number?: string | null;
  fortnox_invoice_number?: string | null;
};

type FortnoxTokenRecord = {
  provider: string;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: string | null;
  scope?: string | null;
  token_type?: string | null;
};

type FortnoxTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
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

function parsePriceNumber(value: number | string | null | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const rawValue = String(value || '').trim();
  if (!rawValue || /offert|kontakta/i.test(rawValue)) return null;
  const parsed = Number(rawValue.replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function splitAddons(value: unknown) {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function addSecondsToNow(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function hasUsableAccessToken(token: string | null | undefined, expiresAt: string | null | undefined) {
  if (!token) return false;
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  return Number.isFinite(expiryTime) && expiryTime > Date.now() + 5 * 60 * 1000;
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

async function fetchBookingByRutToken(supabaseUrl: string, serviceRoleKey: string, bookingId: string, token: string): Promise<BookingRecord | null> {
  if (!/^[a-z0-9_-]{1,80}$/i.test(bookingId) || !isValidToken(token)) {
    return null;
  }

  const bookingRes = await fetch(
    `${supabaseUrl}/rest/v1/bookings?select=*&id=eq.${encodeURIComponent(bookingId)}&rut_form_token=eq.${encodeURIComponent(token)}&limit=1`,
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
  return Array.isArray(bookings) ? bookings[0] || null : null;
}

async function patchBooking(supabaseUrl: string, serviceRoleKey: string, bookingId: string, values: Record<string, unknown>) {
  const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(values)
  });

  if (!updateRes.ok) {
    console.error('Could not update booking', await updateRes.text());
    return false;
  }

  return true;
}

async function fetchFortnoxTokenRecord(supabaseUrl: string, serviceRoleKey: string): Promise<FortnoxTokenRecord | null> {
  const tokenRes = await fetch(`${supabaseUrl}/rest/v1/fortnox_oauth_tokens?provider=eq.fortnox&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!tokenRes.ok) {
    console.error('Could not fetch Fortnox token record', await tokenRes.text());
    return null;
  }

  const tokens = await tokenRes.json();
  return Array.isArray(tokens) ? tokens[0] || null : null;
}

async function saveFortnoxTokenRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  token: FortnoxTokenResponse,
  fallbackRefreshToken: string
) {
  const accessToken = String(token.access_token || '').trim();
  const refreshToken = String(token.refresh_token || fallbackRefreshToken || '').trim();

  if (!accessToken || !refreshToken) {
    return false;
  }

  const upsertRes = await fetch(`${supabaseUrl}/rest/v1/fortnox_oauth_tokens?on_conflict=provider`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      provider: 'fortnox',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: addSecondsToNow(Number(token.expires_in || 3600)),
      scope: token.scope || null,
      token_type: token.token_type || 'bearer',
      updated_at: new Date().toISOString()
    })
  });

  if (!upsertRes.ok) {
    console.error('Could not save Fortnox token record', await upsertRes.text());
    return false;
  }

  return true;
}

async function refreshFortnoxAccessToken(refreshToken: string): Promise<FortnoxTokenResponse> {
  const clientId = Deno.env.get('FORTNOX_CLIENT_ID');
  const clientSecret = Deno.env.get('FORTNOX_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('FORTNOX_CLIENT_ID eller FORTNOX_CLIENT_SECRET saknas.');
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);

  const tokenRes = await fetch('https://apps.fortnox.se/oauth-v1/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const tokenBody = await tokenRes.json().catch(() => null) as FortnoxTokenResponse | null;

  if (!tokenRes.ok || !tokenBody?.access_token) {
    console.error('Fortnox token refresh failed', {
      status: tokenRes.status,
      body: tokenBody
    });
    throw new Error('Fortnox-token kunde inte förnyas.');
  }

  return tokenBody;
}

async function getFortnoxAccessToken(supabaseUrl: string, serviceRoleKey: string) {
  const tokenRecord = await fetchFortnoxTokenRecord(supabaseUrl, serviceRoleKey);

  if (hasUsableAccessToken(tokenRecord?.access_token, tokenRecord?.expires_at)) {
    return String(tokenRecord?.access_token || '');
  }

  const refreshToken = String(tokenRecord?.refresh_token || Deno.env.get('FORTNOX_REFRESH_TOKEN') || '').trim();
  if (refreshToken) {
    const refreshedToken = await refreshFortnoxAccessToken(refreshToken);
    await saveFortnoxTokenRecord(supabaseUrl, serviceRoleKey, refreshedToken, refreshToken);
    return String(refreshedToken.access_token || '');
  }

  const staticAccessToken = Deno.env.get('FORTNOX_ACCESS_TOKEN');
  if (staticAccessToken) {
    return staticAccessToken;
  }

  return '';
}

function getFortnoxHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

async function fortnoxRequest(accessToken: string, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(getFortnoxHeaders(accessToken))) {
    headers.set(key, value);
  }

  const response = await fetch(url, {
    ...init,
    headers
  });
  const bodyText = await response.text();
  let body: unknown = null;

  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }

  if (!response.ok) {
    console.error('Fortnox request failed', {
      url,
      method: init.method || 'GET',
      status: response.status,
      body
    });
    throw new Error('Fortnox kunde inte hantera begäran.');
  }

  return { response, body };
}

function getNestedString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = null;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'string' || typeof current === 'number') {
      const result = String(current).trim();
      if (result) return result;
    }
  }
  return '';
}

async function findFortnoxCustomer(accessToken: string, email: string) {
  if (!isValidEmail(email)) return '';

  try {
    const { body } = await fortnoxRequest(
      accessToken,
      `https://api.fortnox.se/3/customers?email=${encodeURIComponent(email.trim())}`
    );
    const customers = (body as { Customers?: Array<Record<string, unknown>> } | null)?.Customers || [];
    const matchingCustomer = customers.find((customer) => String(customer.Email || '').toLowerCase() === email.trim().toLowerCase()) || customers[0];
    return matchingCustomer ? String(matchingCustomer.CustomerNumber || '').trim() : '';
  } catch (error) {
    console.error('Could not search Fortnox customer, continuing with create', error instanceof Error ? error.message : error);
    return '';
  }
}

async function createFortnoxCustomer(accessToken: string, payload: RutPayload, booking: BookingRecord | null) {
  const existingCustomerNumber = String(booking?.fortnox_customer_number || '').trim();
  if (existingCustomerNumber) return existingCustomerNumber;

  const foundCustomerNumber = await findFortnoxCustomer(accessToken, payload.email);
  if (foundCustomerNumber) return foundCustomerNumber;

  const customer = {
    Name: payload.name.trim(),
    Email: payload.email.trim(),
    Phone1: payload.phone.trim(),
    Address1: String(booking?.address || '').trim() || undefined
  };

  const { body } = await fortnoxRequest(accessToken, 'https://api.fortnox.se/3/customers', {
    method: 'POST',
    body: JSON.stringify({ Customer: customer })
  });

  const customerNumber = getNestedString(body, [
    ['Customer', 'CustomerNumber'],
    ['CustomerNumber']
  ]);

  if (!customerNumber) {
    throw new Error('Fortnox skapade kunden men returnerade inget kundnummer.');
  }

  return customerNumber;
}

function buildInvoiceDescription(booking: BookingRecord | null) {
  const parts = [
    'Fönsterputs',
    booking?.booking_date ? String(booking.booking_date) : '',
    booking?.booking_time ? String(booking.booking_time) : '',
    booking?.service_scope ? String(booking.service_scope) : '',
    booking?.window_count ? `${String(booking.window_count)} glaspartier` : '',
    ...splitAddons(booking?.addons)
  ].filter(Boolean);

  return parts.join(' - ').slice(0, 200);
}

async function createFortnoxInvoice(accessToken: string, customerNumber: string, booking: BookingRecord | null, askedAmount: number) {
  const existingInvoiceNumber = String(booking?.fortnox_invoice_number || '').trim();
  if (existingInvoiceNumber) return existingInvoiceNumber;

  const invoiceEndpoint = Deno.env.get('FORTNOX_CASH_INVOICE_ENDPOINT') || 'https://api.fortnox.se/3/invoices';
  const invoiceWrapper = /cashinvoices/i.test(invoiceEndpoint) ? 'CashInvoice' : 'Invoice';
  const priceAfterRut = parsePriceNumber(booking?.price) ?? askedAmount + 150;
  const originalPriceAfterRut = parsePriceNumber(booking?.original_price) ?? priceAfterRut;
  const rutEligibleAmount = Math.max(0, originalPriceAfterRut - 150);
  const priceBeforeRut = Math.max(priceAfterRut + rutEligibleAmount, priceAfterRut);
  const today = getTodayDateString();
  const invoice = {
    CustomerNumber: customerNumber,
    InvoiceDate: today,
    DueDate: today,
    YourReference: payloadReferenceName(booking),
    Remarks: `Boknings-ID ${booking?.id || ''}. RUT-underlag skickat via hemsidan.`,
    InvoiceRows: [
      {
        Description: buildInvoiceDescription(booking),
        DeliveredQuantity: 1,
        Price: priceBeforeRut,
        VAT: Number(Deno.env.get('FORTNOX_INVOICE_ROW_VAT') || '25')
      }
    ]
  };

  const { body } = await fortnoxRequest(accessToken, invoiceEndpoint, {
    method: 'POST',
    body: JSON.stringify({ [invoiceWrapper]: invoice })
  });

  const invoiceNumber = getNestedString(body, [
    [invoiceWrapper, 'DocumentNumber'],
    [invoiceWrapper, 'InvoiceNumber'],
    [invoiceWrapper, 'GivenNumber'],
    ['Invoice', 'DocumentNumber'],
    ['Invoice', 'InvoiceNumber'],
    ['CashInvoice', 'DocumentNumber'],
    ['CashInvoice', 'InvoiceNumber'],
    ['DocumentNumber'],
    ['InvoiceNumber']
  ]);

  if (!invoiceNumber) {
    throw new Error('Fortnox skapade fakturan men returnerade inget dokumentnummer.');
  }

  return invoiceNumber;
}

function payloadReferenceName(booking: BookingRecord | null) {
  return String(booking?.customer_name || '').trim().slice(0, 50) || undefined;
}

async function postTaxReductionToFortnox(
  accessToken: string,
  payload: RutPayload,
  askedAmount: number,
  referenceDocumentType: 'INVOICE' | 'ORDER' | 'OFFER',
  referenceNumber: string
) {
  const taxReduction: Record<string, unknown> = {
    SocialSecurityNumber: normalizePersonalNumber(payload.socialSecurityNumber),
    AskedAmount: askedAmount,
    ReferenceDocumentType: referenceDocumentType,
    ReferenceNumber: referenceNumber
  };

  if (payload.propertyDesignation) {
    taxReduction.PropertyDesignation = payload.propertyDesignation.trim();
  }

  if (payload.residenceAssociationOrganisationNumber) {
    taxReduction.ResidenceAssociationOrganisationNumber = normalizeDigits(payload.residenceAssociationOrganisationNumber);
  }

  const { response, body } = await fortnoxRequest(accessToken, 'https://api.fortnox.se/3/taxreductions', {
    method: 'POST',
    body: JSON.stringify({ TaxReduction: taxReduction })
  });

  return {
    status: response.status,
    body
  };
}

async function postToFortnox(
  payload: RutPayload,
  askedAmount: number,
  booking: BookingRecord | null,
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: string
): Promise<FortnoxResult> {
  const fortnoxAccessToken = await getFortnoxAccessToken(supabaseUrl, serviceRoleKey);
  let referenceDocumentType = String(payload.referenceDocumentType || '').toUpperCase() as 'INVOICE' | 'ORDER' | 'OFFER' | '';
  let referenceNumber = String(payload.referenceNumber || '').trim();

  if (!fortnoxAccessToken) {
    return {
      posted: false,
      reason: 'Fortnox OAuth-token saknas'
    };
  }

  if (referenceDocumentType && !['INVOICE', 'ORDER', 'OFFER'].includes(referenceDocumentType)) {
    return {
      posted: false,
      reason: 'Fortnox-dokumenttypen är ogiltig'
    };
  }

  let customerNumber = String(booking?.fortnox_customer_number || '').trim();
  let invoiceNumber = String(booking?.fortnox_invoice_number || '').trim();

  if (!referenceNumber) {
    customerNumber = await createFortnoxCustomer(fortnoxAccessToken, payload, booking);
    invoiceNumber = await createFortnoxInvoice(fortnoxAccessToken, customerNumber, booking, askedAmount);
    referenceDocumentType = 'INVOICE';
    referenceNumber = invoiceNumber;

    await patchBooking(supabaseUrl, serviceRoleKey, bookingId, {
      fortnox_customer_number: customerNumber,
      fortnox_invoice_number: invoiceNumber,
      fortnox_reference_document_type: referenceDocumentType,
      fortnox_reference_number: referenceNumber
    });
  }

  const taxReductionResult = await postTaxReductionToFortnox(
    fortnoxAccessToken,
    payload,
    askedAmount,
    referenceDocumentType || 'INVOICE',
    referenceNumber
  );

  if (referenceNumber) {
    await patchBooking(supabaseUrl, serviceRoleKey, bookingId, {
      fortnox_reference_document_type: referenceDocumentType || 'INVOICE',
      fortnox_reference_number: referenceNumber,
      fortnox_rut_synced_at: new Date().toISOString()
    });
  }

  return {
    posted: true,
    fortnoxStatus: taxReductionResult.status,
    fortnoxResponse: taxReductionResult.body,
    customerNumber,
    invoiceNumber,
    referenceDocumentType: referenceDocumentType || 'INVOICE',
    referenceNumber
  };
}

async function markRutReceived(supabaseUrl: string, serviceRoleKey: string, bookingId: string, fortnoxResult: FortnoxResult) {
  const values: Record<string, unknown> = {
    rut_status: 'Mottaget',
    rut_received_at: new Date().toISOString()
  };

  if (fortnoxResult.posted) {
    values.rut_status = 'Verifierat';
    values.fortnox_rut_synced_at = new Date().toISOString();
    if (fortnoxResult.customerNumber) values.fortnox_customer_number = fortnoxResult.customerNumber;
    if (fortnoxResult.invoiceNumber) values.fortnox_invoice_number = fortnoxResult.invoiceNumber;
    if (fortnoxResult.referenceDocumentType) values.fortnox_reference_document_type = fortnoxResult.referenceDocumentType;
    if (fortnoxResult.referenceNumber) values.fortnox_reference_number = fortnoxResult.referenceNumber;
  }

  const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(values)
  });

  if (!updateRes.ok) {
    const errorText = await updateRes.text();

    if (/fortnox_/i.test(errorText)) {
      const fallbackValues = {
        rut_status: values.rut_status,
        rut_received_at: values.rut_received_at
      };

      return await patchBooking(supabaseUrl, serviceRoleKey, bookingId, fallbackValues);
    }

    console.error('Could not mark RUT as received', errorText);
    return false;
  }

  return true;
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
        <tr><td style="padding: 8px 0; font-weight: 700;">Fortnox kundnummer</td><td>${escapeHtml(fortnoxResult.customerNumber || 'Ej angivet')}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 700;">Fortnox dokument</td><td>${escapeHtml(`${fortnoxResult.referenceDocumentType || payload.referenceDocumentType || 'Ej angivet'} ${fortnoxResult.referenceNumber || payload.referenceNumber || ''}`)}</td></tr>
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

    const booking = await fetchBookingByRutToken(supabaseUrl, serviceRoleKey, bookingId, token);
    if (!booking) {
      return jsonResponse({ error: 'RUT-länken är ogiltig eller har bytts ut. Kontakta oss så skickar vi en ny.' }, 403);
    }

    if (!isValidEmail(payload.email)) {
      return jsonResponse({ error: 'Ange en giltig e-postadress.' }, 400);
    }

    if (!isValidPersonalNumber(payload.socialSecurityNumber)) {
      return jsonResponse({ error: 'Ange ett giltigt personnummer.' }, 400);
    }

    const submittedAskedAmount = parseAmount(payload.askedAmount);
    if (submittedAskedAmount === null || submittedAskedAmount < 0) {
      return jsonResponse({ error: 'Ange ett giltigt RUT-belopp.' }, 400);
    }

    const bookingPriceForRut = parsePriceNumber(booking.original_price) ?? parsePriceNumber(booking.price) ?? 0;
    const maximumRutAmount = Math.max(0, bookingPriceForRut - 150);
    const askedAmount = Math.min(submittedAskedAmount, maximumRutAmount);

    const fortnoxResult = await postToFortnox(payload, askedAmount, booking, supabaseUrl, serviceRoleKey, bookingId);
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

    const rutMarkedReceived = await markRutReceived(supabaseUrl, serviceRoleKey, bookingId, fortnoxResult);

    return jsonResponse({
      success: true,
      received: true,
      fortnoxPosted: fortnoxResult.posted,
      fortnoxCustomerNumber: fortnoxResult.customerNumber || null,
      fortnoxInvoiceNumber: fortnoxResult.invoiceNumber || null,
      fortnoxReferenceNumber: fortnoxResult.referenceNumber || null,
      notificationSent,
      rutMarkedReceived
    });
  } catch (error) {
    console.error('Unhandled submit-rut error', error instanceof Error ? error.message : error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Okänt fel.' }, 500);
  }
});
