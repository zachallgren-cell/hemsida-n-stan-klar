import { APPLICATION_LABELS, APPLICATION_STATUSES } from './job-application-shared.mjs?v=20261004-3';
window.bergaAdminApplications = {
  init({ supabase }) {
    const panel = document.getElementById('applicationsPanel');
    const list = document.getElementById('applicationsList');
    const message = document.getElementById('applicationsMessage');
    let authorized = false;
    let generation = 0;
    const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    const report = text => { message.textContent = text; };
    async function load(view) {
      if (!authorized || view !== 'applications') return;
      const current = ++generation;
      report('Hämtar ansökningar…');
      const {data,error} = await supabase.from('job_applications').select('*').order('created_at',{ascending:false});
      if (!authorized || current !== generation) return;
      if (error) { report('Ansökningarna kunde inte hämtas. Kontrollera adminbehörighet och att databasmigrationen är installerad.'); return; }
      report(data.length ? `${data.length} ansökningar` : 'Inga ansökningar ännu.');
      list.innerHTML = data.map(row => `<details class="card"><summary>${escape(row.answers.name)} · ${escape(row.status)} · ${escape(new Date(row.created_at).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'}))}</summary><p>Ansöknings-ID: ${escape(row.id)}</p><dl>${Object.entries(APPLICATION_LABELS).map(([key,label]) => `<dt><strong>${escape(label)}</strong></dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(row.answers[key] || '–')}</dd>`).join('')}</dl><form data-application-id="${escape(row.id)}"><div class="job-grid"><div class="job-field"><label for="status-${row.id}">Status</label><select id="status-${row.id}" name="status">${APPLICATION_STATUSES.map(status => `<option${row.status === status ? ' selected' : ''}>${status}</option>`).join('')}</select></div><div class="job-field"><label for="responsible-${row.id}">Ansvarig</label><input id="responsible-${row.id}" name="responsible" maxlength="100" value="${escape(row.responsible)}"></div><div class="job-field"><label for="follow-${row.id}">Uppföljningsdatum</label><input id="follow-${row.id}" type="date" name="follow_up_date" value="${escape(row.follow_up_date)}"></div><div class="job-field job-wide"><label for="next-${row.id}">Nästa steg</label><textarea id="next-${row.id}" name="next_step" maxlength="2000">${escape(row.next_step)}</textarea></div></div><p role="status" data-save-message></p><button type="submit" class="btn">Spara uppföljning</button></form></details>`).join('');
    }
    panel.addEventListener('submit',async event => {
      const form = event.target.closest('[data-application-id]');
      if (!form) return;
      event.preventDefault();
      const button = form.querySelector('button');
      if (!authorized || button.disabled) return;
      const saved = form.querySelector('[data-save-message]');
      const values = Object.fromEntries(new FormData(form));
      values.follow_up_date ||= null;
      const current = generation;
      button.disabled = true;
      saved.textContent = 'Sparar…';
      try {
        const {data,error} = await supabase.from('job_applications').update(values).eq('id',form.dataset.applicationId).select('id').single();
        if (error || !data) throw new Error('Kunde inte spara. Kontrollera behörigheten och försök igen.');
        if (authorized && current === generation) { saved.textContent = 'Uppföljningen är sparad.'; form.closest('details').querySelector('summary').textContent = form.closest('details').querySelector('summary').textContent.replace(/ · .*? · /,` · ${values.status} · `); }
      } catch(error) { if (authorized && current === generation) saved.textContent = error.message || 'Kunde inte spara. Försök igen.'; }
      finally { button.disabled = false; }
    });
    document.getElementById('applicationsRefresh').addEventListener('click',() => void load('applications'));
    return {load,setAuthorized(value) { authorized = value; if (!value) {generation++; list.replaceChildren(); report(''); panel.classList.add('hidden');} }};
  }
};
