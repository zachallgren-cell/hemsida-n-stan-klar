(function () {
  'use strict';

  const SUPABASE_URL = 'https://xeyippgcoqfskcmqzazx.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq';
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const byId = (id) => document.getElementById(id);
  const loginPanel = byId('staffLoginPanel');
  const passwordPanel = byId('staffPasswordPanel');
  const app = byId('staffApp');
  const logoutButton = byId('staffLogout');
  const jobDialog = byId('staffJobDialog');
  const jobDetail = byId('staffJobDetail');
  const authHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const authQuery = new URLSearchParams(window.location.search);
  let needsPasswordSetup = ['invite', 'recovery'].includes(authHash.get('type') || authQuery.get('type') || '');
  let profile = null;
  let jobs = [];
  let activeView = 'today';
  let activeJobId = '';
  let timerInterval = 0;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function setMessage(element, text, state = '') {
    element.textContent = text;
    element.dataset.state = state;
  }

  function openJobDialog() {
    if (typeof jobDialog.showModal === 'function') {
      if (!jobDialog.open) jobDialog.showModal();
      return;
    }
    jobDialog.setAttribute('open', '');
    jobDialog.classList.add('is-fallback');
    document.body.classList.add('staff-dialog-open');
  }

  function closeJobDialog() {
    window.clearInterval(timerInterval);
    activeJobId = '';
    if (typeof jobDialog.close === 'function') jobDialog.close();
    else {
      jobDialog.removeAttribute('open');
      jobDialog.classList.remove('is-fallback');
      document.body.classList.remove('staff-dialog-open');
    }
  }

  function formatMoney(ore) {
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }).format(Number(ore || 0) / 100);
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Number(seconds || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  }

  function stockholmDate(value = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(value);
  }

  function dateParts(value) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm', weekday: 'short', day: 'numeric', month: 'short'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { weekday: map.weekday, day: map.day, month: map.month };
  }

  function formatDateTime(value) {
    return new Date(value).toLocaleString('sv-SE', {
      timeZone: 'Europe/Stockholm', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
  }

  function rpcError(error) {
    const message = String(error?.message || 'Något gick fel. Försök igen.');
    return message.replace(/^.*?:\s*/, '')
      .replace('Active staff account required', 'Ett aktivt personalkonto krävs.')
      .replace('Job not found', 'Jobbet hittades inte.')
      .replace('Job is not available', 'Jobbet är inte längre tillgängligt.');
  }

  async function callRpc(name, args = {}) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  function filterJobs() {
    const today = stockholmDate();
    return jobs.filter((job) => {
      const jobDate = stockholmDate(new Date(job.scheduled_start));
      if (activeView === 'today') return job.my_assignment_status && jobDate === today && job.status !== 'cancelled';
      if (activeView === 'available') return !job.my_assignment_status && ['open', 'in_progress'].includes(job.status);
      if (activeView === 'mine') return job.my_assignment_status && !['completed', 'cancelled'].includes(job.status) && jobDate >= today;
      if (activeView === 'history') return job.my_assignment_status && (job.status === 'completed' || jobDate < today);
      return false;
    });
  }

  function renderJobs() {
    const visible = filterJobs();
    const list = byId('staffJobList');
    if (!visible.length) {
      const labels = { today: 'Du har inga tilldelade jobb i dag.', available: 'Det finns inga lediga pass just nu.', mine: 'Du har inga kommande jobb.', history: 'Ingen jobbhistorik ännu.' };
      list.innerHTML = `<div class="empty-state">${escapeHtml(labels[activeView])}</div>`;
      return;
    }
    list.innerHTML = visible.map((job) => {
      const parts = dateParts(job.scheduled_start);
      const staffing = `${job.claimed_staff}/${job.required_staff} personer`;
      return `<button type="button" class="staff-job-card" data-job-id="${escapeHtml(job.id)}">
        <span class="staff-job-date"><span>${escapeHtml(parts.weekday)}</span><strong>${escapeHtml(parts.day)}</strong><span>${escapeHtml(parts.month)}</span></span>
        <span class="staff-job-copy"><strong>${escapeHtml(job.service_label)}</strong><span>${escapeHtml(formatDateTime(job.scheduled_start))} · ${escapeHtml(job.area_label || 'Område saknas')}</span><span>${escapeHtml(staffing)} · cirka ${escapeHtml(Math.round(job.estimated_minutes / 60 * 10) / 10)} tim</span></span>
        <span class="staff-job-money">${escapeHtml(formatMoney(job.my_commission_ore ?? job.estimated_commission_ore))}</span>
      </button>`;
    }).join('');
  }

  function renderSummary() {
    const today = stockholmDate();
    const own = jobs.filter((job) => job.my_assignment_status);
    byId('staffUpcomingCount').textContent = String(own.filter((job) => stockholmDate(new Date(job.scheduled_start)) >= today && job.status !== 'cancelled').length);
    const earned = own.filter((job) => ['completed', 'approved', 'paid'].includes(job.status) || job.my_assignment_status === 'completed')
      .reduce((sum, job) => sum + Number(job.my_commission_ore || 0), 0);
    byId('staffEarnedCommission').textContent = formatMoney(earned);
    const seconds = own.reduce((sum, job) => sum + Number(job.my_worked_seconds || 0), 0);
    byId('staffWorkedTime').textContent = `${Math.round(seconds / 360) / 10} tim`;
  }

  async function loadJobs(showMessage = false) {
    if (showMessage) setMessage(byId('staffAppMessage'), 'Uppdaterar…');
    try {
      jobs = await callRpc('staff_list_jobs') || [];
      renderSummary();
      renderJobs();
      setMessage(byId('staffAppMessage'), '');
    } catch (error) {
      setMessage(byId('staffAppMessage'), rpcError(error), 'error');
    }
  }

  function checklistMarkup(items, editable) {
    if (!items?.length) return '<div class="empty-state">Ingen checklista är kopplad till jobbet.</div>';
    return `<div class="checklist">${items.map((item) => `<label class="checklist-item">
      <input type="checkbox" data-checklist-id="${escapeHtml(item.id)}" ${item.completed ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      <span>${escapeHtml(item.label)}${item.required ? ' *' : ''}${item.helpText ? `<small>${escapeHtml(item.helpText)}</small>` : ''}</span>
    </label>`).join('')}</div>`;
  }

  function updateLiveTimer(detail) {
    window.clearInterval(timerInterval);
    const output = byId('staffTimerValue');
    if (!output) return;
    const tick = () => {
      const running = detail.activeTimer && String(detail.activeTimer.jobId) === String(detail.id);
      const seconds = Number(detail.workedSeconds || 0) + (running ? Math.max(0, (Date.now() - new Date(detail.activeTimer.startedAt).getTime()) / 1000) : 0);
      output.textContent = formatDuration(seconds);
    };
    tick();
    timerInterval = window.setInterval(tick, 1000);
  }

  function renderJobDetail(detail) {
    const assigned = Boolean(detail.assigned);
    const completed = detail.assignmentStatus === 'completed' || detail.status === 'completed';
    const timerOnThisJob = detail.activeTimer && String(detail.activeTimer.jobId) === String(detail.id);
    const timerOnOtherJob = detail.activeTimer && !timerOnThisJob;
    byId('staffJobTitle').textContent = detail.serviceLabel || 'Jobb';
    jobDetail.innerHTML = `
      <div class="job-hero"><strong>${escapeHtml(formatDateTime(detail.scheduledStart))}</strong><span>${escapeHtml(detail.serviceLabel)} · ${escapeHtml(detail.areaLabel || '')}</span></div>
      <div class="job-commission"><span>${assigned ? 'Din preliminära provision' : 'Beräknad provision vid full bemanning'}</span><strong>${escapeHtml(formatMoney(detail.commission?.amount_ore ?? detail.estimatedCommissionOre))}</strong></div>
      ${assigned ? `<section class="job-section"><h3>Kund och plats</h3><div class="job-details">
        <div><strong>Kund</strong><span>${escapeHtml(detail.customerName || 'Ej angivet')}</span></div>
        <div><strong>Telefon</strong>${detail.customerPhone ? `<a href="tel:${escapeHtml(detail.customerPhone)}">${escapeHtml(detail.customerPhone)}</a>` : '<span>Ej angivet</span>'}</div>
        <div><strong>Adress</strong><a href="https://maps.google.com/?q=${encodeURIComponent([detail.address, detail.postalCode].filter(Boolean).join(' '))}" target="_blank" rel="noopener">${escapeHtml([detail.address, detail.postalCode].filter(Boolean).join(', ') || 'Ej angiven')}</a></div>
        <div><strong>Omfattning</strong><span>${escapeHtml([detail.housingType, detail.serviceScope, detail.windowCount].filter(Boolean).join(' · ') || detail.serviceLabel)}</span></div>
      </div>${detail.practicalNote ? `<p>${escapeHtml(detail.practicalNote)}</p>` : ''}</section>` : ''}
      ${assigned && !completed ? `<section class="job-section"><h3>Arbetstid</h3><div class="timer-card"><span>Registrerad tid</span><strong class="timer-value" id="staffTimerValue">0:00</strong><div class="timer-actions">
        ${timerOnThisJob ? '<button type="button" class="primary-button" data-job-action="pause">Pausa</button>' : `<button type="button" class="primary-button" data-job-action="start" ${timerOnOtherJob ? 'disabled' : ''}>${Number(detail.workedSeconds) > 0 ? 'Fortsätt tid' : 'Starta tid'}</button>`}
        <button type="button" class="secondary-button" data-job-action="complete">Slutför jobb</button>
      </div>${timerOnOtherJob ? '<p>Du har en aktiv timer på ett annat jobb.</p>' : ''}</div></section>` : ''}
      ${assigned ? `<section class="job-section"><h3>Checklista</h3>${checklistMarkup(detail.checklist, !completed)}</section>` : ''}
      <section class="job-section"><div class="job-actions">
        ${!assigned && ['open', 'in_progress'].includes(detail.status) ? '<button type="button" class="primary-button" data-job-action="claim">Paxa passet</button>' : ''}
        ${assigned && !completed && !detail.activeTimer ? '<button type="button" class="danger-button" data-job-action="release">Avpaxa</button>' : ''}
      </div></section>
      ${assigned ? `<section class="job-section"><h3>Rapportera avvikelse</h3><form class="issue-form" id="staffIssueForm"><textarea id="staffIssueText" maxlength="2000" placeholder="Beskriv skada, hinder, saknat material eller annat som admin behöver känna till."></textarea><button class="secondary-button" type="submit">Skicka till admin</button></form><p class="status-message" id="staffIssueMessage"></p></section>` : ''}`;
    updateLiveTimer(detail);
  }

  async function openJob(jobId) {
    activeJobId = jobId;
    jobDetail.innerHTML = '<div class="empty-state">Hämtar jobbet…</div>';
    openJobDialog();
    try {
      const detail = await callRpc('staff_get_job', { p_job_id: jobId });
      renderJobDetail(detail);
    } catch (error) {
      jobDetail.innerHTML = `<div class="empty-state">${escapeHtml(rpcError(error))}</div>`;
    }
  }

  async function runJobAction(action, button) {
    const rpcMap = {
      claim: ['staff_claim_job', { p_job_id: activeJobId }],
      release: ['staff_release_job', { p_job_id: activeJobId }],
      start: ['staff_start_job_time', { p_job_id: activeJobId }],
      pause: ['staff_stop_job_time', { p_job_id: activeJobId, p_action: 'pause' }],
      complete: ['staff_stop_job_time', { p_job_id: activeJobId, p_action: 'completed' }]
    };
    const call = rpcMap[action];
    if (!call) return;
    if (action === 'release' && !window.confirm('Vill du avpaxa det här passet?')) return;
    if (action === 'complete' && !window.confirm('Är checklistan klar och jobbet färdigt?')) return;
    button.disabled = true;
    try {
      await callRpc(call[0], call[1]);
      await loadJobs();
      await openJob(activeJobId);
    } catch (error) {
      window.alert(rpcError(error));
      button.disabled = false;
    }
  }

  async function loadProfileAndApp() {
    profile = await callRpc('staff_get_me');
    if (!profile) throw new Error('Ditt konto är inte registrerat som personal. Kontakta admin.');
    if (profile.status === 'invited') {
      await callRpc('staff_activate_me');
      profile = await callRpc('staff_get_me');
    }
    if (profile.status !== 'active') throw new Error('Ditt personalkonto är inaktiverat. Kontakta admin.');
    byId('staffGreeting').textContent = `Hej ${profile.displayName.split(/\s+/)[0]}!`;
    app.hidden = false;
    logoutButton.hidden = false;
    await loadJobs();
  }

  async function refreshSession() {
    const { data } = await client.auth.getSession();
    const session = data.session;
    loginPanel.hidden = Boolean(session);
    passwordPanel.hidden = !session || !needsPasswordSetup;
    app.hidden = true;
    logoutButton.hidden = !session;
    if (!session || needsPasswordSetup) return;
    try {
      await loadProfileAndApp();
    } catch (error) {
      setMessage(byId('staffLoginMessage'), rpcError(error), 'error');
      loginPanel.hidden = false;
    }
  }

  byId('staffLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = byId('staffLoginButton');
    button.disabled = true;
    setMessage(byId('staffLoginMessage'), 'Loggar in…');
    const { error } = await client.auth.signInWithPassword({ email: byId('staffEmail').value.trim(), password: byId('staffPassword').value });
    byId('staffPassword').value = '';
    button.disabled = false;
    if (error) return setMessage(byId('staffLoginMessage'), `Kunde inte logga in: ${error.message}`, 'error');
    setMessage(byId('staffLoginMessage'), '');
    await refreshSession();
  });

  byId('staffResetPassword').addEventListener('click', async () => {
    const email = byId('staffEmail').value.trim();
    if (!email) return setMessage(byId('staffLoginMessage'), 'Fyll i din e-postadress först.', 'error');
    const button = byId('staffResetPassword');
    button.disabled = true;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${window.location.pathname}` });
    button.disabled = false;
    if (error) return setMessage(byId('staffLoginMessage'), `Kunde inte skicka återställningslänken: ${error.message}`, 'error');
    setMessage(byId('staffLoginMessage'), 'En återställningslänk har skickats om adressen är registrerad.', 'success');
  });

  byId('staffPasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = byId('staffNewPassword').value;
    if (password.length < 12) return setMessage(byId('staffPasswordMessage'), 'Lösenordet måste vara minst 12 tecken.', 'error');
    if (password !== byId('staffConfirmPassword').value) return setMessage(byId('staffPasswordMessage'), 'Lösenorden stämmer inte överens.', 'error');
    const button = byId('staffPasswordButton');
    button.disabled = true;
    const { error } = await client.auth.updateUser({ password });
    button.disabled = false;
    if (error) return setMessage(byId('staffPasswordMessage'), error.message, 'error');
    needsPasswordSetup = false;
    window.history.replaceState({}, '', window.location.pathname);
    await refreshSession();
  });

  logoutButton.addEventListener('click', async () => {
    window.clearInterval(timerInterval);
    await client.auth.signOut({ scope: 'local' });
    profile = null;
    jobs = [];
    if (jobDialog.open) closeJobDialog();
    await refreshSession();
  });

  byId('staffRefresh').addEventListener('click', () => loadJobs(true));
  document.querySelector('.staff-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-staff-view]');
    if (!button) return;
    activeView = button.dataset.staffView;
    document.querySelectorAll('[data-staff-view]').forEach((item) => item.classList.toggle('is-active', item === button));
    renderJobs();
  });
  byId('staffJobList').addEventListener('click', (event) => {
    const card = event.target.closest('[data-job-id]');
    if (card) void openJob(card.dataset.jobId);
  });
  byId('staffJobClose').addEventListener('click', closeJobDialog);
  jobDialog.addEventListener('close', () => { window.clearInterval(timerInterval); activeJobId = ''; document.body.classList.remove('staff-dialog-open'); });
  jobDetail.addEventListener('click', (event) => {
    const button = event.target.closest('[data-job-action]');
    if (button) void runJobAction(button.dataset.jobAction, button);
  });
  jobDetail.addEventListener('change', async (event) => {
    const checkbox = event.target.closest('[data-checklist-id]');
    if (!checkbox) return;
    checkbox.disabled = true;
    try {
      await callRpc('staff_set_checklist_item', { p_item_id: checkbox.dataset.checklistId, p_completed: checkbox.checked, p_note: null });
      await openJob(activeJobId);
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      checkbox.disabled = false;
      window.alert(rpcError(error));
    }
  });
  jobDetail.addEventListener('submit', async (event) => {
    if (event.target.id !== 'staffIssueForm') return;
    event.preventDefault();
    const text = byId('staffIssueText').value.trim();
    try {
      await callRpc('staff_report_job_issue', { p_job_id: activeJobId, p_summary: text });
      byId('staffIssueText').value = '';
      setMessage(byId('staffIssueMessage'), 'Avvikelsen är skickad till admin.', 'success');
    } catch (error) {
      setMessage(byId('staffIssueMessage'), rpcError(error), 'error');
    }
  });

  void refreshSession();
})();
