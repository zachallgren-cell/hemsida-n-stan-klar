import { publicClient, getPublicData, formatTime, avatar } from './shared.js';
const client = publicClient(); let liveTimer;
const byId = (id) => document.getElementById(id);
function render({ board, feed }) {
  const active = feed?.activeAttempt; const state = active?.status || feed?.eventStatus || 'vänteläge';
  byId('eventDate').textContent = feed?.eventName || 'KANALENS DAG'; byId('status').textContent = state === 'running' ? 'LIVE' : state;
  byId('activeName').textContent = active ? active.publicDisplayName : 'Vi inväntar nästa deltagare.';
  const ranked = board.slice(0, 10); byId('leaderboard').innerHTML = ranked.length ? ranked.map((r, i) => `<li><strong>${i + 1}</strong><span class="gp-avatar">${avatar(r.public_display_name, r.photo_public_url)}</span><span>${r.public_display_name}${r.penalty_ms ? `<small class="gp-muted"> +${(r.penalty_ms / 1000).toFixed(0)} s</small>` : ''}</span><strong>${formatTime(r.final_time_ms)}</strong></li>`).join('') : '<li>Inga godkända resultat ännu.</li>';
  byId('podium').innerHTML = ranked.slice(0,3).map((r) => `<div><span class="gp-avatar">${avatar(r.public_display_name,r.photo_public_url)}</span><strong>${r.public_display_name}</strong><small>${formatTime(r.final_time_ms)}</small></div>`).join('') || '<p class="gp-muted">Prispallen fylls när resultat publiceras.</p>';
  const average = ranked[0]?.average_time_ms; byId('total').textContent = ranked[0]?.participant_count || '0'; byId('average').textContent = average ? formatTime(average) : '–'; byId('best').textContent = ranked[0] ? formatTime(ranked[0].final_time_ms) : '–';
  clearInterval(liveTimer); if (active?.status === 'running') { const began = performance.now() - (active.rawTimeMs || 0); liveTimer = setInterval(() => byId('liveTime').textContent = formatTime(performance.now() - began), 40); } else byId('liveTime').textContent = active?.rawTimeMs ? formatTime(active.rawTimeMs) : '0:00.00';
}
async function refresh() { render(await getPublicData(client)); }
await refresh(); client.channel('puts-gp-public').on('postgres_changes',{event:'*',schema:'public',table:'puts_gp_public_feed'},refresh).subscribe(); setInterval(refresh, 30000);
