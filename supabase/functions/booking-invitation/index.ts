import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type InvitationPayload = {
  action?: string;
  email?: string;
  date?: string;
  token?: string;
  invitationId?: number | string;
  reservationId?: string;
};

type AdminIdentity = {
  userId: string;
  authHeader: string;
};

const SPRING_BOOKING_WINDOW_START = '2027-03-01';
const SPRING_BOOKING_WINDOW_END = '2027-06-15';
const SPRING_BOOKING_EXPIRES_AT = '2027-06-15T21:59:59Z';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0'
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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function isValidUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getJwtAssuranceLevel(authHeader: string) {
  try {
    const token = authHeader.replace(/^bearer\s+/i, '');
    const payloadPart = token.split('.')[1] || '';
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return String(payload?.aal || 'aal1');
  } catch {
    return 'invalid';
  }
}

function getStockholmDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidInvitationDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  if (![0, 6].includes(parsed.getUTCDay())) return false;
  const today = getStockholmDateString();
  return value >= addDays(today, 2) && value <= addDays(today, 365);
}

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function serviceHeaders(serviceRoleKey: string, prefer = '') {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function verifyAdmin(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<AdminIdentity | Response> {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Du måste vara inloggad som admin.' }, 401);
  }

  if (getJwtAssuranceLevel(authHeader) !== 'aal2') {
    return jsonResponse({ error: 'Tvåstegsverifiering krävs.', code: 'mfa_required' }, 403);
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authHeader }
  });
  if (!userRes.ok) return jsonResponse({ error: 'Adminsessionen kunde inte verifieras.' }, 401);
  const user = await userRes.json();
  const userId = String(user?.id || '');
  if (!userId) return jsonResponse({ error: 'Adminsessionen saknar användar-id.' }, 401);

  const publicApiKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey;
  const adminRes = await fetch(`${supabaseUrl}/rest/v1/rpc/is_booking_invitation_admin`, {
    method: 'POST',
    headers: {
      apikey: publicApiKey,
      Authorization: authHeader,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!adminRes.ok) return jsonResponse({ error: 'Adminbehörigheten kunde inte verifieras.' }, 403);
  if ((await adminRes.json().catch(() => false)) !== true) {
    return jsonResponse({ error: 'Tvåstegsverifierad adminbehörighet krävs.' }, 403);
  }

  return { userId, authHeader };
}

async function resolveInvitation(token: string, supabaseUrl: string, serviceRoleKey: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/booking_invitations?select=id,email,booking_date,invitation_type,window_start,window_end,expires_at,status&token_hash=eq.${tokenHash}&status=eq.active&expires_at=gt.${encodeURIComponent(now)}&limit=1`,
    { headers: serviceHeaders(serviceRoleKey) }
  );
  if (!response.ok) throw new Error('INVITATION_LOOKUP_FAILED');
  const [invitation] = await response.json();
  return invitation || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    let payload: InvitationPayload;
    try {
      payload = await readJsonWithLimit<InvitationPayload>(req, 16_384);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return jsonResponse({ error: 'För stor begäran.' }, 413);
      if (error instanceof InvalidJsonBodyError) return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      throw error;
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Serverkonfiguration saknas.' }, 500);

    const action = String(payload.action || '').trim();
    if (action === 'details') {
      const invitation = await resolveInvitation(String(payload.token || '').trim(), supabaseUrl, serviceRoleKey);
      if (!invitation) {
        return jsonResponse({ error: 'Inbjudningslänken är ogiltig, använd eller har gått ut.' }, 410);
      }
      return jsonResponse({
        active: true,
        email: invitation.email,
        date: invitation.booking_date,
        invitationType: invitation.invitation_type,
        windowStart: invitation.window_start,
        windowEnd: invitation.window_end,
        expiresAt: invitation.expires_at
      });
    }

    const admin = await verifyAdmin(req, supabaseUrl, serviceRoleKey);
    if (admin instanceof Response) return admin;

    if (action === 'list') {
      await fetch(
        `${supabaseUrl}/rest/v1/booking_invitations?status=eq.active&expires_at=lte.${encodeURIComponent(new Date().toISOString())}`,
        {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({ status: 'expired', updated_at: new Date().toISOString() })
        }
      );
      const response = await fetch(
        `${supabaseUrl}/rest/v1/booking_invitations?select=id,email,booking_date,status,expires_at,sent_at,completed_at,cancelled_at,booking_id,created_at&invitation_type=eq.reserved_date&order=created_at.desc&limit=50`,
        { headers: serviceHeaders(serviceRoleKey) }
      );
      if (!response.ok) return jsonResponse({ error: 'Inbjudningarna kunde inte hämtas.' }, 500);
      return jsonResponse({ invitations: await response.json() });
    }

    if (action === 'list-spring-reservations') {
      const [reservationsRes, invitationsRes] = await Promise.all([
        fetch(
          `${supabaseUrl}/rest/v1/spring_2027_reservations?select=id,name,email,phone,location,requested_period,service_interest,message,status,created_at,updated_at&order=created_at.desc&limit=500`,
          { headers: serviceHeaders(serviceRoleKey) }
        ),
        fetch(
          `${supabaseUrl}/rest/v1/booking_invitations?select=id,email,status,expires_at,sent_at,completed_at,cancelled_at,booking_id,created_at,spring_reservation_id&invitation_type=eq.spring_priority&spring_reservation_id=not.is.null&order=created_at.desc&limit=500`,
          { headers: serviceHeaders(serviceRoleKey) }
        )
      ]);
      if (!reservationsRes.ok || !invitationsRes.ok) {
        return jsonResponse({ error: 'Vårpaxningarna kunde inte hämtas.' }, 500);
      }

      const reservations = await reservationsRes.json();
      const invitations = await invitationsRes.json();
      const latestInvitationByReservation = new Map<string, Record<string, unknown>>();
      for (const invitation of Array.isArray(invitations) ? invitations : []) {
        const reservationId = String(invitation?.spring_reservation_id || '');
        if (reservationId && !latestInvitationByReservation.has(reservationId)) {
          latestInvitationByReservation.set(reservationId, invitation);
        }
      }

      return jsonResponse({
        reservations: (Array.isArray(reservations) ? reservations : []).map((reservation) => ({
          ...reservation,
          invitation: latestInvitationByReservation.get(String(reservation?.id || '')) || null
        }))
      });
    }

    if (action === 'create-spring-access') {
      const reservationId = String(payload.reservationId || '').trim();
      if (!isValidUuid(reservationId)) return jsonResponse({ error: 'Paxningen är ogiltig.' }, 400);
      if (Date.now() >= new Date(SPRING_BOOKING_EXPIRES_AT).getTime()) {
        return jsonResponse({ error: 'Bokningsperioden för våren 2027 har passerat.' }, 409);
      }

      await fetch(
        `${supabaseUrl}/rest/v1/booking_invitations?spring_reservation_id=eq.${reservationId}&invitation_type=eq.spring_priority&status=eq.active&expires_at=lte.${encodeURIComponent(new Date().toISOString())}`,
        {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({ status: 'expired', updated_at: new Date().toISOString() })
        }
      );

      const reservationRes = await fetch(
        `${supabaseUrl}/rest/v1/spring_2027_reservations?select=id,name,email,status&id=eq.${reservationId}&limit=1`,
        { headers: serviceHeaders(serviceRoleKey) }
      );
      if (!reservationRes.ok) return jsonResponse({ error: 'Paxningen kunde inte hämtas.' }, 500);
      const [reservation] = await reservationRes.json();
      if (!reservation) return jsonResponse({ error: 'Paxningen finns inte.' }, 404);
      if (['booked', 'declined', 'archived'].includes(String(reservation.status || ''))) {
        return jsonResponse({ error: 'Den här paxningen kan inte öppnas för bokning i sin nuvarande status.' }, 409);
      }

      const activeAccessRes = await fetch(
        `${supabaseUrl}/rest/v1/booking_invitations?select=id&spring_reservation_id=eq.${reservationId}&invitation_type=eq.spring_priority&status=eq.active&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
        { headers: serviceHeaders(serviceRoleKey) }
      );
      if (!activeAccessRes.ok) return jsonResponse({ error: 'Bokningsåtkomsten kunde inte kontrolleras.' }, 500);
      if ((await activeAccessRes.json()).length) {
        return jsonResponse({ error: 'En aktiv bokningslänk är redan skickad till kunden.' }, 409);
      }

      const email = String(reservation.email || '').trim().toLowerCase();
      const name = String(reservation.name || '').trim();
      if (!isValidEmail(email)) return jsonResponse({ error: 'Paxningen saknar en giltig e-postadress.' }, 409);

      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
      const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
      const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');
      if (!resendApiKey || !fromEmail) return jsonResponse({ error: 'E-postkonfiguration saknas.' }, 500);

      const token = createToken();
      const tokenHash = await sha256Hex(token);
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/booking_invitations?select=id`, {
        method: 'POST',
        headers: serviceHeaders(serviceRoleKey, 'return=representation'),
        body: JSON.stringify({
          email,
          booking_date: null,
          invitation_type: 'spring_priority',
          window_start: SPRING_BOOKING_WINDOW_START,
          window_end: SPRING_BOOKING_WINDOW_END,
          spring_reservation_id: reservationId,
          token_hash: tokenHash,
          expires_at: SPRING_BOOKING_EXPIRES_AT,
          created_by: admin.userId
        })
      });
      if (!insertRes.ok) {
        const errorText = await insertRes.text();
        if (/duplicate|unique/i.test(errorText)) {
          return jsonResponse({ error: 'En aktiv bokningslänk är redan skickad till kunden.' }, 409);
        }
        console.error('Could not create spring booking access', errorText);
        return jsonResponse({ error: 'Bokningslänken kunde inte skapas.' }, 500);
      }

      const [savedInvitation] = await insertRes.json();
      const invitationUrl = `${siteUrl}/bokning.html?invite=${encodeURIComponent(token)}`;
      const safeInvitationUrl = escapeHtml(invitationUrl);
      const safeName = escapeHtml(name || 'Hej');
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `spring-booking-access-${savedInvitation?.id || tokenHash.slice(0, 16)}`
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [email],
          subject: 'Nu kan du boka din helg våren 2027 – Berga Fönsterputs',
          reply_to: contactEmail,
          html: `
            <div style="margin:0;padding:28px 16px;background:#f3f6f8;font-family:Arial,sans-serif;color:#173042;">
              <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 14px 34px rgba(15,38,56,.12);">
                <div style="padding:24px;background:#0f2638;color:#fff;text-align:center;">
                  <h1 style="margin:0;font-size:25px;">Välj din helg våren 2027</h1>
                </div>
                <div style="padding:30px;">
                  <p style="margin:0 0 14px;font-size:16px;line-height:1.7;">Hej ${safeName}!</p>
                  <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">Du som har paxat en plats får nu välja en ledig lördag eller söndag mellan 1 mars och 15 juni 2027.</p>
                  <p style="margin:0 0 24px;color:#536574;line-height:1.7;">Öppna din personliga länk, välj en ledig helg och fyll i resten av bokningsuppgifterna. Länken kan användas en gång.</p>
                  <p style="margin:0 0 24px;text-align:center;"><a href="${safeInvitationUrl}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#247a43;color:#fff;font-weight:700;text-decoration:none;">VÄLJ HELG OCH BOKA</a></p>
                  <div style="margin:22px 0 0;padding:18px;background:#fff4df;border:1px solid #e6a23c;border-radius:12px;color:#3f321f;line-height:1.7;">
                    <strong style="color:#173042;">Viktigt inför besöket</strong>
                    <p style="margin:7px 0 0;">Töm alla fönsterbrädor helt och flytta undan sådant som står i vägen, så att alla fönster är fria, åtkomliga och går att öppna när vi kommer.</p>
                  </div>
                  <p style="margin:18px 0 0;color:#6a7885;font-size:13px;line-height:1.6;">Länken är personlig. Vid frågor kan du svara på det här mejlet.</p>
                </div>
              </div>
            </div>`
        })
      });

      if (!emailRes.ok) {
        console.error('Spring booking access email failed', await emailRes.text());
        await fetch(`${supabaseUrl}/rest/v1/booking_invitations?id=eq.${savedInvitation?.id || 0}`, {
          method: 'DELETE',
          headers: serviceHeaders(serviceRoleKey)
        });
        return jsonResponse({ error: 'Mejlet kunde inte skickas och länken sparades därför inte.' }, 502);
      }

      const now = new Date().toISOString();
      await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/booking_invitations?id=eq.${savedInvitation?.id || 0}`, {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({ sent_at: now, updated_at: now })
        }),
        fetch(`${supabaseUrl}/rest/v1/spring_2027_reservations?id=eq.${reservationId}`, {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({ status: 'invited', updated_at: now })
        })
      ]);

      return jsonResponse({
        success: true,
        invitationId: savedInvitation?.id || null,
        reservationId,
        email,
        windowStart: SPRING_BOOKING_WINDOW_START,
        windowEnd: SPRING_BOOKING_WINDOW_END
      });
    }

    if (action === 'cancel') {
      const invitationId = Number(payload.invitationId);
      if (!Number.isSafeInteger(invitationId) || invitationId <= 0) {
        return jsonResponse({ error: 'Inbjudningen är ogiltig.' }, 400);
      }
      const response = await fetch(
        `${supabaseUrl}/rest/v1/booking_invitations?id=eq.${invitationId}&status=eq.active`,
        {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey, 'return=representation'),
          body: JSON.stringify({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }
      );
      if (!response.ok) return jsonResponse({ error: 'Inbjudningen kunde inte avbrytas.' }, 500);
      const updated = await response.json();
      if (!Array.isArray(updated) || !updated.length) {
        return jsonResponse({ error: 'Inbjudningen är redan avslutad.' }, 409);
      }
      const springReservationId = String(updated[0]?.spring_reservation_id || '');
      if (springReservationId) {
        await fetch(`${supabaseUrl}/rest/v1/spring_2027_reservations?id=eq.${springReservationId}&status=eq.invited`, {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({ status: 'paxed', updated_at: new Date().toISOString() })
        });
      }
      return jsonResponse({ success: true });
    }

    if (action !== 'create') return jsonResponse({ error: 'Ogiltig åtgärd.' }, 400);

    const email = String(payload.email || '').trim().toLowerCase();
    const bookingDate = String(payload.date || '').trim();
    if (!isValidEmail(email)) return jsonResponse({ error: 'Ange en giltig e-postadress.' }, 400);
    if (!isValidInvitationDate(bookingDate)) {
      return jsonResponse({ error: 'Välj en lördag eller söndag mellan två dagar och tolv månader framåt.' }, 400);
    }

    const blockedRes = await fetch(
      `${supabaseUrl}/rest/v1/booking_blocked_dates?select=id&blocked_date=eq.${bookingDate}&limit=1`,
      { headers: serviceHeaders(serviceRoleKey) }
    );
    if (!blockedRes.ok) return jsonResponse({ error: 'Datumets tillgänglighet kunde inte kontrolleras.' }, 500);
    if ((await blockedRes.json()).length) return jsonResponse({ error: 'Datumet är spärrat i kalendern.' }, 409);

    const [bookingsRes, invitationsRes, capacityRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/bookings?select=id&booking_date=eq.${bookingDate}&status=in.(pending,confirmed)`, {
        headers: serviceHeaders(serviceRoleKey)
      }),
      fetch(`${supabaseUrl}/rest/v1/booking_invitations?select=id&invitation_type=eq.reserved_date&booking_date=eq.${bookingDate}&status=eq.active&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`, {
        headers: serviceHeaders(serviceRoleKey)
      }),
      fetch(`${supabaseUrl}/rest/v1/booking_capacity_overrides?select=extra_bookings&booking_date=eq.${bookingDate}&limit=1`, {
        headers: serviceHeaders(serviceRoleKey)
      })
    ]);
    if (!bookingsRes.ok || !invitationsRes.ok || !capacityRes.ok) {
      return jsonResponse({ error: 'Datumets kapacitet kunde inte kontrolleras.' }, 500);
    }
    const bookings = await bookingsRes.json();
    const invitations = await invitationsRes.json();
    const capacityOverrides = await capacityRes.json();
    const extraBookings = Array.isArray(capacityOverrides) && capacityOverrides.length
      ? Math.min(3, Math.max(1, Number(capacityOverrides[0]?.extra_bookings) || 1))
      : 0;
    if (bookings.length + invitations.length >= 1 + extraBookings) {
      return jsonResponse({ error: 'Datumet är redan fullbokat eller reserverat.' }, 409);
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');
    if (!resendApiKey || !fromEmail) return jsonResponse({ error: 'E-postkonfiguration saknas.' }, 500);

    const token = createToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(`${bookingDate}T23:59:59Z`).toISOString();
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/booking_invitations?select=id`, {
      method: 'POST',
      headers: serviceHeaders(serviceRoleKey, 'return=representation'),
      body: JSON.stringify({
        email,
        booking_date: bookingDate,
        invitation_type: 'reserved_date',
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: admin.userId
      })
    });
    if (!insertRes.ok) {
      const errorText = await insertRes.text();
      if (/booking_date_unavailable|duplicate|unique/i.test(errorText)) {
        return jsonResponse({ error: 'Datumet hann bli reserverat. Välj ett annat datum.' }, 409);
      }
      console.error('Could not create booking invitation', errorText);
      return jsonResponse({ error: 'Inbjudningen kunde inte skapas.' }, 500);
    }
    const [savedInvitation] = await insertRes.json();
    const invitationUrl = `${siteUrl}/bokning.html?invite=${encodeURIComponent(token)}`;
    const safeInvitationUrl = escapeHtml(invitationUrl);
    const safeDate = escapeHtml(formatDate(bookingDate));

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `booking-invitation-${savedInvitation?.id || tokenHash.slice(0, 16)}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `Ditt reserverade datum hos Berga Fönsterputs – ${bookingDate}`,
        reply_to: contactEmail,
        html: `
          <div style="margin:0;padding:28px 16px;background:#f3f6f8;font-family:Arial,sans-serif;color:#173042;">
            <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 14px 34px rgba(15,38,56,.12);">
              <div style="padding:24px;background:#0f2638;color:#fff;text-align:center;">
                <h1 style="margin:0;font-size:25px;">Ett datum är reserverat åt dig</h1>
              </div>
              <div style="padding:30px;">
                <p style="margin:0 0 14px;font-size:16px;line-height:1.7;">Berga Fönsterputs har reserverat <strong>${safeDate}</strong> för dig.</p>
                <p style="margin:0 0 22px;color:#536574;line-height:1.7;">Öppna den personliga länken, välj starttid och fyll i resten av bokningsuppgifterna. Datumet hålls åt dig tills bokningen är slutförd eller datumet passerar.</p>
                <p style="margin:0 0 22px;text-align:center;"><a href="${safeInvitationUrl}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:#247a43;color:#fff;font-weight:700;text-decoration:none;">SLUTFÖR BOKNINGEN</a></p>
                <div style="margin:22px 0 0;padding:18px;background:#fff4df;border:1px solid #e6a23c;border-radius:12px;color:#3f321f;line-height:1.7;">
                  <strong style="color:#173042;">Viktigt inför besöket</strong>
                  <p style="margin:7px 0 0;">Töm alla fönsterbrädor helt och flytta undan sådant som står i vägen, så att alla fönster är fria, åtkomliga och går att öppna när vi kommer.</p>
                </div>
                <p style="margin:18px 0 0;color:#6a7885;font-size:13px;line-height:1.6;">Länken är personlig. Vid frågor kan du svara på det här mejlet.</p>
              </div>
            </div>
          </div>`
      })
    });

    if (!emailRes.ok) {
      console.error('Booking invitation email failed', await emailRes.text());
      await fetch(`${supabaseUrl}/rest/v1/booking_invitations?id=eq.${savedInvitation?.id || 0}`, {
        method: 'DELETE',
        headers: serviceHeaders(serviceRoleKey)
      });
      return jsonResponse({ error: 'Mejlet kunde inte skickas och datumet reserverades därför inte.' }, 502);
    }

    await fetch(`${supabaseUrl}/rest/v1/booking_invitations?id=eq.${savedInvitation?.id || 0}`, {
      method: 'PATCH',
      headers: serviceHeaders(serviceRoleKey),
      body: JSON.stringify({ sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    });

    return jsonResponse({ success: true, invitationId: savedInvitation?.id || null, date: bookingDate, email });
  } catch (error) {
    console.error('Unhandled booking invitation error', error);
    return jsonResponse({ error: 'Inbjudningen kunde inte hanteras just nu.' }, 500);
  }
});
