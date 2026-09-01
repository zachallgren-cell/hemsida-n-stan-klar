(() => {
  'use strict';

  const SUPABASE_ANON_KEY = 'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq';
  const PAX_FUNCTION_URL = 'https://xeyippgcoqfskcmqzazx.functions.supabase.co/submit-spring-pax';
  const ATTRIBUTION_KEY = 'bergaCampaignAttribution';
  const form = document.getElementById('paxForm');
  if (!form) return;

  const submitButton = document.getElementById('paxSubmitButton');
  const status = document.getElementById('paxStatus');
  const confirmation = document.getElementById('paxConfirmation');
  const confirmationTitle = document.getElementById('paxConfirmationTitle');
  const formStartedAt = document.getElementById('paxFormStartedAt');
  const requestId = document.getElementById('paxRequestId');
  let startedTracked = false;

  function createRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const values = new Uint8Array(16);
    window.crypto.getRandomValues(values);
    values[6] = (values[6] & 0x0f) | 0x40;
    values[8] = (values[8] & 0x3f) | 0x80;
    const hex = Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function resetGuards() {
    formStartedAt.value = String(Date.now());
    requestId.value = createRequestId();
  }

  function getAttribution() {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(ATTRIBUTION_KEY) || '{}');
      return {
        utmSource: String(stored.utmSource || '').slice(0, 160),
        utmMedium: String(stored.utmMedium || '').slice(0, 160),
        utmCampaign: String(stored.utmCampaign || '').slice(0, 160),
        utmContent: String(stored.utmContent || '').slice(0, 160),
        utmTerm: String(stored.utmTerm || '').slice(0, 160),
        attributionRef: stored.referral === 'referral' ? 'referral' : '',
        landingPage: String(stored.landingPage || '').slice(0, 160)
      };
    } catch {
      return {};
    }
  }

  function setStatus(message, state = 'error') {
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  function trackStarted() {
    if (startedTracked) return;
    startedTracked = true;
    window.bergaTrack?.('spring_2027_pax_started', { page_path: window.location.pathname });
  }

  form.addEventListener('focusin', trackStarted, { once: true });
  form.addEventListener('input', trackStarted, { once: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');
    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitButton.textContent = 'Paxar din plats…';
    window.bergaTrack?.('spring_2027_pax_submitted', { page_path: window.location.pathname });

    const data = new FormData(form);
    const payload = {
      requestId: requestId.value,
      formStartedAt: formStartedAt.value,
      website: String(data.get('website') || ''),
      name: String(data.get('name') || '').trim(),
      phone: String(data.get('phone') || '').trim(),
      email: String(data.get('email') || '').trim(),
      location: String(data.get('location') || '').trim(),
      requestedPeriod: String(data.get('requestedPeriod') || 'flexible'),
      serviceInterest: String(data.get('serviceInterest') || 'unsure'),
      message: String(data.get('message') || '').trim(),
      ...getAttribution()
    };

    try {
      const response = await fetch(PAX_FUNCTION_URL, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) {
        throw new Error(body.error || 'Paxningen kunde inte skickas. Försök igen.');
      }

      form.hidden = true;
      confirmation.hidden = false;
      confirmation.dataset.receiptSent = body.receiptSent ? 'true' : 'false';
      confirmationTitle.focus();
      window.bergaTrack?.('spring_2027_pax_completed', {
        page_path: window.location.pathname,
        requested_period: payload.requestedPeriod,
        service_interest: payload.serviceInterest
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Något gick fel. Försök igen senare.');
      window.bergaTrack?.('spring_2027_pax_error', { page_path: window.location.pathname });
      resetGuards();
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      submitButton.textContent = 'Paxa min plats';
    }
  });

  resetGuards();
})();
