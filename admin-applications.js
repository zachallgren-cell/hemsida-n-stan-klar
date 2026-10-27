import { mountInterviews } from './admin-interviews.mjs?v=20261027';
import { APPLICATION_LABELS, APPLICATION_STATUSES } from './job-application-shared.mjs?v=20261004-3';
import { recruitmentStatus, stockholmToday, overdue, filterCandidates, validateFollowUp } from './recruitment-ui.mjs?v=20261005-rek03';
window.bergaAdminApplications = {
  init({ supabase }) {
    const byId = id => document.getElementById(id);
    const panel = byId('applicationsPanel');
    const list = byId('applicationsList');
    const message = byId('applicationsMessage');
    const dialog = byId('applicationDialog');
    const detail = byId('applicationDetail');
    const search = byId('applicationsSearch');
    const filter = byId('applicationsFilter');
    let authorized = false, generation = 0, detailGeneration = 0;
    let candidates = [], assignees = [], selected = null, dirty = false, saving = false;
    const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    const report = text => { message.textContent = text; };
    const date = value => value ? new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'short',day:'numeric'}).format(new Date(`${value.slice(0,10)}T12:00:00Z`)) : '–';
    const timestamp = value => new Date(value).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'});
    filter.innerHTML = '<option value="">Alla statusar</option>' + APPLICATION_STATUSES.map(status => `<option>${escape(status)}</option>`).join('');
    function renderList() {
      const visible = filterCandidates(candidates, search.value, filter.value);
      report(`${visible.length} av ${candidates.length} kandidater`);
      list.innerHTML = visible.length ? `<table class="recruitment-table"><caption class="recruitment-sr-only">Kandidater för REK-03</caption><thead><tr>${['Namn','Ansökningsdatum','Status','Ansvarig','Nästa steg','Uppföljning'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${visible.map(row => `<tr data-candidate-id="${escape(row.id)}"><td data-label="Namn"><button type="button" class="recruitment-open" data-open-application="${escape(row.id)}">${escape(row.answers?.name || 'Namn saknas')}</button></td><td data-label="Ansökningsdatum">${date(row.created_at)}</td><td data-label="Status">${escape(recruitmentStatus(row))}</td><td data-label="Ansvarig">${escape(row.responsible || 'Ej tilldelad')}</td><td data-label="Nästa steg" class="recruitment-next">${escape(row.next_step || '–')}</td><td data-label="Uppföljning">${date(row.follow_up_date)}${overdue(row,stockholmToday()) ? '<strong class="recruitment-overdue">Försenad uppföljning</strong>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p>Inga kandidater matchar din sökning.</p>';
    }
    async function load(view) {
      if (!authorized || view !== 'applications') return;
      if (saving || dirty) { report('Du har osparade ändringar. Spara eller stäng detaljvyn innan du uppdaterar listan.'); return; }
      const current = ++generation;
      report('Hämtar kandidater…');
      try {
        const results = await Promise.all([
          supabase.from('job_applications').select('*').order('created_at',{ascending:false}),
          supabase.from('job_application_assignees').select('label,user_id')
        ]);
        if (!authorized || current !== generation) return;
        if (results.some(result => result.error)) throw new Error('Kandidaterna kunde inte hämtas. Kontrollera behörighet och att REK-03-migrationen är installerad.');
        candidates = results[0].data || [];
        assignees = results[1].data || [];
        renderList();
      } catch(error) {
        if (authorized && current === generation) report(error.message === 'Failed to fetch' ? 'Kunde inte ansluta för att hämta ansökningarna. Kontrollera internetanslutningen och tryck Uppdatera.' : error.message || 'Kunde inte hämta kandidater. Försök igen.');
      }
    }
    async function loadHistory(id, current) {
      const node = byId('applicationHistory');
      node.textContent = 'Hämtar historik…';
      try {
        const {data,error} = await supabase.from('job_application_status_history').select('*').eq('application_id',id).order('changed_at',{ascending:false});
        if (!authorized || current !== detailGeneration || selected?.id !== id) return;
        if (error) throw error;
        node.innerHTML = data?.length ? `<ol>${data.map(item => `<li><strong>${escape(item.previous_status)} → ${escape(item.status)}</strong><br>${escape(timestamp(item.changed_at))} · ${escape(item.changed_by_label || 'Administratör')}</li>`).join('')}</ol>` : '<p>Inga statusändringar registrerade ännu.</p>';
      } catch {
        if (authorized && current === detailGeneration) node.textContent = 'Historiken kunde inte hämtas. Stäng och öppna ansökan för att försöka igen.';
      }
    }
    function renderDetail(row) {
      selected = row;
      dirty = false;
      const current = ++detailGeneration;
      detail.innerHTML = `<header class="recruitment-detail-header"><div><p>REK-03 · Ansökan ${escape(row.id)}</p><h2 id="applicationDetailTitle">${escape(row.answers?.name || 'Ansökan')}</h2><p>Inskickad ${escape(timestamp(row.created_at))}</p></div><button type="button" data-close-application aria-label="Stäng ansökan">Stäng</button></header><h3>Ursprungliga formulärsvar</h3><dl class="recruitment-answers">${Object.entries(APPLICATION_LABELS).map(([key,label]) => `<div><dt>${escape(label)}</dt><dd>${escape(row.answers?.[key] || '–')}</dd></div>`).join('')}</dl><h3>Uppföljning</h3><form id="applicationFollowUpForm"><div class="job-grid"><div class="job-field"><label for="applicationStatus">Status</label><select id="applicationStatus" name="status" required>${APPLICATION_STATUSES.map(status => `<option${recruitmentStatus(row) === status ? ' selected' : ''}>${status}</option>`).join('')}</select></div><div class="job-field"><label for="applicationResponsible">Ansvarig</label><select id="applicationResponsible" name="responsible"><option value="">Ej tilldelad</option>${['Zacke','Martin'].map(label => `<option${row.responsible === label ? ' selected' : ''}>${label}</option>`).join('')}</select><small>${assignees.filter(person => !person.user_id).map(person => `${escape(person.label)} saknar kontokoppling.`).join(' ')}</small>${row.responsible && !['Zacke','Martin'].includes(row.responsible) ? `<small>Tidigare ansvarig: ${escape(row.responsible)}. Välj ny ansvarig innan du sparar.</small>` : ''}</div><div class="job-field job-wide"><label for="applicationNextStep">Nästa steg</label><textarea id="applicationNextStep" name="next_step" maxlength="2000" rows="2" placeholder="Exempel: Ring och boka intervju">${escape(row.next_step)}</textarea></div><div class="job-field"><label for="applicationFollowUpDate">Uppföljningsdatum</label><input id="applicationFollowUpDate" name="follow_up_date" type="date" min="1900-01-01" max="2100-12-31" value="${escape(row.follow_up_date)}"></div><div class="job-field job-wide"><label for="applicationNotes">Interna anteckningar</label><textarea id="applicationNotes" name="internal_notes" maxlength="5000" rows="4">${escape(row.internal_notes)}</textarea><small>Bara behöriga administratörer kan läsa anteckningarna.</small></div></div><p id="applicationSaveMessage" role="status" tabindex="-1"></p><div class="recruitment-actions"><button type="submit" class="btn" id="applicationSave">Spara ändringar</button><button type="button" id="applicationReloadLatest" hidden>Ladda senaste och ersätt mina osparade ändringar</button><button type="button" id="applicationDiscard" hidden>Stäng utan att spara</button></div></form><section id="applicationInterviews" class="recruitment-interviews"></section><h3>Statushistorik</h3><div id="applicationHistory"></div>`;
      mountInterviews({root:byId('applicationInterviews'),row,supabase,isCurrent:()=>authorized && current===detailGeneration,onBusy:value=>{saving=value;}});
      void loadHistory(row.id,current);
    }
    function open(id) {
      if (!authorized) return;
      const row = candidates.find(row => row.id === id);
      if (!row) return;
      renderDetail(row);
      if (!dialog.open) dialog.showModal();
      byId('applicationStatus').focus();
    }
    function close(force = false) {
      if (saving) return;
      if (dirty && !force) {
        byId('applicationSaveMessage').textContent = 'Du har osparade ändringar. Spara först eller välj Stäng utan att spara.';
        byId('applicationDiscard').hidden = false;
        return;
      }
      dirty = false; selected = null; detailGeneration++;
      dialog.close(); detail.replaceChildren();
    }
    panel.addEventListener('click',event => {
      const button = event.target.closest('[data-open-application]');
      if (button) open(button.dataset.openApplication);
    });
    detail.addEventListener('input',event => { if(event.target.closest('#applicationFollowUpForm')) dirty = true; });
    detail.addEventListener('change',event => { if(event.target.closest('#applicationFollowUpForm')) dirty = true; });
    dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
    detail.addEventListener('click',async event => {
      if (event.target.closest('[data-close-application]')) close();
      if (event.target.id === 'applicationDiscard') close(true);
      if (event.target.id === 'applicationReloadLatest' && authorized && !saving) {
        const current = detailGeneration;
        try {
          const {data,error} = await supabase.from('job_applications').select('*').eq('id',selected.id).single();
          if (!authorized || current !== detailGeneration) return;
          if (error || !data) throw new Error('Kunde inte ladda den senaste versionen. Dina ändringar finns kvar.');
          candidates = candidates.map(row => row.id === data.id ? data : row);
          renderList(); renderDetail(data);
        } catch(error) { if (authorized && current === detailGeneration) byId('applicationSaveMessage').textContent = error.message; }
      }
    });
    detail.addEventListener('submit',async event => {
      event.preventDefault();
      if (event.target.id !== 'applicationFollowUpForm' || !authorized || saving || !selected || !event.target.reportValidity()) return;
      const form = event.target;
      const saved = byId('applicationSaveMessage');
      const button = byId('applicationSave');
      const current = detailGeneration;
      let values;
      try { values = validateFollowUp(Object.fromEntries(new FormData(form))); }
      catch(error) { saved.textContent = error.message; return; }
      saving = true;
      const fields = Array.from(form.querySelectorAll('input,select,textarea,button'));
      fields.forEach(field => {field.disabled = true;});
      button.setAttribute('aria-busy','true'); saved.textContent = 'Sparar…';
      try {
        const {data,error} = await supabase.rpc('recruitment_save_application',{
          p_id:selected.id, p_revision:selected.revision, p_status:values.status,
          p_responsible:values.responsible, p_next_step:values.next_step,
          p_follow_up_date:values.follow_up_date || null, p_internal_notes:values.internal_notes
        });
        if (!authorized || current !== detailGeneration) return;
        if (error || !data?.id) {
          if (error?.code === '40001') byId('applicationReloadLatest').hidden = false;
          throw new Error(error?.message || 'Servern kunde inte bekräfta sparningen. Dina ändringar finns kvar. Försök igen.');
        }
        selected = data; dirty = false;
        byId('applicationNextStep').value = data.next_step || '';
        byId('applicationNotes').value = data.internal_notes || '';
        candidates = candidates.map(row => row.id === data.id ? data : row);
        renderList();
        saved.textContent = 'Ändringarna är sparade.';
        byId('applicationReloadLatest').hidden = true; byId('applicationDiscard').hidden = true;
        void loadHistory(data.id,current);
      } catch(error) {
        if (authorized && current === detailGeneration) {
          saved.textContent = error.message === 'Failed to fetch' ? 'Kunde inte få bekräftelse från servern. Dina ändringar finns kvar. Försök igen.' : error.message;
          saved.focus();
        }
      } finally {
        saving = false;
        fields.forEach(field => {field.disabled = false;});
        button.removeAttribute('aria-busy');
      }
    });
    search.addEventListener('input',renderList);
    filter.addEventListener('change',renderList);
    byId('applicationsRefresh').addEventListener('click',() => void load('applications'));
    return {load,setAuthorized(value) {
      authorized = value;
      if (!value) {
        generation++; detailGeneration++; candidates = []; assignees = []; selected = null; dirty = false;
        if (dialog.open) dialog.close(); detail.replaceChildren(); list.replaceChildren(); report(''); panel.classList.add('hidden');
      }
    }};
  }
};
