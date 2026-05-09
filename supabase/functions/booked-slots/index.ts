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

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    const bookingsRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=booking_date,booking_time&status=in.(pending,confirmed)`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!bookingsRes.ok) {
      const errorText = await bookingsRes.text();
      console.error('Could not fetch public booked slots', errorText);
      return jsonResponse({ error: 'Could not fetch booked slots' }, 500);
    }

    const bookings = await bookingsRes.json();

    return jsonResponse({
      bookings: bookings.map((booking: Record<string, unknown>) => ({
        date: booking.booking_date || '',
        time: booking.booking_time || ''
      }))
    });
  } catch (error) {
    console.error('Unhandled booked-slots error', error);
    return jsonResponse({ error: 'Unknown error' }, 500);
  }
});
