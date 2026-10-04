import { validateApplication } from './job-application-shared.mjs?v=20261004-3';
const form = document.getElementById('jobForm');
const button = document.getElementById('jobSubmit');
const status = document.getElementById('jobStatus');
const requestId = crypto.randomUUID();
let formStartedAt = String(Date.now());
let sending = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !form.reportValidity()) return;
  status.hidden = true;
  try {
    const raw = Object.fromEntries(new FormData(form));
    const answers = validateApplication(raw);
    sending = true;
    button.disabled = true;
    button.setAttribute('aria-busy','true');
    button.textContent = 'Skickar ansökan…';
    const response = await fetch('https://xeyippgcoqfskcmqzazx.functions.supabase.co/submit-job-application', {
      method:'POST', headers:{ apikey:'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq', 'Content-Type':'application/json' },
      body:JSON.stringify({ ...answers, requestId, formStartedAt, website:raw.website }),
      signal:AbortSignal.timeout(20000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true || !body.applicationId) throw new Error(body.error || 'Ansökan kunde inte bekräftas. Försök igen.');
    form.hidden = true;
    document.getElementById('jobConfirmation').hidden = false;
    document.getElementById('jobReceipt').textContent = `Ansöknings-ID: ${body.applicationId}`;
    document.getElementById('jobConfirmationTitle').focus();
  } catch(error) {
    status.textContent = error.name === 'TypeError' ? 'Kunde inte få bekräftelse från servern. Dina svar finns kvar. Kontrollera internetanslutningen och försök igen.' : error.name === 'TimeoutError' ? 'Servern svarade inte i tid. Dina svar finns kvar. Försök igen.' : (error.message || 'Ansökan kunde inte skickas. Dina svar finns kvar. Försök igen.');
    status.hidden = false;
    status.focus();
    if (Date.now() - Number(formStartedAt) > 86400000) formStartedAt = String(Date.now() - 2000);
  } finally {
    sending = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Skicka ansökan';
  }
});
