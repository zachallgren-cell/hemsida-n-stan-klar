(function () {
  'use strict';

  const WORKFORCE_VIEWS = new Set(['staff', 'workforce', 'checklists', 'staffFinance']);

  function init(options) {
    const client = options.supabase;
    const endpoint = options.endpoint;
    const anonKey = options.anonKey;
    let authorized = false;
    let bookings = [];
    let staff = [];
    let jobs = [];
    let assignments = [];
    let templates = [];
    let templateItems = [];
    let timeEntries = [];
    let commissions = [];
    let costs = [];
    let events = [];
    let loaded = false;
    let loadingPromise = null;

    const byId = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    function formatMoney(ore) {
      return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }).format(Number(ore || 0) / 100);
    }

    function formatDateTime(value) {
      if (!value) return '–';
      return new Date(value).toLocaleString('sv-SE', {
        timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    }

    function formatDate(value) {
      if (!value) return '–';
      return new Date(`${value}T12:00:00`).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function formatHours(seconds) {
      return `${Math.round(Number(seconds || 0) / 360) / 10} tim`;
    }

    function setMessage(id, text, state = '') {
      const element = byId(id);
      if (!element) return;
      element.textContent = text;
      element.dataset.state = state;
    }

    function readableError(error) {
      const message = String(error?.message || 'Något gick fel.');
      if (/relation .* does not exist|schema cache/i.test(message)) return 'Personalmodulen är inte installerad i databasen ännu. Kör den nya Supabase-migrationen.';
      if (/row-level security|permission denied|aal2/i.test(message)) return 'Tvåstegsverifierad adminbehörighet krävs.';
      return message.replace(/^.*?:\s*/, '');
    }

    async function rpc(name, args = {}) {
      const { data, error } = await client.rpc(name, args);
      if (error) throw error;
      return data;
    }

    async function callStaffEndpoint(action, payload = {}) {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Adminsession saknas.');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) throw new Error(body.error || 'Personalåtgärden misslyckades.');
      return body;
    }

    function indexBy(items, key = 'id') {
      return new Map(items.map((item) => [String(item[key]), item]));
    }

    function activeAssignments(jobId) {
      return assignments.filter((item) => String(item.job_id) === String(jobId) && ['claimed', 'assigned', 'completed'].includes(item.status));
    }

    function jobCommissions(jobId) {
      return commissions.filter((item) => String(item.job_id) === String(jobId) && item.status !== 'reversed');
    }

    function jobCosts(jobId) {
      return costs.filter((item) => String(item.job_id) === String(jobId));
    }

    function jobWorkedSeconds(jobId) {
      return timeEntries.filter((entry) => String(entry.job_id) === String(jobId)).reduce((sum, entry) => {
        const end = entry.ended_at ? new Date(entry.ended_at).getTime() : Date.now();
        return sum + Math.max(0, (end - new Date(entry.started_at).getTime()) / 1000);
      }, 0);
    }

    function jobEconomics(job) {
      const revenue = Number(job.commission_base_ex_vat_ore || 0);
      const commission = jobCommissions(job.id).reduce((sum, item) => sum + Number(item.amount_ore || 0), 0);
      const directCosts = jobCosts(job.id).reduce((sum, item) => sum + Number(item.amount_ex_vat_ore || 0), 0);
      const contribution = revenue - commission - directCosts;
      const margin = revenue > 0 ? contribution / revenue : 0;
      const hours = jobWorkedSeconds(job.id) / 3600;
      return { revenue, commission, directCosts, contribution, margin, hours, perHour: hours > 0 ? contribution / hours : 0 };
    }

    function renderOverviewMetrics() {
      const container = byId('workforceOverviewMetrics');
      if (!container) return;
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const todayJobs = jobs.filter((job) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(job.scheduled_start)) === today && job.status !== 'cancelled');
      const unstaffed = jobs.filter((job) => ['open', 'draft'].includes(job.status) && activeAssignments(job.id).length < job.required_staff).length;
      const running = timeEntries.filter((entry) => !entry.ended_at).length;
      const earned = commissions.filter((item) => item.status === 'earned').reduce((sum, item) => sum + Number(item.amount_ore || 0), 0);
      container.innerHTML = [
        ['Personaljobb i dag', todayJobs.length, `${todayJobs.filter((job) => job.status === 'completed').length} slutförda`],
        ['Obemannade pass', unstaffed, unstaffed ? 'Behöver åtgärdas' : 'Allt är bemannat'],
        ['Aktiva timers', running, running ? 'Pågående arbete' : 'Ingen arbetar just nu'],
        ['Provision att godkänna', formatMoney(earned), `${commissions.filter((item) => item.status === 'earned').length} poster`]
      ].map(([label, value, detail]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join('');
    }

    function renderStaff() {
      const container = byId('staffMembersList');
      if (!container) return;
      if (!staff.length) {
        container.innerHTML = '<div class="empty-state">Ingen personal är tillagd ännu.</div>';
        return;
      }
      container.innerHTML = `<div class="data-table-wrap"><table class="admin-table workforce-table"><thead><tr><th>Personal</th><th>Roll</th><th>Kompetenser</th><th>Status</th><th>Utförda jobb</th><th></th></tr></thead><tbody>${staff.map((member) => {
        const completed = assignments.filter((item) => item.staff_user_id === member.user_id && item.status === 'completed').length;
        const statusLabel = { invited: 'Inbjuden', active: 'Aktiv', inactive: 'Inaktiv' }[member.status] || member.status;
        return `<tr data-staff-id="${escapeHtml(member.user_id)}"><td class="primary-cell"><strong>${escapeHtml(member.display_name)}</strong><span>${escapeHtml(member.email)}${member.phone ? ` · ${escapeHtml(member.phone)}` : ''}</span></td><td>${member.role === 'supervisor' ? 'Arbetsledare' : 'Medarbetare'}</td><td>${escapeHtml((member.skills || []).join(', ') || '–')}</td><td><span class="badge ${member.status === 'active' ? 'paid' : member.status === 'invited' ? 'pending' : 'cancelled'}">${escapeHtml(statusLabel)}</span></td><td>${completed}</td><td class="action-cell"><button type="button" class="button ${member.status === 'inactive' ? 'button-secondary action-reactivate-staff' : 'button-danger action-deactivate-staff'}">${member.status === 'inactive' ? 'Återaktivera' : 'Inaktivera'}</button></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function templateOptions(selected = '') {
      return `<option value="">Ingen checklista</option>${templates.filter((item) => item.active).map((item) => `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(selected) ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}`;
    }

    function renderWorkforce() {
      const jobBookingIds = new Set(jobs.map((job) => String(job.booking_id)));
      const today = new Date().toISOString().slice(0, 10);
      const unplanned = bookings.filter((booking) => ['pending', 'confirmed'].includes(String(booking.status)) && booking.booking_date >= today && !jobBookingIds.has(String(booking.id)));
      const source = byId('unplannedBookingsList');
      if (source) {
        source.innerHTML = unplanned.length ? unplanned.map((booking) => `<article class="workforce-booking-row" data-booking-id="${escapeHtml(booking.id)}">
          <div><strong>${escapeHtml(booking.customer_name || 'Kund')}</strong><span>${escapeHtml(formatDate(booking.booking_date))} · ${escapeHtml(booking.booking_time || 'Tid saknas')} · ${escapeHtml(booking.address || '')}</span></div>
          <label>Minuter<input class="job-estimated-minutes" type="number" min="15" max="1440" step="15" value="180"></label>
          <label>Personal<input class="job-required-staff" type="number" min="1" max="20" value="1"></label>
          <label>Checklista<select class="job-template-select">${templateOptions()}</select></label>
          <button type="button" class="button button-primary action-create-staff-job">Skapa pass</button>
        </article>`).join('') : '<div class="empty-state">Alla kommande bekräftade bokningar har ett personalpass.</div>';
      }

      const staffById = indexBy(staff, 'user_id');
      const activeStaff = staff.filter((member) => member.status === 'active');
      const jobContainer = byId('staffJobsList');
      if (!jobContainer) return;
      jobContainer.innerHTML = jobs.length ? jobs.map((job) => {
        const jobAssignments = activeAssignments(job.id);
        const assignedIds = new Set(jobAssignments.map((item) => item.staff_user_id));
        const availableStaff = activeStaff.filter((member) => !assignedIds.has(member.user_id));
        const people = jobAssignments.map((assignment) => {
          const member = staffById.get(String(assignment.staff_user_id));
          return `<span class="assigned-person">${escapeHtml(member?.display_name || 'Okänd')} · ${escapeHtml(assignment.status)}${assignment.status !== 'completed' ? `<button type="button" class="action-release-assignment" data-staff-id="${escapeHtml(assignment.staff_user_id)}" aria-label="Ta bort ${escapeHtml(member?.display_name || 'personal')}">×</button>` : ''}</span>`;
        }).join('');
        const statusLabel = { draft: 'Utkast', open: 'Öppet', fully_staffed: 'Fullbemannat', in_progress: 'Pågår', completed: 'Slutfört', cancelled: 'Avbrutet' }[job.status] || job.status;
        return `<article class="workforce-job-card" data-job-id="${escapeHtml(job.id)}">
          <div class="workforce-job-heading"><div><strong>${escapeHtml(job.customer_name || 'Kund')}</strong><span>${escapeHtml(formatDateTime(job.scheduled_start))} · ${escapeHtml(job.service_label)} · ${escapeHtml(job.area_label || '')}</span></div><span class="badge ${job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'fully_staffed' ? 'confirmed' : 'pending'}">${escapeHtml(statusLabel)}</span></div>
          <div class="workforce-job-facts"><span>${jobAssignments.length}/${job.required_staff} personal</span><span>${Math.round(job.estimated_minutes / 60 * 10) / 10} tim planerat</span><span>${formatMoney(job.commission_base_ex_vat_ore * job.commission_rate_basis_points / 10000)} provisionspott</span></div>
          <div class="assigned-people">${people || '<span class="muted-copy">Ingen tilldelad</span>'}</div>
          <div class="workforce-job-actions">
            ${!['completed', 'cancelled'].includes(job.status) && availableStaff.length && jobAssignments.length < job.required_staff ? `<select class="assignment-staff-select"><option value="">Välj personal…</option>${availableStaff.map((member) => `<option value="${escapeHtml(member.user_id)}">${escapeHtml(member.display_name)}</option>`).join('')}</select><button type="button" class="button button-secondary action-assign-staff">Tilldela</button>` : ''}
            ${job.status === 'draft' || job.status === 'cancelled' ? '<button type="button" class="button button-secondary action-job-status" data-status="open">Öppna paxning</button>' : ''}
            ${!['completed', 'cancelled'].includes(job.status) ? '<button type="button" class="button button-danger action-job-status" data-status="cancelled">Avbryt pass</button>' : ''}
          </div>
        </article>`;
      }).join('') : '<div class="empty-state">Inga personalpass har skapats ännu.</div>';
    }

    function renderChecklists() {
      const container = byId('checklistTemplatesList');
      if (!container) return;
      const groupedItems = new Map();
      templateItems.forEach((item) => {
        const group = groupedItems.get(String(item.template_id)) || [];
        group.push(item);
        groupedItems.set(String(item.template_id), group);
      });
      container.innerHTML = templates.length ? templates.map((template) => {
        const items = (groupedItems.get(String(template.id)) || []).sort((a, b) => a.sort_order - b.sort_order);
        return `<article class="checklist-template-card" data-template-id="${escapeHtml(template.id)}"><div><strong>${escapeHtml(template.name)}</strong><span>${escapeHtml(template.description || 'Ingen beskrivning')}</span></div><span class="badge ${template.active ? 'paid' : 'cancelled'}">${template.active ? 'Aktiv' : 'Pausad'}</span><ol>${items.map((item) => `<li>${escapeHtml(item.label)}${item.required ? ' *' : ''}</li>`).join('')}</ol><button type="button" class="button button-secondary action-toggle-template" data-active="${template.active}">${template.active ? 'Pausa mall' : 'Aktivera mall'}</button></article>`;
      }).join('') : '<div class="empty-state">Inga checklistemallar finns.</div>';
    }

    function renderTimesAndCommission() {
      const staffById = indexBy(staff, 'user_id');
      const jobById = indexBy(jobs);
      const timeContainer = byId('staffTimeEntriesList');
      if (timeContainer) {
        timeContainer.innerHTML = timeEntries.length ? `<div class="data-table-wrap"><table class="admin-table workforce-table"><thead><tr><th>Personal</th><th>Jobb</th><th>Start</th><th>Slut</th><th>Tid</th><th>Status</th></tr></thead><tbody>${timeEntries.slice().sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).map((entry) => {
          const member = staffById.get(String(entry.staff_user_id));
          const job = jobById.get(String(entry.job_id));
          const end = entry.ended_at ? new Date(entry.ended_at).getTime() : Date.now();
          const seconds = Math.max(0, (end - new Date(entry.started_at).getTime()) / 1000);
          return `<tr><td class="primary-cell"><strong>${escapeHtml(member?.display_name || 'Okänd')}</strong></td><td>${escapeHtml(job?.customer_name || job?.service_label || 'Jobb')}</td><td>${escapeHtml(formatDateTime(entry.started_at))}</td><td>${escapeHtml(formatDateTime(entry.ended_at))}</td><td>${escapeHtml(formatHours(seconds))}</td><td><span class="badge ${entry.ended_at ? 'completed' : 'pending'}">${entry.ended_at ? 'Stoppad' : 'Pågår'}</span>${entry.correction_reason ? `<small class="table-note">Rättad: ${escapeHtml(entry.correction_reason)}</small>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state">Ingen arbetstid har registrerats ännu.</div>';
      }

      const commissionContainer = byId('staffCommissionsList');
      if (commissionContainer) {
        commissionContainer.innerHTML = commissions.filter((item) => item.status !== 'reversed').length ? `<div class="data-table-wrap"><table class="admin-table workforce-table"><thead><tr><th>Personal</th><th>Jobb</th><th>Arbetstid</th><th>Andel</th><th>Provision</th><th>Status</th><th></th></tr></thead><tbody>${commissions.filter((item) => item.status !== 'reversed').map((item) => {
          const member = staffById.get(String(item.staff_user_id));
          const job = jobById.get(String(item.job_id));
          const statusLabel = { estimated: 'Preliminär', earned: 'Intjänad', approved: 'Godkänd', paid: 'Utbetald' }[item.status] || item.status;
          const action = item.status === 'earned' ? '<button type="button" class="button button-primary action-commission-status" data-status="approved">Godkänn</button>' : item.status === 'approved' ? '<button type="button" class="button button-success action-commission-status" data-status="paid">Markera utbetald</button>' : '';
          return `<tr data-commission-id="${escapeHtml(item.id)}"><td class="primary-cell"><strong>${escapeHtml(member?.display_name || 'Okänd')}</strong></td><td>${escapeHtml(job?.customer_name || job?.service_label || 'Jobb')}</td><td>${escapeHtml(formatHours(item.worked_seconds))}</td><td>${Math.round(item.share_basis_points / 100)} %</td><td><strong>${escapeHtml(formatMoney(item.amount_ore))}</strong></td><td><span class="badge ${item.status === 'paid' ? 'paid' : item.status === 'approved' ? 'confirmed' : 'pending'}">${escapeHtml(statusLabel)}</span></td><td class="action-cell">${action}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state">Ingen provision finns ännu.</div>';
      }
    }

    function renderFinance() {
      const completedJobs = jobs.filter((job) => job.status === 'completed');
      const totals = completedJobs.reduce((sum, job) => {
        const economy = jobEconomics(job);
        Object.keys(sum).forEach((key) => { sum[key] += economy[key] || 0; });
        return sum;
      }, { revenue: 0, commission: 0, directCosts: 0, contribution: 0, hours: 0, perHour: 0 });
      const margin = totals.revenue > 0 ? totals.contribution / totals.revenue : 0;
      const metrics = byId('staffFinanceMetrics');
      if (metrics) metrics.innerHTML = [
        ['Omsättning exkl. moms', formatMoney(totals.revenue), `${completedJobs.length} slutförda jobb`],
        ['Provision', formatMoney(totals.commission), 'Total provisionskostnad'],
        ['Täckningsbidrag', formatMoney(totals.contribution), `${Math.round(margin * 100)} % marginal`],
        ['TB per arbetstimme', totals.hours ? formatMoney(totals.contribution / totals.hours) : '–', `${Math.round(totals.hours * 10) / 10} registrerade timmar`]
      ].map(([label, value, detail]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join('');

      const container = byId('staffJobEconomicsList');
      if (!container) return;
      container.innerHTML = jobs.length ? jobs.map((job) => {
        const economy = jobEconomics(job);
        const categories = Object.fromEntries(jobCosts(job.id).map((item) => [item.category, Number(item.amount_ex_vat_ore || 0) / 100]));
        return `<article class="job-economy-card" data-job-id="${escapeHtml(job.id)}"><div class="job-economy-heading"><div><strong>${escapeHtml(job.customer_name || 'Kund')}</strong><span>${escapeHtml(formatDateTime(job.scheduled_start))} · ${escapeHtml(job.service_label)}</span></div><strong class="${economy.contribution < 0 ? 'negative-money' : 'positive-money'}">${escapeHtml(formatMoney(economy.contribution))} TB</strong></div>
          <div class="job-economy-grid"><span>Omsättning<strong>${escapeHtml(formatMoney(economy.revenue))}</strong></span><span>Provision<strong>${escapeHtml(formatMoney(economy.commission))}</strong></span><span>Direkta kostnader<strong>${escapeHtml(formatMoney(economy.directCosts))}</strong></span><span>Marginal<strong>${Math.round(economy.margin * 100)} %</strong></span><span>Arbetstid<strong>${escapeHtml(formatHours(economy.hours * 3600))}</strong></span><span>TB/timme<strong>${economy.hours ? escapeHtml(formatMoney(economy.perHour)) : '–'}</strong></span></div>
          <details><summary>Registrera faktiska kostnader</summary><form class="job-cost-form"><label>Material exkl. moms<input type="number" min="0" step="1" data-cost="material" value="${categories.material || 0}"></label><label>Transport exkl. moms<input type="number" min="0" step="1" data-cost="transport" value="${categories.transport || 0}"></label><label>Lönebikostnader<input type="number" min="0" step="1" data-cost="payroll_oncost" value="${categories.payroll_oncost || 0}"></label><label>Övrigt exkl. moms<input type="number" min="0" step="1" data-cost="other" value="${categories.other || 0}"></label><button type="submit" class="button button-primary">Spara kostnader</button></form></details>
        </article>`;
      }).join('') : '<div class="empty-state">Skapa personalpass för att börja följa jobbens ekonomi.</div>';
    }

    function renderAll() {
      renderOverviewMetrics();
      renderStaff();
      renderWorkforce();
      renderChecklists();
      renderTimesAndCommission();
      renderFinance();
    }

    async function fetchAll(force = false) {
      if (!authorized) return;
      if (loadingPromise) return loadingPromise;
      if (loaded && !force) return;
      loadingPromise = (async () => {
        const queries = await Promise.all([
          client.from('staff_profiles').select('*').order('display_name'),
          client.from('staff_jobs').select('*').order('scheduled_start', { ascending: false }),
          client.from('staff_job_assignments').select('*'),
          client.from('checklist_templates').select('*').order('name'),
          client.from('checklist_template_items').select('*').order('sort_order'),
          client.from('staff_time_entries').select('*').order('started_at', { ascending: false }),
          client.from('staff_job_commissions').select('*').order('created_at', { ascending: false }),
          client.from('staff_job_costs').select('*'),
          client.from('staff_job_events').select('*').order('created_at', { ascending: false }).limit(200)
        ]);
        const failed = queries.find((query) => query.error);
        if (failed) throw failed.error;
        [staff, jobs, assignments, templates, templateItems, timeEntries, commissions, costs, events] = queries.map((query) => query.data || []);
        loaded = true;
        renderAll();
      })().catch((error) => {
        const message = readableError(error);
        ['staffMembersList', 'unplannedBookingsList', 'staffJobsList', 'checklistTemplatesList', 'staffTimeEntriesList', 'staffCommissionsList', 'staffJobEconomicsList'].forEach((id) => {
          const container = byId(id);
          if (container) container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
        });
      }).finally(() => { loadingPromise = null; });
      return loadingPromise;
    }

    async function refresh() {
      loaded = false;
      await fetchAll(true);
    }

    byId('staffInviteForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = byId('staffInviteButton');
      button.disabled = true;
      setMessage('staffAdminMessage', 'Skickar inbjudan…');
      try {
        await callStaffEndpoint('invite', {
          displayName: byId('staffInviteName').value.trim(),
          email: byId('staffInviteEmail').value.trim(),
          phone: byId('staffInvitePhone').value.trim(),
          role: byId('staffInviteRole').value,
          skills: byId('staffInviteSkills').value.split(',').map((item) => item.trim()).filter(Boolean)
        });
        event.target.reset();
        setMessage('staffAdminMessage', 'Inbjudan är skickad. Personen får skapa sitt eget lösenord.', 'success');
        await refresh();
      } catch (error) {
        setMessage('staffAdminMessage', readableError(error), 'error');
      } finally { button.disabled = false; }
    });

    byId('staffMembersList')?.addEventListener('click', async (event) => {
      const row = event.target.closest('[data-staff-id]');
      const button = event.target.closest('.action-deactivate-staff, .action-reactivate-staff');
      if (!row || !button) return;
      const action = button.classList.contains('action-deactivate-staff') ? 'deactivate' : 'reactivate';
      if (action === 'deactivate' && !window.confirm('Inaktivera personen? Åtkomsten till personalportalen stoppas direkt.')) return;
      button.disabled = true;
      try { await callStaffEndpoint(action, { userId: row.dataset.staffId }); await refresh(); }
      catch (error) { setMessage('staffAdminMessage', readableError(error), 'error'); button.disabled = false; }
    });

    byId('unplannedBookingsList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('.action-create-staff-job');
      const row = event.target.closest('[data-booking-id]');
      if (!button || !row) return;
      button.disabled = true;
      try {
        await rpc('admin_upsert_staff_job_from_booking', {
          p_booking_id: row.dataset.bookingId,
          p_scheduled_start: null,
          p_estimated_minutes: Number(row.querySelector('.job-estimated-minutes').value),
          p_required_staff: Number(row.querySelector('.job-required-staff').value),
          p_checklist_template_id: row.querySelector('.job-template-select').value || null
        });
        setMessage('workforceAdminMessage', 'Passet är skapat och öppet för paxning.', 'success');
        await refresh();
      } catch (error) { setMessage('workforceAdminMessage', readableError(error), 'error'); button.disabled = false; }
    });

    byId('staffJobsList')?.addEventListener('click', async (event) => {
      const card = event.target.closest('[data-job-id]');
      if (!card) return;
      const jobId = card.dataset.jobId;
      const assign = event.target.closest('.action-assign-staff');
      const release = event.target.closest('.action-release-assignment');
      const statusButton = event.target.closest('.action-job-status');
      try {
        if (assign) {
          const staffId = card.querySelector('.assignment-staff-select').value;
          if (!staffId) throw new Error('Välj vem som ska tilldelas.');
          assign.disabled = true;
          await rpc('admin_assign_staff_job', { p_job_id: jobId, p_staff_user_id: staffId });
        } else if (release) {
          if (!window.confirm('Ta bort personen från passet?')) return;
          await rpc('admin_release_staff_job', { p_job_id: jobId, p_staff_user_id: release.dataset.staffId, p_reason: 'Ändrad bemanning i admin' });
        } else if (statusButton) {
          if (statusButton.dataset.status === 'cancelled' && !window.confirm('Avbryta personalpasset? Kundbokningen påverkas inte.')) return;
          await rpc('admin_set_staff_job_status', { p_job_id: jobId, p_status: statusButton.dataset.status });
        } else return;
        await refresh();
      } catch (error) { setMessage('workforceAdminMessage', readableError(error), 'error'); if (assign) assign.disabled = false; }
    });

    byId('checklistTemplateForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const lines = byId('checklistTemplateItems').value.split('\n').map((item) => item.trim()).filter(Boolean);
      const button = byId('checklistTemplateButton');
      button.disabled = true;
      try {
        await rpc('admin_create_staff_checklist_template', {
          p_name: byId('checklistTemplateName').value.trim(),
          p_description: byId('checklistTemplateDescription').value.trim(),
          p_match_rule: byId('checklistTemplateRule').value.trim(),
          p_items: lines.map((label) => ({ label, required: true }))
        });
        event.target.reset();
        setMessage('checklistAdminMessage', 'Checklistemallen är skapad.', 'success');
        await refresh();
      } catch (error) { setMessage('checklistAdminMessage', readableError(error), 'error'); }
      finally { button.disabled = false; }
    });

    byId('checklistTemplatesList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('.action-toggle-template');
      const card = event.target.closest('[data-template-id]');
      if (!button || !card) return;
      button.disabled = true;
      const { error } = await client.from('checklist_templates').update({ active: button.dataset.active !== 'true' }).eq('id', card.dataset.templateId);
      if (error) setMessage('checklistAdminMessage', readableError(error), 'error');
      else await refresh();
    });

    byId('staffCommissionsList')?.addEventListener('click', async (event) => {
      const button = event.target.closest('.action-commission-status');
      const row = event.target.closest('[data-commission-id]');
      if (!button || !row) return;
      button.disabled = true;
      try {
        await rpc('admin_set_staff_commission_status', { p_commission_id: row.dataset.commissionId, p_status: button.dataset.status });
        await refresh();
      } catch (error) { setMessage('staffFinanceMessage', readableError(error), 'error'); button.disabled = false; }
    });

    byId('staffJobEconomicsList')?.addEventListener('submit', async (event) => {
      const form = event.target.closest('.job-cost-form');
      const card = event.target.closest('[data-job-id]');
      if (!form || !card) return;
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const payload = [...form.querySelectorAll('[data-cost]')].map((input) => ({ category: input.dataset.cost, amountExVatOre: Math.round(Number(input.value || 0) * 100) }));
        await rpc('admin_upsert_staff_job_costs', { p_job_id: card.dataset.jobId, p_costs: payload });
        setMessage('staffFinanceMessage', 'Kostnaderna är sparade.', 'success');
        await refresh();
      } catch (error) { setMessage('staffFinanceMessage', readableError(error), 'error'); button.disabled = false; }
    });

    document.querySelectorAll('[data-workforce-refresh]').forEach((button) => button.addEventListener('click', () => refresh()));

    return {
      setAuthorized(value) {
        authorized = Boolean(value);
        if (!authorized) {
          loaded = false;
          staff = []; jobs = []; assignments = []; templates = []; templateItems = []; timeEntries = []; commissions = []; costs = []; events = [];
        }
      },
      setBookings(value) {
        bookings = Array.isArray(value) ? value : [];
        if (loaded) renderWorkforce();
      },
      async load(view) {
        if (!authorized) return;
        if (view === 'overview' || WORKFORCE_VIEWS.has(view)) await fetchAll();
      },
      refresh
    };
  }

  window.bergaAdminWorkforce = { init };
})();
