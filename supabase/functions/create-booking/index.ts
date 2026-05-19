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
  message?: string;
  price?: number | string;
  consentAccepted?: boolean;
  formStartedAt?: string;
  website?: string;
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

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, '');
}

function parsePriceNumber(value: number | string | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value || '').replace(/\s/g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSek(value: number | null) {
  return value === null ? 'Ej angivet' : `${Math.round(value).toLocaleString('sv-SE')} kr`;
}

function isSuspiciouslyFastSubmission(startedAt: string | undefined) {
  const startedTime = Number(startedAt || 0);
  return Number.isFinite(startedTime) && startedTime > 0 && Date.now() - startedTime < 1200;
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

    if (!payload.name || !payload.email || !payload.phone || !payload.boatSize || !payload.date || !payload.time || !payload.location) {
      return jsonResponse({ error: 'Missing required booking fields' }, 400);
    }

    if (payload.website || isSuspiciouslyFastSubmission(payload.formStartedAt)) {
      return jsonResponse({
        success: true,
        bookingId: null,
        customerEmailSent: false,
        stripeCheckoutUrl: null,
        stripeCheckoutSessionId: null
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL') || 'bokning@bergafonsterputs.se';
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    const contactPhone = Deno.env.get('BOOKING_CONTACT_PHONE') || '073-388 12 16';
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const rutFormUrl = Deno.env.get('BOOKING_RUT_FORM_URL') || '';
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing', {
        hasSupabaseUrl: Boolean(supabaseUrl),
        hasServiceRoleKey: Boolean(serviceRoleKey)
      });
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    if (!resendApiKey || !fromEmail) {
      console.error('Email secrets are missing', {
        hasResendApiKey: Boolean(resendApiKey),
        hasFromEmail: Boolean(fromEmail),
        notificationEmail,
        contactEmail
      });
      return jsonResponse({ error: 'Email secrets are missing' }, 500);
    }

    const existingBookingRes = await fetch(
      `${supabaseUrl}/rest/v1/bookings?select=id&booking_date=eq.${encodeURIComponent(payload.date)}&booking_time=eq.${encodeURIComponent(payload.time)}&status=in.(pending,confirmed)&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!existingBookingRes.ok) {
      console.error('Could not check existing bookings', await existingBookingRes.text());
      return jsonResponse({ error: 'Could not check booking availability' }, 500);
    }

    const existingBookings = await existingBookingRes.json();
    if (Array.isArray(existingBookings) && existingBookings.length) {
      return jsonResponse({ error: 'Den valda tiden är redan bokad. Välj en annan tid.' }, 409);
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const normalizedPhone = normalizePhone(payload.phone);
    const rateLimitParts = [
      `email=eq.${encodeURIComponent(payload.email.trim())}`,
      normalizedPhone ? `phone=eq.${encodeURIComponent(normalizedPhone)}` : ''
    ].filter(Boolean);

    if (rateLimitParts.length) {
      const rateLimitRes = await fetch(
        `${supabaseUrl}/rest/v1/bookings?select=id&created_at=gte.${encodeURIComponent(oneHourAgo)}&or=(${rateLimitParts.join(',')})&limit=4`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (rateLimitRes.ok) {
        const recentBookings = await rateLimitRes.json();
        if (Array.isArray(recentBookings) && recentBookings.length >= 3) {
          return jsonResponse({ error: 'För många bokningsförsök på kort tid. Testa igen lite senare eller kontakta oss.' }, 429);
        }
      } else {
        console.error('Could not check booking rate limit', await rateLimitRes.text());
      }
    }

    const bookingInsert = {
      customer_name: payload.name,
      email: payload.email,
      phone: normalizedPhone || payload.phone,
      housing_type: payload.housingType || payload.boatSize,
      window_count: payload.windowCount || null,
      service_scope: payload.serviceScope || null,
      payment_method: payload.paymentMethod || null,
      addons: payload.addons || null,
      transport_type: payload.transportType || 'Fastland',
      sea_miles: payload.seaMiles || null,
      coordinates: payload.coordinates || null,
      booking_date: payload.date,
      booking_time: payload.time,
      address: payload.location,
      message: payload.message || null,
      price: payload.price ? String(payload.price) : null,
      rut_choice: payload.rutChoice || payload.rut_choice || null,
      consent_accepted: Boolean(payload.consentAccepted),
      status: 'pending',
      payment_status: 'unpaid'
    };

    let bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=id`, {
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
      if (/rut_choice|schema cache|column/i.test(errorText)) {
        const fallbackInsert = { ...bookingInsert };
        delete (fallbackInsert as Record<string, unknown>).rut_choice;
        bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=id`, {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
          },
          body: JSON.stringify(fallbackInsert)
        });
      }
    }

    if (!bookingRes.ok) {
      const errorText = await bookingRes.text();
      console.error('Could not save booking', errorText);
      return jsonResponse({ error: 'Could not save booking', details: errorText }, 500);
    }

    const [savedBooking] = await bookingRes.json();

    const safeMessage = payload.message ? escapeHtml(payload.message).replaceAll('\n', '<br>') : 'Ingen extra information';
    const safeHousingType = payload.housingType ? escapeHtml(payload.housingType) : escapeHtml(payload.boatSize);
    const safeWindowCount = payload.windowCount ? escapeHtml(payload.windowCount) : 'Ej angivet';
    const safeServiceScope = payload.serviceScope ? escapeHtml(payload.serviceScope) : 'Ej angivet';
    const safePaymentMethod = payload.paymentMethod ? escapeHtml(payload.paymentMethod) : 'Ej angivet';
    const rawRutChoice = payload.rutChoice || payload.rut_choice || '';
    const safeRutChoice = rawRutChoice ? escapeHtml(rawRutChoice) : 'Ej angivet';
    const safeAddons = payload.addons ? escapeHtml(payload.addons).replaceAll('\n', '<br>') : 'Inga tillägg';
    const safeTransportType = payload.transportType ? escapeHtml(payload.transportType) : 'Fastland';
    const safeSeaMiles = payload.seaMiles ? escapeHtml(payload.seaMiles) : 'Ej angivet';
    const safeCoordinates = payload.coordinates ? escapeHtml(payload.coordinates) : 'Ej angivet';
    const safePrice = escapeHtml(String(payload.price || 'Ej angivet'));
    const safePriceDisplay = /^\d+$/.test(String(payload.price || '')) ? `${safePrice} kr` : safePrice;
    const safeRutFormUrl = rutFormUrl ? escapeHtml(rutFormUrl) : '';
    const logoUrl = `${siteUrl}/logga-fonsterputs-transparent.png`;
    const safeLogoUrl = escapeHtml(logoUrl);
    const safeContactEmail = escapeHtml(contactEmail);
    const safeContactPhone = escapeHtml(contactPhone);
    const priceAfterRutNumber = parsePriceNumber(payload.price);
    const priceBeforeRutNumber = priceAfterRutNumber === null ? null : priceAfterRutNumber * 2;
    const rutDeductionNumber = priceAfterRutNumber;
    const priceBeforeRutDisplay = formatSek(priceBeforeRutNumber);
    const rutDeductionDisplay = rutDeductionNumber === null ? 'Ej angivet' : `-${formatSek(rutDeductionNumber)}`;
    const priceAfterRutDisplay = priceAfterRutNumber === null ? safePriceDisplay : formatSek(priceAfterRutNumber);
    const customerDetailRows = [
      ['Datum', escapeHtml(payload.date || 'Ej angivet')],
      ['Tid', escapeHtml(payload.time || 'Ej angivet')],
      ['Adress', escapeHtml(payload.location || 'Ej angivet')],
      ['Typ av bostad', safeHousingType || 'Ej angivet'],
      ['Tjänst', safeServiceScope],
      ['Antal fönster / glaspartier', safeWindowCount],
      ['Tillägg', safeAddons],
      ['Transport', safeTransportType],
      ...(payload.seaMiles ? [['Sjömil', safeSeaMiles]] : []),
      ...(payload.coordinates ? [['Koordinater', safeCoordinates]] : [])
    ].map(([label, value]) => `
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #5b6b7a; font-size: 14px; vertical-align: top;">${label}</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #0f2638; font-size: 14px; font-weight: 700; text-align: right; vertical-align: top;">${value || 'Ej angivet'}</td>
          </tr>
        `).join('');
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
          <tr><td style="padding: 8px 0; font-weight: 700;">RUT-val</td><td style="padding: 8px 0;">${safeRutChoice}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Antal fönster / glaspartier</td><td style="padding: 8px 0;">${safeWindowCount}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Putsning</td><td style="padding: 8px 0;">${safeServiceScope}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Transport</td><td style="padding: 8px 0;">${safeTransportType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Sjömil från Svinnige marina</td><td style="padding: 8px 0;">${safeSeaMiles}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Koordinater</td><td style="padding: 8px 0;">${safeCoordinates}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Betalningsmetod</td><td style="padding: 8px 0;">${safePaymentMethod}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tillägg</td><td style="padding: 8px 0;">${safeAddons}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Pris</td><td style="padding: 8px 0;">${safePriceDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700; vertical-align: top;">Meddelande</td><td style="padding: 8px 0;">${safeMessage}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Samtycke</td><td style="padding: 8px 0;">${payload.consentAccepted ? 'Ja' : 'Nej'}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Boknings-ID</td><td style="padding: 8px 0;">${escapeHtml(String(savedBooking?.id || 'okänt'))}</td></tr>
        </table>
      </div>
    `;

    const customerEmailHtml = `
      <div style="margin: 0; padding: 0; background: #f3f6f8; font-family: Arial, Helvetica, sans-serif; color: #0f2638;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; background: #f3f6f8;">
          <tr>
            <td align="center" style="padding: 28px 12px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 680px; border-collapse: collapse;">
                <tr>
                  <td style="background: #0f2638; border-radius: 18px 18px 0 0; padding: 28px 24px 20px; text-align: center;">
                    <img src="${safeLogoUrl}" width="118" alt="Berga Fönsterputs" style="display: block; width: 118px; max-width: 118px; height: auto; margin: 0 auto 18px;">
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
                  <td style="background: #ffffff; padding: 34px 26px 12px;">
                    <h1 style="margin: 0 0 12px; color: #0f2638; font-size: 30px; line-height: 1.18; font-weight: 800;">Tack för din bokning!</h1>
                    <p style="margin: 0 0 8px; color: #173042; font-size: 17px; line-height: 1.6;">Hej ${escapeHtml(payload.name || '')},</p>
                    <p style="margin: 0; color: #536574; font-size: 15px; line-height: 1.7;">Vi har tagit emot din bokning och ser fram emot att hjälpa dig.</p>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 20px 26px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px 20px 6px;">
                          <h2 style="margin: 0 0 6px; color: #0f2638; font-size: 18px; line-height: 1.3;">Bokningsdetaljer</h2>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            ${customerDetailRows}
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 26px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #d7e7dd; border-radius: 14px; background: #f7fbf8;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 14px; color: #0f2638; font-size: 18px; line-height: 1.3;">Pris med RUT</h2>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Pris före RUT</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${priceBeforeRutDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Beräknat RUT-avdrag 50%</td>
                              <td align="right" style="padding: 9px 0; color: #287a45; font-size: 15px; font-weight: 700;">${rutDeductionDisplay}</td>
                            </tr>
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 12px; border-collapse: collapse; background: #247a43; border-radius: 12px;">
                            <tr>
                              <td style="padding: 18px 18px; color: #ffffff; font-size: 15px; font-weight: 700;">Att betala efter RUT</td>
                              <td align="right" style="padding: 18px 18px; color: #ffffff; font-size: 26px; line-height: 1.1; font-weight: 800;">${priceAfterRutDisplay}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                    ${rutFormSection}
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 26px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 20px; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                          <h2 style="margin: 0 0 12px; color: #0f2638; font-size: 18px;">Inför besöket</h2>
                          <ul style="margin: 0; padding-left: 20px; color: #536574; font-size: 14px; line-height: 1.7;">
                            <li>Plocka undan föremål nära fönster.</li>
                            <li>Säkerställ att vi kommer åt fönstren.</li>
                            <li>Meddela oss om något fönster är skadat eller svårt att nå.</li>
                          </ul>
                          <p style="margin: 14px 0 0; padding: 12px 14px; background: #eef3f6; border-left: 4px solid #0f2638; color: #173042; font-size: 13px; line-height: 1.6;">Vi utför endast arbete som kan genomföras säkert från mark, normal hushållsstege eller inifrån bostaden.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 26px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 20px; background: #0f2638; border-radius: 14px;">
                          <h2 style="margin: 0 0 12px; color: #ffffff; font-size: 18px;">Betalning</h2>
                          <p style="margin: 0 0 14px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Betalning sker efter utfört arbete.</p>
                          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            <tr>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Swish</td>
                              <td style="width: 8px;"></td>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Kort</td>
                              <td style="width: 8px;"></td>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Faktura</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 26px 30px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Frågor?</h2>
                          <p style="margin: 0 0 12px; color: #536574; font-size: 14px; line-height: 1.7;">Svara direkt på detta mail om du har frågor eller vill ändra din bokning.</p>
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
          reply_to: contactEmail
        })
      });

      if (!customerEmailRes.ok) {
        const customerErrorText = await customerEmailRes.text();
        console.error('Customer confirmation email failed', customerErrorText);
      } else {
        customerEmailSent = true;
      }
    }

    if (customerEmailSent && savedBooking?.id) {
      await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(savedBooking.id)}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          confirmation_email_sent: true,
          confirmation_email_sent_at: new Date().toISOString()
        })
      });
    }

    return jsonResponse({
      success: true,
      bookingId: savedBooking?.id || null,
      customerEmailSent,
      stripeCheckoutUrl: null,
      stripeCheckoutSessionId: null
    });
  } catch (error) {
    console.error('Unhandled create-booking error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
