document.documentElement.classList.add('js');

(() => {
  const CONSENT_KEY = 'berga_cookie_consent';
  const ATTRIBUTION_KEY = 'bergaCampaignAttribution';

  function consentAccepted() {
    try {
      return window.localStorage.getItem(CONSENT_KEY) === 'accepted';
    } catch {
      return false;
    }
  }

  function cleanEventValue(value, maxLength = 180) {
    return String(value || '').trim().slice(0, maxLength);
  }

  window.bergaTrack = function bergaTrack(eventName, parameters = {}) {
    if (!consentAccepted()) return false;

    const safeEventName = cleanEventValue(eventName, 80).replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!safeEventName) return false;

    const safeParameters = {};
    Object.entries(parameters).forEach(([key, value]) => {
      if (typeof value === 'string') safeParameters[key] = cleanEventValue(value);
      else if (typeof value === 'number' || typeof value === 'boolean') safeParameters[key] = value;
    });

    let tracked = false;
    if (typeof window.gtag === 'function') {
      window.gtag('event', safeEventName, safeParameters);
      tracked = true;
    }
    if (typeof window.clarity === 'function') {
      // Clarity får endast eventnamnet. Parametrar kan innehålla bokningsdata och
      // skickas därför aldrig vidare till Clarity.
      window.clarity('event', safeEventName);
      tracked = true;
    }
    return tracked;
  };

  // Attribution belongs to this tab only; never persist it before analytics consent.
  const VISIT_TIMEOUT = 30 * 60 * 1000;
  const cleanTag = value => {
    const text = String(value || '').trim();
    return text.length <= 120 && /^[\p{L}\p{N} _.,~+\-]+$/u.test(text)
      && !/\d{7}/.test(text) ? text : '';
  };
  const ownHost = host => /^(www\.)?bergafonsterputs\.se$/i.test(host);
  function readAttribution(touch = false) {
    try {
      if (!consentAccepted()) { window.sessionStorage.removeItem(ATTRIBUTION_KEY); window.sessionStorage.removeItem('bergaReferralLandingTracked'); return {}; }
      const stored = JSON.parse(window.sessionStorage.getItem(ATTRIBUTION_KEY) || '{}');
      if (stored.version !== 2 || !stored.lastActivity || Date.now() - stored.lastActivity >= VISIT_TIMEOUT) {
        window.sessionStorage.removeItem(ATTRIBUTION_KEY); window.sessionStorage.removeItem('bergaReferralLandingTracked'); return {};
      }
      if (touch) {
        stored.lastActivity = Date.now();
        window.sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(stored));
      }
      return stored;
    } catch { return {}; }
  }
  window.bergaAttribution = { get: () => readAttribution(true) };
  function captureCampaignAttribution() {
    try {
      if (!consentAccepted()) { window.sessionStorage.removeItem(ATTRIBUTION_KEY); window.sessionStorage.removeItem('bergaReferralLandingTracked'); return; }
      const previous = readAttribution();
      let referrerHost = '', internal = false;
      if (document.referrer) {
        const referrer = new URL(document.referrer);
        internal = ownHost(referrer.hostname) || referrer.hostname === window.location.hostname;
        if (!internal && /^https?:$/.test(referrer.protocol)) referrerHost = referrer.hostname.toLowerCase();
      }
      const params = new URLSearchParams(window.location.search);
      const attribution = {
        utmSource: cleanTag(params.get('utm_source')),
        utmMedium: cleanTag(params.get('utm_medium')),
        utmCampaign: cleanTag(params.get('utm_campaign')),
        utmContent: cleanTag(params.get('utm_content')),
        utmTerm: cleanTag(params.get('utm_term')),
        referral: params.has('ref') ? 'referral' : '',
        referrerHost,
        landingPage: '' // No path, query string, customer token or click ID is stored.
      };
      const identifiable = attribution.utmSource || attribution.referrerHost || attribution.referral;
      const partial = Object.values(attribution).some(Boolean);
      const next = !internal && (identifiable || (!Object.keys(previous).length && partial)) ? attribution : previous;
      if (Object.keys(next).length) window.sessionStorage.setItem(ATTRIBUTION_KEY,
        JSON.stringify({ ...next, version: 2, lastActivity: Date.now() }));
      if (!internal && attribution.referral && !window.sessionStorage.getItem('bergaReferralLandingTracked')) {
        window.sessionStorage.setItem('bergaReferralLandingTracked', '1');
        window.bergaTrack('referral_landing_view');
      }
    } catch { /* Attribution must never prevent navigation or booking. */ }
  }
  // Renew activity only through interaction, never through an automatic timer.
  for (const event of ['pointerdown', 'keydown', 'change']) {
    document.addEventListener(event, () => readAttribution(true), { passive: true });
  }

  function initMenu() {
    const toggle = document.querySelector('[data-menu-toggle]');
    const nav = document.querySelector('[data-site-nav]');
    if (!toggle || !nav) return;

    const closeMenu = (returnFocus = false) => {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Öppna meny');
      nav.dataset.open = 'false';
      document.body.classList.remove('menu-open');
      if (returnFocus) toggle.focus();
    };

    const openMenu = () => {
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Stäng meny');
      nav.dataset.open = 'true';
      document.body.classList.add('menu-open');
      nav.querySelector('a')?.focus();
    };

    toggle.addEventListener('click', () => {
      if (toggle.getAttribute('aria-expanded') === 'true') closeMenu();
      else openMenu();
    });

    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        closeMenu(true);
      }
    });

    document.addEventListener('click', (event) => {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      if (!nav.contains(event.target) && !toggle.contains(event.target)) closeMenu();
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 920) closeMenu();
    });
  }

  function initTrackedLinks() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (!link) return;
      const href = (link.getAttribute('href') || '').toLowerCase();

      if (link.matches('[data-pax-cta]')) {
        window.bergaTrack('spring_2027_pax_cta_click', {
          cta_text: link.textContent,
          cta_location: link.dataset.ctaLocation || 'unspecified',
          destination: link.getAttribute('href') || '',
          page_path: window.location.pathname
        });
      }

      if (link.matches('[data-booking-cta]') || href === 'bokning.html' || href.startsWith('bokning.html?')) {
        window.bergaTrack('booking_cta_click', {
          cta_text: link.textContent,
          cta_location: link.dataset.ctaLocation || 'unspecified',
          destination: link.getAttribute('href') || '',
          page_path: window.location.pathname
        });
      }

      if (href.startsWith('mailto:')) {
        window.bergaTrack('email_click', {
          link_text: link.textContent,
          link_location: link.dataset.ctaLocation || 'unspecified',
          page_path: window.location.pathname
        });
      }

      if (href.startsWith('tel:')) {
        window.bergaTrack('phone_click', {
          link_text: link.textContent,
          link_location: link.dataset.ctaLocation || 'unspecified',
          page_path: window.location.pathname
        });
      }
    });
  }

  function initCookieAwareness() {
    window.addEventListener('berga:consent-change', (event) => {
      if (event.detail?.value === 'accepted') captureCampaignAttribution();
      else {
        try {
          window.sessionStorage.removeItem(ATTRIBUTION_KEY);
          window.sessionStorage.removeItem('bergaReferralLandingTracked');
        } catch {
          // Lagringsfel ska inte påverka webbplatsen.
        }
      }
    });
  }

  initMenu();
  initTrackedLinks();
  initCookieAwareness();
  captureCampaignAttribution();
})();
