const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type BookingPayload = {
  name: string;
  email: string;
  phone: string;
  boatSize: string;
  housingType?: string;
  personalNumber?: string;
  rutChoice?: string;
  rut_choice?: string;
  windowCount?: string;
  serviceScope?: string;
  paymentMethod?: string;
  addons?: string;
  transportType?: string;
  seaMiles?: string;
  coordinates?: string;
  date: string;
  time: string;
  location: string;
  mapLink?: string;
  message?: string;
  price?: number | string;
  consentAccepted?: boolean;
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
    const payload = (await req.json()) as BookingPayload;
    console.log('create-booking invoked', {
      name: payload.name,
      email: payload.email,
      date: payload.date,
      time: payload.time
    });

    if (!payload.name || !payload.email || !payload.phone || !payload.boatSize || !payload.date || !payload.time || !payload.location) {
      console.error('Missing required booking fields', payload);
      return jsonResponse({ error: 'Missing required booking fields' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL');
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const rutFormUrl = Deno.env.get('BOOKING_RUT_FORM_URL') || '';

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing', {
        hasSupabaseUrl: Boolean(supabaseUrl),
        hasServiceRoleKey: Boolean(serviceRoleKey)
      });
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    if (!resendApiKey || !notificationEmail || !fromEmail) {
      console.error('Email secrets are missing', {
        hasResendApiKey: Boolean(resendApiKey),
        hasNotificationEmail: Boolean(notificationEmail),
        hasFromEmail: Boolean(fromEmail)
      });
      return jsonResponse({ error: 'Email secrets are missing' }, 500);
    }

    const bookingInsert = {
      customer_name: payload.name,
      email: payload.email,
      phone: payload.phone,
      house_size: payload.housingType || payload.boatSize,
      housing_type: payload.housingType || payload.boatSize,
      personal_number: payload.personalNumber || null,
      window_count: payload.windowCount || null,
      service_scope: payload.serviceScope || null,
      payment_method: payload.paymentMethod || null,
      addons: payload.addons || null,
      transport_type: payload.transportType || 'Fastland',
      sea_miles: payload.seaMiles || null,
      coordinates: payload.coordinates || null,
      booking_date: payload.date,
      booking_time: payload.time,
      service: 'Fönsterputs',
      address: payload.location,
      location: payload.location,
      map_link: payload.mapLink || null,
      message: payload.message || null,
      price: payload.price ? String(payload.price) : null,
      consent_accepted: Boolean(payload.consentAccepted),
      status: 'pending',
      payment_status: 'unpaid'
    };

    const bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=id`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(bookingInsert)
    });

    if (!bookingRes.ok) {
      const errorText = await bookingRes.text();
      console.error('Could not save booking', errorText);
      return jsonResponse({ error: 'Could not save booking', details: errorText }, 500);
    }

    const [savedBooking] = await bookingRes.json();
    const safeMessage = payload.message ? escapeHtml(payload.message).replaceAll('\n', '<br>') : 'Ingen extra information';
    const safeHousingType = payload.housingType ? escapeHtml(payload.housingType) : escapeHtml(payload.boatSize);
    const safePersonalNumber = payload.personalNumber ? escapeHtml(payload.personalNumber) : 'Ej angivet';
    const personalNumberRow = payload.personalNumber
      ? `<tr><td style="padding: 8px 0; font-weight: 700;">Personnummer</td><td style="padding: 8px 0;">${safePersonalNumber}</td></tr>`
      : '';
    const safeWindowCount = payload.windowCount ? escapeHtml(payload.windowCount) : 'Ej angivet';
    const safeServiceScope = payload.serviceScope ? escapeHtml(payload.serviceScope) : 'Ej angivet';
    const safePaymentMethod = payload.paymentMethod ? escapeHtml(payload.paymentMethod) : 'Ej angivet';
    const rawRutChoice = payload.rutChoice || payload.rut_choice || '';
    const safeRutChoice = rawRutChoice ? escapeHtml(rawRutChoice) : 'Ej angivet';
    const safeAddons = payload.addons ? escapeHtml(payload.addons).replaceAll('\n', '<br>') : 'Inga tillägg';
    const safeTransportType = payload.transportType ? escapeHtml(payload.transportType) : 'Fastland';
    const safeSeaMiles = payload.seaMiles ? escapeHtml(payload.seaMiles) : 'Ej angivet';
    const safeCoordinates = payload.coordinates ? escapeHtml(payload.coordinates) : 'Ej angivet';
    const safeMapLink = payload.mapLink ? `<a href="${escapeHtml(payload.mapLink)}">${escapeHtml(payload.mapLink)}</a>` : 'Ej angivet';
    const safePrice = escapeHtml(String(payload.price || 'Ej angivet'));
    const safePriceDisplay = /^\d+$/.test(String(payload.price || '')) ? `${safePrice} kr` : safePrice;
    const safeRutFormUrl = rutFormUrl ? escapeHtml(rutFormUrl) : '';
    const rutFormSection = rawRutChoice.includes('Ja')
      ? `
        <div style="margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: #f3fbff; border: 1px solid #bfddeb;">
          <p style="margin: 0 0 8px;"><strong>RUT-avdrag</strong></p>
          ${safeRutFormUrl
            ? `<p style="margin: 0;">Fyll i RUT-uppgifterna, till exempel personnummer, i vårt säkra formulär: <a href="${safeRutFormUrl}">${safeRutFormUrl}</a></p>`
            : '<p style="margin: 0;">Vi skickar en säker formulärlänk för RUT-uppgifterna innan jobbet utförs.</p>'}
        </div>
      `
      : rawRutChoice.includes('Nej')
        ? `
          <div style="margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: #fff8ec; border: 1px solid #ffd08b;">
            <p style="margin: 0;"><strong>RUT-avdrag:</strong> Du har valt att inte använda RUT-avdrag. Kontakta oss gärna om du vill dubbelkolla priset utan RUT.</p>
          </div>
        `
        : `
          <div style="margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: #fff8ec; border: 1px solid #ffd08b;">
            <p style="margin: 0;"><strong>RUT-avdrag:</strong> Vi kontaktar dig om RUT-valet behöver stämmas av.</p>
          </div>
        `;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; color: #173042; line-height: 1.6;">
        <h2 style="margin-bottom: 12px;">Ny bokning till Berga Fönsterputs</h2>
        <p>En ny bokning har precis kommit in via hemsidan.</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 680px;">
          <tr><td style="padding: 8px 0; font-weight: 700;">Namn</td><td style="padding: 8px 0;">${escapeHtml(payload.name)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">E-post</td><td style="padding: 8px 0;">${escapeHtml(payload.email)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Telefon</td><td style="padding: 8px 0;">${escapeHtml(payload.phone)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Adress</td><td style="padding: 8px 0;">${escapeHtml(payload.location)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Datum</td><td style="padding: 8px 0;">${escapeHtml(payload.date)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tid</td><td style="padding: 8px 0;">${escapeHtml(payload.time)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Typ av bostad</td><td style="padding: 8px 0;">${safeHousingType}</td></tr>
          ${personalNumberRow}
          <tr><td style="padding: 8px 0; font-weight: 700;">RUT-val</td><td style="padding: 8px 0;">${safeRutChoice}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Antal fönster / glaspartier</td><td style="padding: 8px 0;">${safeWindowCount}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Putsning</td><td style="padding: 8px 0;">${safeServiceScope}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Transport</td><td style="padding: 8px 0;">${safeTransportType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Sjömil från Svinnige marina</td><td style="padding: 8px 0;">${safeSeaMiles}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Koordinater</td><td style="padding: 8px 0;">${safeCoordinates}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Betalningsmetod</td><td style="padding: 8px 0;">${safePaymentMethod}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tillägg</td><td style="padding: 8px 0;">${safeAddons}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Google Maps</td><td style="padding: 8px 0;">${safeMapLink}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Pris</td><td style="padding: 8px 0;">${safePriceDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700; vertical-align: top;">Meddelande</td><td style="padding: 8px 0;">${safeMessage}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Samtycke</td><td style="padding: 8px 0;">${payload.consentAccepted ? 'Ja' : 'Nej'}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Boknings-ID</td><td style="padding: 8px 0;">${escapeHtml(String(savedBooking?.id || 'okänt'))}</td></tr>
        </table>
      </div>
    `;

    const customerEmailHtml = `
      <div style="font-family: Arial, sans-serif; color: #173042; line-height: 1.7;">
        <h2 style="margin-bottom: 12px;">Tack för din bokning hos Berga Fönsterputs</h2>
        <p>Vi har tagit emot din bokning och återkommer om något behöver stämmas av innan jobbet utförs.</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 680px;">
          <tr><td style="padding: 8px 0; font-weight: 700;">Namn</td><td style="padding: 8px 0;">${escapeHtml(payload.name)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Datum</td><td style="padding: 8px 0;">${escapeHtml(payload.date)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tid</td><td style="padding: 8px 0;">${escapeHtml(payload.time)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Adress</td><td style="padding: 8px 0;">${escapeHtml(payload.location)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Typ av bostad</td><td style="padding: 8px 0;">${safeHousingType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Antal fönster / glaspartier</td><td style="padding: 8px 0;">${safeWindowCount}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Putsning</td><td style="padding: 8px 0;">${safeServiceScope}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Transport</td><td style="padding: 8px 0;">${safeTransportType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Sjömil från Svinnige marina</td><td style="padding: 8px 0;">${safeSeaMiles}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Koordinater</td><td style="padding: 8px 0;">${safeCoordinates}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tillägg</td><td style="padding: 8px 0;">${safeAddons}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Pris</td><td style="padding: 8px 0;">${safePriceDisplay}</td></tr>
        </table>
        ${rutFormSection}
        <p style="margin-top: 20px;">Om du har frågor kan du svara på detta mail eller kontakta oss på <strong>${escapeHtml(notificationEmail)}</strong>.</p>
        <p>Med vänliga hälsningar,<br><strong>Berga Fönsterputs</strong></p>
      </div>
    `;

    const emailPayload: Record<string, unknown> = {
      from: fromEmail,
      to: [notificationEmail],
      subject: `Ny bokning ${payload.date} ${payload.time} - ${payload.name}`,
      html: emailHtml
    };

    if (isValidEmail(payload.email)) {
      emailPayload.reply_to = payload.email.trim();
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    });

    if (!emailRes.ok) {
      const errorText = await emailRes.text();
      console.error('Booking saved but email failed', errorText);
      return jsonResponse({
        error: 'Booking saved but email failed',
        details: errorText,
        bookingId: savedBooking?.id || null
      }, 502);
    }

    let customerEmailSent = false;

    if (isValidEmail(payload.email)) {
      const customerEmailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [payload.email.trim()],
          subject: `Din bokning hos Berga Fönsterputs ${payload.date} ${payload.time}`,
          html: customerEmailHtml,
          reply_to: notificationEmail
        })
      });

      if (!customerEmailRes.ok) {
        const customerErrorText = await customerEmailRes.text();
        console.error('Customer confirmation email failed', customerErrorText);
      } else {
        customerEmailSent = true;
      }
    }

    console.log('Booking saved and email sent', {
      bookingId: savedBooking?.id || null,
      customerEmailSent
    });

    return jsonResponse({
      success: true,
      bookingId: savedBooking?.id || null,
      customerEmailSent
    });
  } catch (error) {
    console.error('Unhandled create-booking error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
