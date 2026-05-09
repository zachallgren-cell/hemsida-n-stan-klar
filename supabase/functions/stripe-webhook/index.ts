const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature'
};

type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data?: {
    object?: {
      id?: string;
      client_reference_id?: string | null;
      payment_intent?: string | null;
      payment_status?: string | null;
      metadata?: Record<string, string>;
    };
  };
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

function parseStripeSignature(signatureHeader: string) {
  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) || '';
  const signatures = parts
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3));

  return { timestamp, signatures };
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function hmacSha256Hex(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyStripeSignature(rawBody: string, signatureHeader: string, webhookSecret: string) {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  const timestampNumber = Number(timestamp);

  if (!timestamp || !Number.isFinite(timestampNumber) || !signatures.length) {
    return false;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampNumber);
  if (ageSeconds > 300) {
    return false;
  }

  const expectedSignature = await hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => timingSafeEqual(signature, expectedSignature));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    if (!webhookSecret) {
      return jsonResponse({ error: 'Stripe webhook secret is missing' }, 500);
    }

    const rawBody = await req.text();
    const signatureHeader = req.headers.get('stripe-signature') || '';
    const isValid = await verifyStripeSignature(rawBody, signatureHeader, webhookSecret);

    if (!isValid) {
      return jsonResponse({ error: 'Invalid Stripe signature' }, 400);
    }

    const event = JSON.parse(rawBody) as StripeEvent;
    const session = event.data?.object;

    if (event.type !== 'checkout.session.completed') {
      return jsonResponse({ received: true, ignored: event.type });
    }

    if (session?.payment_status !== 'paid') {
      return jsonResponse({ received: true, ignored: `payment_status:${session?.payment_status || 'unknown'}` });
    }

    const bookingId = session?.metadata?.booking_id || session?.client_reference_id;

    if (!bookingId) {
      return jsonResponse({ error: 'Missing booking id on Stripe session' }, 400);
    }

    const paidAt = event.created
      ? new Date(event.created * 1000).toISOString()
      : new Date().toISOString();

    const updateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        payment_status: 'paid',
        payment_provider: 'stripe',
        payment_method: 'Stripe Checkout',
        stripe_checkout_session_id: session?.id || null,
        stripe_payment_intent_id: session?.payment_intent || null,
        stripe_paid_at: paidAt
      })
    });

    if (!updateRes.ok) {
      const errorText = await updateRes.text();
      console.error('Could not update booking from Stripe webhook', errorText);
      return jsonResponse({ error: 'Could not update booking', details: errorText }, 500);
    }

    return jsonResponse({
      received: true,
      bookingId,
      paymentStatus: session?.payment_status || 'paid'
    });
  } catch (error) {
    console.error('Unhandled Stripe webhook error', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
