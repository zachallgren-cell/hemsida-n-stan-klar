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
    console.log('complete-booking invoked', payload);

    if (!payload.bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
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

    const updateBody: Record<string, unknown> = {
      status: 'completed',
      payment_method: paymentMethod,
      completed_at: completedAt
    };

    if (stripeCheckout) {
      updateBody.payment_provider = 'stripe';
      updateBody.stripe_product_id = stripeCheckout.productId;
      updateBody.stripe_price_id = stripeCheckout.priceId;
      updateBody.stripe_checkout_session_id = stripeCheckout.sessionId;
      updateBody.stripe_payment_intent_id = stripeCheckout.paymentIntentId;
      updateBody.stripe_payment_url = stripeCheckout.url;
      updateBody.stripe_checkout_expires_at = stripeCheckout.expiresAt;
    }

    const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${payload.bookingId}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateBody)
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      console.error('Could not update booking', errorText);
      return jsonResponse({ error: 'Could not update booking', details: errorText }, 500);
    }

    const paymentInstructions = paymentMethod === 'Faktura via e-post'
      ? `
        <p>Vi skickar faktura via e-post inom 3-7 dagar.</p>
      `
      : isAlreadyPaid
        ? `
          <p>Betalningen är redan mottagen via Stripe. Tack!</p>
        `
      : stripePaymentUrl
        ? `
          <p>Du kan betala tryggt med kort via Stripe.</p>
          <p><a href="${escapeHtml(stripePaymentUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#0b6fa4;color:#ffffff;text-decoration:none;font-weight:800;">Betala säkert via Stripe</a></p>
        `
        : `
          <p>Vi skickar en betalningslänk via Stripe när den är redo.</p>
        `;

    const reviewSection = reviewUrl
      ? `
        <div style="margin-top: 22px;">
          <p>Om du är nöjd blir vi jätteglada om du vill lämna en recension.</p>
          <p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#ffac37;color:#18364b;text-decoration:none;font-weight:800;">Lämna recension</a></p>
        </div>
      `
      : '';

    const summaryParts = [
      booking.housing_type,
      booking.window_count,
      booking.service_scope,
      booking.addons,
      booking.transport_type,
      booking.sea_miles ? `Sjömil från Svinnige marina: ${booking.sea_miles}` : '',
      booking.coordinates ? `Koordinater: ${booking.coordinates}` : ''
    ].filter(Boolean).join(' • ');

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; color: #173042; line-height: 1.7;">
        <h2 style="margin-bottom: 12px;">Tack! Fönsterputsningen är nu klar</h2>
        <p>Hej ${escapeHtml(booking.customer_name || '')},</p>
        <p>Vi har nu slutfört jobbet och här kommer betalningsinformationen.</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 680px;">
          <tr><td style="padding: 8px 0; font-weight: 700;">Datum</td><td style="padding: 8px 0;">${escapeHtml(booking.booking_date || '')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tid</td><td style="padding: 8px 0;">${escapeHtml(booking.booking_time || '')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Adress</td><td style="padding: 8px 0;">${escapeHtml(booking.address || '')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Paket</td><td style="padding: 8px 0;">${escapeHtml(summaryParts || 'Ej angivet')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Pris</td><td style="padding: 8px 0;">${escapeHtml(String(booking.price || 'Ej angivet'))}</td></tr>
        </table>
        <div style="margin-top: 18px;">
          ${paymentInstructions}
        </div>
        ${reviewSection}
        <p style="margin-top: 24px;">Om du har frågor kan du svara på detta mail eller kontakta oss på <strong>${escapeHtml(contactEmail)}</strong>.</p>
        <p>Med vänliga hälsningar,<br><strong>Berga Fönsterputs</strong></p>
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

    console.log('Completion email sent', { bookingId: booking.id, paymentMethod });

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
