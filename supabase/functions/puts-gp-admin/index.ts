// Administrative write boundary for BERGA PUTS-GP.
// The browser never receives a service-role credential and cannot write results directly.
const cors = {
  "Access-Control-Allow-Origin": "https://bergafonsterputs.se",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const clean = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const ms = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3_600_000 ? Number(value) : null;

function aal2(token: string) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal === "aal2"; } catch { return false; }
}

async function rest(url: string, key: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error("Databasåtgärden kunde inte genomföras.");
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "Metoden stöds inte." }, 405);
  const url = Deno.env.get("SUPABASE_URL") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!url || !service || !token || !aal2(token)) return json({ error: "Tvåstegsverifierad adminsession krävs." }, 401);

  try {
    const auth = await fetch(`${url}/auth/v1/user`, { headers: { apikey: service, Authorization: `Bearer ${token}` } });
    if (!auth.ok) return json({ error: "Ogiltig session." }, 401);
    const user = await auth.json();
    const admins = await rest(url, service, `admin_users?select=user_id&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    if (!admins?.length) return json({ error: "Adminbehörighet saknas." }, 403);

    const body = await request.json();
    const action = clean(body.action, 50);
    const eventId = clean(body.eventId, 80);
    const audit = async (entityType: string, entityId: string | null, previous: unknown, next: unknown) => rest(url, service, "puts_gp_audit_log", { method: "POST", body: JSON.stringify({ event_id: eventId || null, admin_user_id: user.id, action, entity_type: entityType, entity_id: entityId, previous_value: previous, new_value: next }) });

    if (action === "createEvent") {
      const name = clean(body.name, 120), date = clean(body.eventDate, 10);
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Ange namn och datum för eventet." }, 400);
      const [event] = await rest(url, service, "puts_gp_events", { method: "POST", body: JSON.stringify({ name, event_date: date, status: "ready" }) });
      await audit("event", event.id, null, { id: event.id, name });
      return json({ event });
    }

    if (action === "updateEvent") {
      if (!eventId) return json({ error: "Event saknas." }, 400);
      const existing = await rest(url, service, `puts_gp_events?select=*&id=eq.${encodeURIComponent(eventId)}&limit=1`);
      if (!existing?.[0]) return json({ error: "Eventet finns inte." }, 404);
      const next: Record<string, unknown> = {};
      if (["draft", "ready", "running", "paused", "finished"].includes(clean(body.status, 20))) next.status = clean(body.status, 20);
      if (body.settings && typeof body.settings === "object") next.settings = body.settings;
      if (!Object.keys(next).length) return json({ error: "Ingen ändring angavs." }, 400);
      const [event] = await rest(url, service, `puts_gp_events?id=eq.${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(next) });
      await audit("event", eventId, existing[0], event);
      return json({ event });
    }

    if (action === "createParticipant") {
      const fullName = clean(body.fullName, 160), phone = clean(body.phoneNumber, 32), displayName = clean(body.publicDisplayName, 80);
      const birthYear = Number(body.birthYear);
      if (!eventId || !fullName || !phone || !displayName || !Number.isInteger(birthYear) || birthYear < 1900 || birthYear > new Date().getFullYear()) return json({ error: "Kontrollera deltagaruppgifterna." }, 400);
      if (!body.termsAccepted) return json({ error: "Tävlingsvillkoren måste godkännas." }, 400);
      const [participant] = await rest(url, service, "puts_gp_participants", { method: "POST", body: JSON.stringify({ event_id: eventId, full_name: fullName, phone_number: phone, public_display_name: displayName, birth_year: birthYear, public_name_consent: Boolean(body.publicNameConsent), public_photo_consent: Boolean(body.publicPhotoConsent), photo_path: clean(body.photoPath, 240) || null, photo_public_url: Boolean(body.publicPhotoConsent) ? clean(body.photoPublicUrl, 500) || null : null, terms_consent_at: new Date().toISOString(), marketing_consent: Boolean(body.marketingConsent) }) });
      await audit("participant", participant.id, null, { id: participant.id });
      return json({ participant });
    }

    if (action === "queueAttempt") {
      const participantId = clean(body.participantId, 80);
      if (!eventId || !participantId) return json({ error: "Deltagare saknas." }, 400);
      const [attempt] = await rest(url, service, "puts_gp_attempts", { method: "POST", body: JSON.stringify({ event_id: eventId, participant_id: participantId, status: "queued" }) });
      await audit("attempt", attempt.id, null, { status: "queued" });
      return json({ attempt });
    }

    if (action === "setAttempt") {
      const attemptId = clean(body.attemptId, 80), status = clean(body.status, 30);
      if (!attemptId || !["countdown", "running", "reviewing", "invalid", "disqualified", "deleted"].includes(status)) return json({ error: "Ogiltig tävlingsstatus." }, 400);
      const existing = await rest(url, service, `puts_gp_attempts?select=*&id=eq.${encodeURIComponent(attemptId)}&limit=1`);
      if (!existing?.[0]) return json({ error: "Försöket finns inte." }, 404);
      const patch: Record<string, unknown> = { status };
      if (status === "running") patch.started_at = new Date().toISOString();
      if (status === "reviewing") { const raw = ms(body.rawTimeMs); if (raw === null) return json({ error: "Ogiltig rå tid." }, 400); patch.raw_time_ms = raw; patch.stopped_at = new Date().toISOString(); }
      if (status === "disqualified") { const reason = clean(body.reason, 500); if (!reason) return json({ error: "Diskvalificeringsorsak krävs." }, 400); patch.disqualification_reason = reason; }
      if (status === "deleted") { patch.deleted_at = new Date().toISOString(); patch.deleted_by = user.id; }
      const [attempt] = await rest(url, service, `puts_gp_attempts?id=eq.${encodeURIComponent(attemptId)}`, { method: "PATCH", body: JSON.stringify(patch) });
      await audit("attempt", attemptId, existing[0], attempt);
      return json({ attempt });
    }

    if (action === "setPenalties") {
      const attemptId = clean(body.attemptId, 80), penalties = Array.isArray(body.penalties) ? body.penalties.slice(0, 20) : null;
      if (!attemptId || !penalties) return json({ error: "Straff saknas." }, 400);
      await rest(url, service, `puts_gp_penalties?attempt_id=eq.${encodeURIComponent(attemptId)}`, { method: "DELETE" });
      const rows = penalties.map((p: Record<string, unknown>) => ({ attempt_id: attemptId, penalty_type: ["streak", "missed_area", "water", "dirt", "equipment", "other"].includes(clean(p.type, 30)) ? clean(p.type, 30) : "other", count: Number.isInteger(p.count) ? p.count : 1, seconds_per_item: Number(p.secondsPerItem) || 0, note: clean(p.note, 500) }));
      if (rows.length) await rest(url, service, "puts_gp_penalties", { method: "POST", body: JSON.stringify(rows) });
      const penaltyMs = Math.round(rows.reduce((total: number, p: Record<string, unknown>) => total + Number(p.count) * Number(p.seconds_per_item) * 1000, 0));
      const [attempt] = await rest(url, service, `puts_gp_attempts?id=eq.${encodeURIComponent(attemptId)}`, { method: "PATCH", body: JSON.stringify({ penalty_ms: penaltyMs }) });
      await audit("penalty", attemptId, null, { penaltyMs });
      return json({ attempt });
    }

    if (action === "publish") {
      const attemptId = clean(body.attemptId, 80);
      const existing = await rest(url, service, `puts_gp_attempts?select=*&id=eq.${encodeURIComponent(attemptId)}&limit=1`);
      if (!existing?.[0] || existing[0].status !== "reviewing" || existing[0].raw_time_ms === null) return json({ error: "Endast granskade försök kan publiceras." }, 409);
      const [attempt] = await rest(url, service, `puts_gp_attempts?id=eq.${encodeURIComponent(attemptId)}`, { method: "PATCH", body: JSON.stringify({ status: "published", published_at: new Date().toISOString() }) });
      const [token] = await rest(url, service, "puts_gp_public_result_tokens?on_conflict=attempt_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ attempt_id: attemptId }) });
      await audit("attempt", attemptId, existing[0], attempt);
      return json({ attempt, token: token.token });
    }
    return json({ error: "Okänd åtgärd." }, 400);
  } catch (error) {
    console.error("puts-gp-admin failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Åtgärden kunde inte sparas. Försök igen." }, 500);
  }
});
