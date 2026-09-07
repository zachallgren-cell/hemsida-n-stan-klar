import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type StaffPayload = {
  action?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  phone?: string;
  role?: string;
  skills?: string[];
};

type AdminIdentity = { userId: string };

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

function serviceHeaders(serviceRoleKey: string, prefer = '') {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function isValidUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeSkills(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0 && item.length <= 80))]
    .slice(0, 30);
}

async function verifyAdmin(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<AdminIdentity | Response> {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Du måste vara inloggad som admin.' }, 401);
  }
  if (getJwtAssuranceLevel(authHeader) !== 'aal2') {
    return jsonResponse({ error: 'Tvåstegsverifiering krävs.', code: 'mfa_required' }, 403);
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authHeader }
  });
  if (!userResponse.ok) return jsonResponse({ error: 'Adminsessionen kunde inte verifieras.' }, 401);
  const user = await userResponse.json();
  const userId = String(user?.id || '');
  if (!isValidUuid(userId)) return jsonResponse({ error: 'Adminsessionen saknar användar-id.' }, 401);

  const adminResponse = await fetch(
    `${supabaseUrl}/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: serviceHeaders(serviceRoleKey) }
  );
  if (!adminResponse.ok || !(await adminResponse.json()).length) {
    return jsonResponse({ error: 'Adminbehörighet krävs.' }, 403);
  }
  return { userId };
}

async function upsertProfile(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  payload: StaffPayload,
  invitedBy: string,
  status: 'invited' | 'active' = 'invited'
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/staff_profiles?on_conflict=user_id`, {
    method: 'POST',
    headers: serviceHeaders(serviceRoleKey, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify({
      user_id: userId,
      display_name: String(payload.displayName || '').trim(),
      email: String(payload.email || '').trim().toLowerCase(),
      phone: String(payload.phone || '').trim() || null,
      role: payload.role === 'supervisor' ? 'supervisor' : 'worker',
      status,
      skills: normalizeSkills(payload.skills),
      invited_by: invitedBy
    })
  });
  if (!response.ok) throw new Error(`PROFILE_WRITE_FAILED:${await response.text()}`);
  return (await response.json())[0];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    let payload: StaffPayload;
    try {
      payload = await readJsonWithLimit<StaffPayload>(req, 16_384);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return jsonResponse({ error: 'För stor begäran.' }, 413);
      if (error instanceof InvalidJsonBodyError) return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      throw error;
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/$/, '');
    if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Serverkonfiguration saknas.' }, 500);

    const admin = await verifyAdmin(req, supabaseUrl, serviceRoleKey);
    if (admin instanceof Response) return admin;
    const action = String(payload.action || '').trim();

    if (action === 'invite') {
      const email = String(payload.email || '').trim().toLowerCase();
      const displayName = String(payload.displayName || '').trim();
      if (!isValidEmail(email)) return jsonResponse({ error: 'Ange en giltig e-postadress.' }, 400);
      if (displayName.length < 1 || displayName.length > 160) return jsonResponse({ error: 'Ange personalens namn.' }, 400);

      const invitationResponse = await fetch(
        `${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(`${siteUrl}/personal.html`)}`,
        {
          method: 'POST',
          headers: serviceHeaders(serviceRoleKey),
          body: JSON.stringify({
            email,
            data: { display_name: displayName, account_type: 'staff' }
          })
        }
      );
      if (!invitationResponse.ok) {
        const errorBody = await invitationResponse.json().catch(() => ({}));
        const message = String(errorBody?.msg || errorBody?.message || 'Inbjudan kunde inte skickas.');
        return jsonResponse({ error: message }, invitationResponse.status === 422 ? 409 : 500);
      }
      const invitedUser = await invitationResponse.json();
      const userId = String(invitedUser?.id || '');
      if (!isValidUuid(userId)) return jsonResponse({ error: 'Inbjudan saknar användar-id.' }, 500);
      const profile = await upsertProfile(supabaseUrl, serviceRoleKey, userId, { ...payload, email, displayName }, admin.userId);
      return jsonResponse({ success: true, profile });
    }

    if (['deactivate', 'reactivate', 'update'].includes(action)) {
      const userId = String(payload.userId || '').trim();
      if (!isValidUuid(userId)) return jsonResponse({ error: 'Ogiltigt personal-id.' }, 400);
      const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (action === 'deactivate') {
        changes.status = 'inactive';
        changes.ended_on = new Date().toISOString().slice(0, 10);
      } else if (action === 'reactivate') {
        changes.status = 'active';
        changes.ended_on = null;
      } else {
        const displayName = String(payload.displayName || '').trim();
        if (displayName.length < 1 || displayName.length > 160) return jsonResponse({ error: 'Ange personalens namn.' }, 400);
        changes.display_name = displayName;
        changes.phone = String(payload.phone || '').trim() || null;
        changes.role = payload.role === 'supervisor' ? 'supervisor' : 'worker';
        changes.skills = normalizeSkills(payload.skills);
      }

      const response = await fetch(
        `${supabaseUrl}/rest/v1/staff_profiles?user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          headers: serviceHeaders(serviceRoleKey, 'return=representation'),
          body: JSON.stringify(changes)
        }
      );
      if (!response.ok) return jsonResponse({ error: 'Personalen kunde inte uppdateras.' }, 500);
      const [profile] = await response.json();
      if (!profile) return jsonResponse({ error: 'Personalen hittades inte.' }, 404);
      return jsonResponse({ success: true, profile });
    }

    return jsonResponse({ error: 'Okänd åtgärd.' }, 400);
  } catch (error) {
    console.error('staff-operations failed', error instanceof Error ? error.message : error);
    return jsonResponse({ error: 'Personalåtgärden kunde inte genomföras.' }, 500);
  }
});
