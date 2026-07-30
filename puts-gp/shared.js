export const SUPABASE_URL = 'https://xeyippgcoqfskcmqzazx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq';
export const adminUrl = `${SUPABASE_URL}/functions/v1/puts-gp-admin`;
export const formatTime = (milliseconds) => {
  const ms = Math.max(0, Number(milliseconds) || 0);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000 / 10)).padStart(2, '0')}`;
};
export const displayInitials = (name = 'Deltagare') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'D';
export const rankResults = (items) => [...items].sort((a, b) => a.final_time_ms - b.final_time_ms || a.penalty_ms - b.penalty_ms || new Date(a.published_at) - new Date(b.published_at));
export function timer(onTick) {
  let started = 0, elapsed = 0, frame = 0, active = false;
  const tick = () => { if (!active) return; const value = elapsed + performance.now() - started; onTick(value); frame = requestAnimationFrame(tick); };
  return { start() { if (active) return false; active = true; started = performance.now(); frame = requestAnimationFrame(tick); return true; }, stop() { if (!active) return elapsed; elapsed += performance.now() - started; active = false; cancelAnimationFrame(frame); onTick(elapsed); return Math.round(elapsed); }, reset() { active = false; cancelAnimationFrame(frame); elapsed = 0; onTick(0); }, get active() { return active; }, get elapsed() { return active ? elapsed + performance.now() - started : elapsed; } };
}
export function avatar(name, url = '') { return url ? `<img src="${url}" alt="Porträtt av ${name}">` : `<span aria-hidden="true">${displayInitials(name)}</span>`; }
export function publicClient() { return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } }); }
export async function getPublicData(client) { const [{ data: board }, { data: feed }] = await Promise.all([client.from('puts_gp_public_leaderboard').select('*').order('final_time_ms').limit(50), client.from('puts_gp_public_feed').select('*').order('updated_at', { ascending: false }).limit(1)]); return { board: board || [], feed: feed?.[0]?.payload || null }; }
