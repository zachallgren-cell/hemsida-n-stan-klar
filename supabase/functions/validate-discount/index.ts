const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type DiscountCode = {
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  starts_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  times_used: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function calculateDiscount(code: DiscountCode, originalPrice: number) {
  const rawDiscount = code.discount_type === 'percentage'
    ? Math.round(originalPrice * code.discount_value / 100)
    : code.discount_value;
  return Math.min(Math.max(rawDiscount, 0), Math.max(originalPrice - 1, 0));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const code = String(body?.code || '').trim().toUpperCase();
    const originalPrice = Math.round(Number(body?.originalPrice));

    if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !Number.isFinite(originalPrice) || originalPrice <= 0) {
      return jsonResponse({ valid: false, message: 'Rabattkoden är ogiltig.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    const now = new Date();
    const query = new URLSearchParams({
      select: 'discount_type,discount_value,starts_at,expires_at,max_uses,times_used',
      code: `eq.${code}`,
      active: 'eq.true',
      limit: '1'
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/discount_codes?${query.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Could not validate discount code', await response.text());
      return jsonResponse({ error: 'Kunde inte kontrollera rabattkoden.' }, 500);
    }

    const rows = await response.json();
    const discount = Array.isArray(rows) ? rows[0] as DiscountCode | undefined : undefined;

    const unavailable = !discount
      || (discount.starts_at && new Date(discount.starts_at) > now)
      || (discount.expires_at && new Date(discount.expires_at) <= now)
      || (discount.max_uses !== null && discount.times_used >= discount.max_uses);

    if (unavailable) {
      return jsonResponse({ valid: false, message: 'Rabattkoden är ogiltig eller har gått ut.' }, 404);
    }

    const discountAmount = calculateDiscount(discount!, originalPrice);

    return jsonResponse({
      valid: true,
      code,
      discountType: discount!.discount_type,
      discountValue: discount!.discount_value,
      discountAmount,
      finalPrice: originalPrice - discountAmount
    });
  } catch (error) {
    console.error('Unhandled validate-discount error', error);
    return jsonResponse({ error: 'Kunde inte kontrollera rabattkoden.' }, 500);
  }
});
