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

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing for rut-booking-details');
      return jsonResponse({ error: 'Server configuration saknas.' }, 500);
    }

    if (!/^[a-z0-9_-]{1,80}$/i.test(bookingId)) {
      return jsonResponse({ error: 'Ogiltigt boknings-ID.' }, 400);
    }

    const bookingRes = await fetch(
      `${supabaseUrl}/rest/v1/bookings?select=id,customer_name,email,phone,price,rut_choice&id=eq.${encodeURIComponent(bookingId)}&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!bookingRes.ok) {
      console.error('Could not fetch RUT booking details', await bookingRes.text());
      return jsonResponse({ error: 'Kunde inte hämta bokningsuppgifter.' }, 500);
    }

    const bookings = await bookingRes.json();
    const booking = Array.isArray(bookings) ? bookings[0] : null;

    if (!booking) {
      return jsonResponse({ error: 'Bokningen hittades inte.' }, 404);
    }

    const rutChoice = String(booking.rut_choice || '');
    if (rutChoice && !rutChoice.includes('Ja')) {
      return jsonResponse({ error: 'Bokningen är inte markerad för RUT.' }, 409);
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
