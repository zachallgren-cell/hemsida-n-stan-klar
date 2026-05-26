const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type CompleteBookingPayload = {
  bookingId: number;
  paymentMethod?: string;
};

type StripeProduct = {
  id: string;
  default_price?: string | { id?: string };
};

type StripeCheckoutSession = {
  id: string;
  url?: string | null;
  expires_at?: number | null;
  payment_intent?: string | null;
};

type StripeCheckoutDetails = {
  productId: string;
  priceId: string;
  sessionId: string;
  paymentIntentId: string | null;
  url: string;
  expiresAt: string | null;
};

type AdminCheckResult = {
  ok: true;
} | {
  ok: false;
  response: Response;
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function parsePriceToOre(value: number | string | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
  }

  const rawValue = String(value || '').trim();
  if (!rawValue || /offert|kontakta/i.test(rawValue)) {
    return null;
  }

  let normalized = rawValue.replace(/\s/g, '').replace(/[^\d,.-]/g, '');

  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replaceAll('.', '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replaceAll('.', '');
  } else {
    normalized = normalized.replace(',', '.');
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

function formatSekFromOre(valueOre: number | null) {
  return valueOre === null ? '' : `${Math.round(valueOre / 100).toLocaleString('sv-SE')} kr`;
}

function hasDisplayValue(value: unknown) {
  return String(value ?? '').trim().length > 0;
}

function escapeDisplayValue(value: unknown) {
  return escapeHtml(String(value ?? '').trim());
}

function buildDetailRow(label: string, value: unknown) {
  if (!hasDisplayValue(value)) {
    return '';
  }

  return `
    <tr>
      <td width="42%" style="width: 42%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #5b6b7a; font-size: 14px; vertical-align: top;">${label}</td>
      <td width="58%" style="width: 58%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #0f2638; font-size: 14px; font-weight: 700; text-align: right; vertical-align: top;">${escapeDisplayValue(value)}</td>
    </tr>
  `;
}

function buildWorkRow(value: unknown) {
  if (!hasDisplayValue(value)) {
    return '';
  }

  return `
    <tr>
      <td width="28" style="width: 28px; padding: 6px 0; color: #287a45; font-size: 15px; font-weight: 800; vertical-align: top;">&#10003;</td>
      <td style="padding: 6px 0; color: #0f2638; font-size: 14px; line-height: 1.55; font-weight: 700;">${escapeDisplayValue(value)}</td>
    </tr>
  `;
}

function splitAddons(value: unknown) {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function stripePost<T>(stripeSecretKey: string, path: string, params: URLSearchParams): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMessage = body?.error?.message || `Stripe request failed with ${response.status}`;
    throw new Error(errorMessage);
  }

  return body as T;
}

async function requireBookingAdmin(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<AdminCheckResult> {
  const authHeader = req.headers.get('authorization') || '';

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, response: jsonResponse({ error: 'Admin login is required' }, 401) };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader
    }
  });

  if (!userRes.ok) {
    return { ok: false, response: jsonResponse({ error: 'Admin session could not be verified' }, 401) };
  }

  const user = await userRes.json();
  const userId = String(user?.id || '');

  if (!userId) {
    return { ok: false, response: jsonResponse({ error: 'Admin session is missing user id' }, 401) };
  }

  const adminRes = await fetch(`${supabaseUrl}/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!adminRes.ok) {
    console.error('Could not verify admin user', await adminRes.text());
    return { ok: false, response: jsonResponse({ error: 'Admin permission could not be verified' }, 500) };
  }

  const [adminUser] = await adminRes.json();

  if (!adminUser) {
    return { ok: false, response: jsonResponse({ error: 'Admin permission is required' }, 403) };
  }

  return { ok: true };
}

function buildPaymentReturnUrl(siteUrl: string, booking: Record<string, unknown>, stripeStatus: string) {
  const params = new URLSearchParams({
    bookingId: String(booking.id || ''),
    stripe: stripeStatus,
    name: String(booking.customer_name || ''),
    date: String(booking.booking_date || ''),
    time: String(booking.booking_time || ''),
    housingType: String(booking.housing_type || ''),
    windowCount: String(booking.window_count || ''),
    serviceScope: String(booking.service_scope || ''),
    addons: String(booking.addons || ''),
    transportType: String(booking.transport_type || 'Fastland'),
    seaMiles: String(booking.sea_miles || ''),
    coordinates: String(booking.coordinates || ''),
    price: String(booking.price || '')
  });

  return `${siteUrl}/betalning.html?${params.toString()}`;
}

function hasUsableStripeCheckout(booking: Record<string, unknown>) {
  const checkoutUrl = String(booking.stripe_payment_url || '');
  const expiresAt = String(booking.stripe_checkout_expires_at || '');

  if (!checkoutUrl || !expiresAt) {
    return false;
  }

  const expiryTime = new Date(expiresAt).getTime();
  return Number.isFinite(expiryTime) && expiryTime > Date.now() + 5 * 60 * 1000;
}

async function createStripeCheckout(
  stripeSecretKey: string,
  siteUrl: string,
  booking: Record<string, unknown>
): Promise<StripeCheckoutDetails | null> {
  const unitAmount = parsePriceToOre(booking.price as number | string | undefined);

  if (!unitAmount) {
    return null;
  }

  const productParams = new URLSearchParams();
  productParams.set('name', `Berga Fönsterputs - ${String(booking.booking_date || '')} ${String(booking.booking_time || '')}`);
  productParams.set('default_price_data[currency]', 'sek');
  productParams.set('default_price_data[unit_amount]', String(unitAmount));
  productParams.set('metadata[booking_id]', String(booking.id || ''));
  productParams.set('metadata[service]', 'Fönsterputs');

  const product = await stripePost<StripeProduct>(stripeSecretKey, '/v1/products', productParams);
  const defaultPrice = typeof product.default_price === 'string'
    ? product.default_price
    : product.default_price?.id;

  if (!defaultPrice) {
    throw new Error('Stripe product saknar default_price.');
  }

  const sessionParams = new URLSearchParams();
  sessionParams.set('line_items[0][price]', defaultPrice);
  sessionParams.set('line_items[0][quantity]', '1');
  sessionParams.set('mode', 'payment');
  sessionParams.set('success_url', buildPaymentReturnUrl(siteUrl, booking, 'success'));
  sessionParams.set('cancel_url', buildPaymentReturnUrl(siteUrl, booking, 'cancelled'));
  sessionParams.set('client_reference_id', String(booking.id || ''));
  sessionParams.set('metadata[booking_id]', String(booking.id || ''));
  sessionParams.set('metadata[booking_date]', String(booking.booking_date || ''));
  sessionParams.set('metadata[booking_time]', String(booking.booking_time || ''));

  if (isValidEmail(String(booking.email || ''))) {
    sessionParams.set('customer_email', String(booking.email).trim());
  }

  const session = await stripePost<StripeCheckoutSession>(stripeSecretKey, '/v1/checkout/sessions', sessionParams);

  if (!session.url) {
    throw new Error('Stripe Checkout-session saknar betalningslänk.');
  }

  return {
    productId: product.id,
    priceId: defaultPrice,
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    url: session.url,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const payload = (await req.json()) as CompleteBookingPayload;

    if (!payload.bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    const contactPhone = Deno.env.get('BOOKING_CONTACT_PHONE') || '073-388 12 16';
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const reviewUrl = Deno.env.get('BOOKING_REVIEW_URL') || '';
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') || '';
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    const adminCheck = await requireBookingAdmin(req, supabaseUrl, serviceRoleKey);
    if (!adminCheck.ok) {
      return adminCheck.response;
    }

    if (!resendApiKey || !fromEmail) {
      return jsonResponse({ error: 'Email secrets are missing' }, 500);
    }

    const bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${payload.bookingId}&select=*`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!bookingRes.ok) {
      const errorText = await bookingRes.text();
      console.error('Could not fetch booking', errorText);
      return jsonResponse({ error: 'Could not fetch booking', details: errorText }, 500);
    }

    const [booking] = await bookingRes.json();

    if (!booking) {
      return jsonResponse({ error: 'Booking not found' }, 404);
    }

    if (!isValidEmail(booking.email || '')) {
      return jsonResponse({ error: 'Customer email is invalid for completion mail' }, 400);
    }

    const paymentMethod = payload.paymentMethod || booking.payment_method || 'Stripe Checkout';
    const completedAt = new Date().toISOString();
    const isAlreadyPaid = String(booking.payment_status || '').toLowerCase() === 'paid' || Boolean(booking.stripe_paid_at);
    let stripePaymentUrl = '';
    let stripeCheckout: StripeCheckoutDetails | null = null;

    if (paymentMethod !== 'Faktura via e-post' && !isAlreadyPaid) {
      if (hasUsableStripeCheckout(booking)) {
        stripePaymentUrl = String(booking.stripe_payment_url || '');
      } else {
        if (!stripeSecretKey) {
          return jsonResponse({ error: 'Stripe secret is missing' }, 500);
        }

        stripeCheckout = await createStripeCheckout(stripeSecretKey, siteUrl, booking);
        if (!stripeCheckout) {
          return jsonResponse({ error: 'Stripe-länk kunde inte skapas eftersom bokningen saknar ett fast pris. Välj Faktura via e-post eller sätt ett fast pris på bokningen först.' }, 400);
        }

        stripePaymentUrl = stripeCheckout?.url || '';
      }
    }

    if (stripeCheckout) {
      const stripeUpdateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${payload.bookingId}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          payment_provider: 'stripe',
          stripe_product_id: stripeCheckout.productId,
          stripe_price_id: stripeCheckout.priceId,
          stripe_checkout_session_id: stripeCheckout.sessionId,
          stripe_payment_intent_id: stripeCheckout.paymentIntentId,
          stripe_payment_url: stripeCheckout.url,
          stripe_checkout_expires_at: stripeCheckout.expiresAt
        })
      });

      if (!stripeUpdateRes.ok) {
        const errorText = await stripeUpdateRes.text();
        console.error('Could not save Stripe checkout details', errorText);
        return jsonResponse({ error: 'Could not save Stripe checkout details', details: errorText }, 500);
      }
    }

    const logoUrl = `${siteUrl}/logga-fonsterputs-transparent.png`;
    const safeLogoUrl = escapeHtml(logoUrl);
    const safeContactEmail = escapeHtml(contactEmail);
    const safeContactPhone = escapeHtml(contactPhone);
    const safeStripePaymentUrl = escapeHtml(stripePaymentUrl);
    const safeReviewUrl = escapeHtml(reviewUrl);
    const priceAfterRutOre = parsePriceToOre(booking.price as number | string | undefined);
    const priceBeforeRutDisplay = formatSekFromOre(priceAfterRutOre === null ? null : priceAfterRutOre * 2);
    const rutDeductionDisplay = priceAfterRutOre === null ? '' : `-${formatSekFromOre(priceAfterRutOre)}`;
    const priceAfterRutDisplay = priceAfterRutOre === null
      ? escapeDisplayValue(booking.price)
      : formatSekFromOre(priceAfterRutOre);
    const windowWorkItem = /^\d+$/.test(String(booking.window_count || '').trim())
      ? `${String(booking.window_count).trim()} glaspartier`
      : booking.window_count;
    const detailRows = [
      buildDetailRow('Datum', booking.booking_date),
      buildDetailRow('Tid', booking.booking_time),
      buildDetailRow('Adress', booking.address),
      buildDetailRow('Tjänst', booking.service_scope),
      buildDetailRow('Typ av bostad', booking.housing_type),
      ...(booking.transport_type ? [buildDetailRow('Transport', booking.transport_type)] : []),
      ...(booking.sea_miles ? [buildDetailRow('Sjömil', booking.sea_miles)] : []),
      ...(booking.coordinates ? [buildDetailRow('Koordinater', booking.coordinates)] : [])
    ].join('');
    const workRows = [
      windowWorkItem,
      ...splitAddons(booking.addons)
    ].map(buildWorkRow).join('');
    const priceRows = priceBeforeRutDisplay && rutDeductionDisplay
      ? `
        <tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Pris före RUT</td>
          <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${priceBeforeRutDisplay}</td>
        </tr>
        <tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">RUT-avdrag (50%)</td>
          <td align="right" style="padding: 9px 0; color: #287a45; font-size: 15px; font-weight: 700;">${rutDeductionDisplay}</td>
        </tr>
      `
      : '';
    const stripePaymentSection = paymentMethod === 'Faktura via e-post'
      ? `
        <p style="margin: 0; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Vi skickar faktura via e-post inom 3-7 dagar.</p>
      `
      : isAlreadyPaid
        ? `
          <p style="margin: 0; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Betalningen är redan mottagen via Stripe. Tack!</p>
        `
        : stripePaymentUrl
          ? `
            <p style="margin: 0 0 14px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Betala enkelt online med kort via Stripe.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%;">
              <tr>
                <td align="center" style="background: #ffffff; border-radius: 999px;">
                  <a href="${safeStripePaymentUrl}" style="display: block; padding: 14px 20px; color: #0f2638; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">BETALA MED KORT</a>
                </td>
              </tr>
            </table>
          `
          : `
            <p style="margin: 0; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Vi skickar en betalningslänk via Stripe när den är redo.</p>
          `;
    const reviewSection = reviewUrl
      ? `
        <tr>
          <td style="background: #ffffff; padding: 18px 42px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fff8ec; border: 1px solid #ffd08b; border-radius: 14px;">
              <tr>
                <td style="padding: 20px;">
                  <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Hjälp oss växa</h2>
                  <p style="margin: 0 0 14px; color: #536574; font-size: 14px; line-height: 1.7;">Om du är nöjd skulle vi bli otroligt glada om du lämnar en recension.</p>
                  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%;">
                    <tr>
                      <td align="center" style="background: #ffac37; border-radius: 999px;">
                        <a href="${safeReviewUrl}" style="display: block; padding: 14px 20px; color: #18364b; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">LÄMNA RECENSION</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `
      : '';

    const emailHtml = `
      <div style="margin: 0; padding: 0; background: #f3f6f8; font-family: Arial, Helvetica, sans-serif; color: #0f2638;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; background: #f3f6f8;">
          <tr>
            <td align="center" style="padding: 32px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 820px; border-collapse: collapse;">
                <tr>
                  <td style="background: #0f2638; border-radius: 18px 18px 0 0; padding: 28px 24px 20px; text-align: center;">
                    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 18px; border-collapse: collapse;">
                      <tr>
                        <td align="center" style="background: #ffffff; border-radius: 16px; padding: 10px 12px;">
                          <img src="${safeLogoUrl}" width="118" alt="Berga Fönsterputs" style="display: block; width: 118px; max-width: 118px; height: auto; margin: 0 auto;">
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">Tryggt &amp; säkert</td>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">Skinande resultat</td>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">100% nöjd kund</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 38px 42px 14px;">
                    <h1 style="margin: 0 0 12px; color: #0f2638; font-size: 34px; line-height: 1.16; font-weight: 800;">Tack! Fönsterputsningen är klar</h1>
                    <p style="margin: 0 0 8px; color: #173042; font-size: 17px; line-height: 1.6;">Hej ${escapeHtml(booking.customer_name || '')},</p>
                    <p style="margin: 0; color: #536574; font-size: 15px; line-height: 1.7;">Vi har nu slutfört arbetet och hoppas att du är riktigt nöjd med resultatet.</p>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 22px; background: #0f2638; border-radius: 14px;">
                          <h2 style="margin: 0 0 10px; color: #ffffff; font-size: 20px;">Betala enkelt</h2>
                          <p style="margin: 0 0 16px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Fönsterputsningen är klar. Här betalar du smidigt med kort eller Swish.</p>
                          ${stripePaymentSection}
                          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top: 14px; border-collapse: collapse;">
                            <tr>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Swish 0733-881216</td>
                              <td style="width: 8px;"></td>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Meddelande: Bokning ${escapeHtml(String(booking.id || ''))}</td>
                            </tr>
                          </table>
                          <p style="margin: 14px 0 0; color: #d8e1e8; font-size: 13px; line-height: 1.6;">Betalning sker gärna inom 3 dagar.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #d7e7dd; border-radius: 14px; background: #f7fbf8;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 14px; color: #0f2638; font-size: 18px; line-height: 1.3;">Betalningsöversikt</h2>
                          ${priceRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${priceRows}</table>` : ''}
                          ${priceAfterRutDisplay ? `
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 12px; border-collapse: collapse; background: #247a43; border-radius: 12px;">
                            <tr>
                              <td style="padding: 18px 18px; color: #ffffff; font-size: 15px; font-weight: 700;">Att betala</td>
                              <td align="right" style="padding: 18px 18px; color: #ffffff; font-size: 26px; line-height: 1.1; font-weight: 800;">${priceAfterRutDisplay}</td>
                            </tr>
                          </table>
                          ` : ''}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${detailRows || workRows ? `
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px 20px 6px;">
                          <h2 style="margin: 0 0 6px; color: #0f2638; font-size: 18px; line-height: 1.3;">Jobbdetaljer</h2>
                          ${detailRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${detailRows}</table>` : ''}
                          ${workRows ? `
                            <h3 style="margin: 18px 0 8px; color: #0f2638; font-size: 15px; line-height: 1.3;">Utfört arbete</h3>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${workRows}</table>
                          ` : ''}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}
                ${reviewSection}
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 34px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Frågor?</h2>
                          <p style="margin: 0 0 12px; color: #536574; font-size: 14px; line-height: 1.7;">Svara direkt på detta mail om du har frågor eller funderingar.</p>
                          <p style="margin: 0; color: #0f2638; font-size: 14px; line-height: 1.8;"><strong>Telefon:</strong> ${safeContactPhone}<br><strong>E-post:</strong> <a href="mailto:${safeContactEmail}" style="color: #0f5475; text-decoration: underline;">${safeContactEmail}</a></p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #0f2638; border-radius: 0 0 18px 18px; padding: 24px 20px; text-align: center;">
                    <p style="margin: 0 0 6px; color: #ffffff; font-size: 16px; font-weight: 800;">Tack för att du väljer Berga Fönsterputs!</p>
                    <p style="margin: 0; color: #d8e1e8; font-size: 13px; line-height: 1.6;">Lokalt företag – personligt bemötande – skinande resultat</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
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
        to: [booking.email.trim()],
        subject: `Fönsterputsningen är klar - ${booking.customer_name || 'Berga Fönsterputs'}`,
        html: emailHtml,
        reply_to: contactEmail
      })
    });

    if (!emailRes.ok) {
      const errorText = await emailRes.text();
      console.error('Completion email failed', errorText);
      return jsonResponse({ error: 'Completion email failed', details: errorText }, 502);
    }

    const completionUpdateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${payload.bookingId}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status: 'completed',
        payment_method: paymentMethod,
        completed_at: completedAt,
        payment_email_sent: true,
        payment_email_sent_at: completedAt
      })
    });

    if (!completionUpdateRes.ok) {
      const errorText = await completionUpdateRes.text();
      console.error('Completion email sent, but booking could not be marked completed', errorText);
      return jsonResponse({ error: 'Completion email sent, but booking could not be marked completed', details: errorText }, 500);
    }

    return jsonResponse({
      success: true,
      bookingId: booking.id,
      paymentMethod,
      stripePaymentUrl: stripePaymentUrl || null,
      paymentAlreadyPaid: isAlreadyPaid
    });
  } catch (error) {
    console.error('Unhandled complete-booking error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
