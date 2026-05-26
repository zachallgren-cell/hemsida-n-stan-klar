const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
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

function parsePriceNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const match = String(value || '').replace(/\s/g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function isValidToken(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

async function fetchBooking(supabaseUrl: string, serviceRoleKey: string, bookingId: string, token: string) {
  const selectAttempts = [
    'id,customer_name,email,phone,price,rut_form_token',
    'id,customer_name,email,phone,rut_form_token',
    'id,email,phone,price,rut_form_token',
    'id,email,phone,rut_form_token'
  ];

  let lastError = '';

  for (const select of selectAttempts) {
    const bookingRes = await fetch(
      `${supabaseUrl}/rest/v1/bookings?select=${encodeURIComponent(select)}&id=eq.${encodeURIComponent(bookingId)}&rut_form_token=eq.${encodeURIComponent(token)}&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (bookingRes.ok) {
      const bookings = await bookingRes.json();
      return {
        booking: Array.isArray(bookings) ? bookings[0] : null,
        error: ''
      };
    }

    lastError = await bookingRes.text();
    console.error('Could not fetch RUT booking details with select', select, lastError);
  }

  return {
    booking: null,
    error: lastError || 'Unknown Supabase REST error'
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const url = new URL(req.url);
    const bookingId = url.searchParams.get('bookingId') || url.searchParams.get('booking') || '';
    const token = url.searchParams.get('token') || '';

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing for rut-booking-details');
      return jsonResponse({ error: 'Server configuration saknas.' }, 500);
    }

    if (!/^[a-z0-9_-]{1,80}$/i.test(bookingId)) {
      return jsonResponse({ error: 'Ogiltigt boknings-ID.' }, 400);
    }

    if (!isValidToken(token)) {
      return jsonResponse({ error: 'Ogiltig eller saknad säkerhetslänk.' }, 403);
    }

    const { booking, error } = await fetchBooking(supabaseUrl, serviceRoleKey, bookingId, token);

    if (error) {
      return jsonResponse({ error: 'Kunde inte hämta bokningsuppgifter.' }, 500);
    }

    if (!booking) {
      return jsonResponse({ error: 'Bokningen hittades inte eller länken är ogiltig.' }, 404);
    }

    return jsonResponse({
      bookingId: booking.id,
      name: booking.customer_name || '',
      email: booking.email || '',
      phone: booking.phone || '',
      rutAmount: parsePriceNumber(booking.price)
    });
  } catch (error) {
    console.error('Unhandled rut-booking-details error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Okänt fel.' }, 500);
  }
});
