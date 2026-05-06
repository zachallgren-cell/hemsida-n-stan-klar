const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type CompleteBookingPayload = {
  bookingId: number;
  paymentMethod?: string;
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
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL');
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const reviewUrl = Deno.env.get('BOOKING_REVIEW_URL') || '';

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    if (!resendApiKey || !notificationEmail || !fromEmail) {
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

    const paymentMethod = payload.paymentMethod || booking.payment_method || 'Stripe Checkout';
    const completedAt = new Date().toISOString();
    const stripePaymentUrl = booking.stripe_payment_url ? String(booking.stripe_payment_url) : '';

    const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${payload.bookingId}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status: 'completed',
        payment_method: paymentMethod,
        completed_at: completedAt
      })
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      console.error('Could not update booking', errorText);
      return jsonResponse({ error: 'Could not update booking', details: errorText }, 500);
    }

    if (!isValidEmail(booking.email || '')) {
      return jsonResponse({ error: 'Customer email is invalid for completion mail' }, 400);
    }

    const paymentInstructions = paymentMethod === 'Faktura via e-post'
      ? `
        <p>Vi skickar faktura via e-post inom 3-7 dagar.</p>
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
      booking.housing_type || booking.house_size,
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
          <tr><td style="padding: 8px 0; font-weight: 700;">Adress</td><td style="padding: 8px 0;">${escapeHtml(booking.address || booking.location || '')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Paket</td><td style="padding: 8px 0;">${escapeHtml(summaryParts || 'Ej angivet')}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Pris</td><td style="padding: 8px 0;">${escapeHtml(String(booking.price || 'Ej angivet'))}</td></tr>
        </table>
        <div style="margin-top: 18px;">
          ${paymentInstructions}
        </div>
        ${reviewSection}
        <p style="margin-top: 24px;">Om du har frågor kan du svara på detta mail eller kontakta oss på <strong>${escapeHtml(notificationEmail)}</strong>.</p>
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
        reply_to: notificationEmail
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
      paymentMethod
    });
  } catch (error) {
    console.error('Unhandled complete-booking error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
