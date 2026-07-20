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
    if (!consentAccepted() || typeof window.gtag !== 'function') return false;

    const safeParameters = {};
    Object.entries(parameters).forEach(([key, value]) => {
      if (typeof value === 'string') safeParameters[key] = cleanEventValue(value);
      else if (typeof value === 'number' || typeof value === 'boolean') safeParameters[key] = value;
    });

    window.gtag('event', cleanEventValue(eventName, 80), safeParameters);
    return true;
  };

  function captureCampaignAttribution() {
    try {
      if (!consentAccepted()) {
        window.sessionStorage.removeItem(ATTRIBUTION_KEY);
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const attribution = {
        utmSource: cleanEventValue(params.get('utm_source'), 160),
        utmMedium: cleanEventValue(params.get('utm_medium'), 160),
        utmCampaign: cleanEventValue(params.get('utm_campaign'), 160),
        utmContent: cleanEventValue(params.get('utm_content'), 160),
        utmTerm: cleanEventValue(params.get('utm_term'), 160),
        landingPage: cleanEventValue(window.location.pathname, 160)
      };

      const hasCampaignData = attribution.utmSource
        || attribution.utmMedium
        || attribution.utmCampaign
        || attribution.utmContent
        || attribution.utmTerm;

      if (hasCampaignData) {
        window.sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(attribution));
      }
    } catch {
      // Kampanjmätning får aldrig hindra navigation eller bokning.
    }
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
