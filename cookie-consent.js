(function () {
  const consentKey = 'berga_cookie_consent';
  const analyticsId = 'G-B78CWM4L6V';
  const clarityProjectId = 'xogpsbqaar';
  const clarityModuleUrl = 'https://cdn.jsdelivr.net/npm/@microsoft/clarity@1.0.2/index.js';
  let analyticsLoaded = false;
  let clarityLoaded = false;
  let modalReturnFocus = null;

  function getConsent() {
    try {
      return window.localStorage.getItem(consentKey);
    } catch (error) {
      return null;
    }
  }

  function setConsent(value) {
    try {
      window.localStorage.setItem(consentKey, value);
    } catch (error) {
      // If localStorage is unavailable, keep the choice for this page view only.
    }

    if (value === 'accepted') {
      loadAnalytics();
      loadClarity();
    } else if (window.gtag) {
      window.gtag('consent', 'update', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied'
      });
    }

    updateClarityConsent(value);

    window.dispatchEvent(new CustomEvent('berga:consent-change', {
      detail: { value }
    }));

    const modalWasOpen = Boolean(document.getElementById('cookieConsentBackdrop'));
    closeConsentUi();
    const settingsButton = renderSettingsButton();

    if (modalWasOpen) {
      settingsButton?.focus({ preventScroll: true });
    }
  }

  function loadAnalytics() {
    if (analyticsLoaded || document.querySelector(`script[src*="${analyticsId}"]`)) return;
    analyticsLoaded = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };

    window.gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });

    const analyticsScript = document.createElement('script');
    analyticsScript.async = true;
    analyticsScript.src = `https://www.googletagmanager.com/gtag/js?id=${analyticsId}`;
    document.head.appendChild(analyticsScript);

    window.gtag('js', new Date());
    window.gtag('config', analyticsId);
  }

  async function loadClarity() {
    if (
      clarityLoaded ||
      !clarityProjectId ||
      clarityProjectId === 'REPLACE_WITH_CLARITY_PROJECT_ID'
    ) {
      return;
    }

    try {
      const { default: Clarity } = await import(clarityModuleUrl);
      Clarity.init(clarityProjectId);
      Clarity.consentV2({
        ad_Storage: 'denied',
        analytics_Storage: 'granted'
      });
      window.bergaClarity = Clarity;
      clarityLoaded = true;
    } catch (error) {
      console.error('Clarity kunde inte laddas.', error);
    }
  }

  function updateClarityConsent(value) {
    const clarity = window.bergaClarity;
    if (!clarity?.consentV2) return;

    clarity.consentV2(
      value === 'accepted'
        ? { ad_Storage: 'denied', analytics_Storage: 'granted' }
        : { ad_Storage: 'denied', analytics_Storage: 'denied' }
    );
  }

  function closeConsentUi() {
    document.getElementById('cookieConsentBanner')?.remove();
    closeCookieModal(false);
  }

  function closeCookieModal(restoreFocus = true) {
    const backdrop = document.getElementById('cookieConsentBackdrop');
    if (!backdrop) return;

    backdrop.remove();

    const returnTarget = modalReturnFocus;
    modalReturnFocus = null;

    if (restoreFocus && returnTarget?.isConnected) {
      returnTarget.focus({ preventScroll: true });
    }
  }

  function getModalFocusableElements(dialog) {
    return Array.from(dialog.querySelectorAll([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(','))).filter((element) => {
      return !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true';
    });
  }

  function renderBanner() {
    if (document.getElementById('cookieConsentBanner')) return;

    const banner = document.createElement('section');
    banner.className = 'cookie-consent-banner';
    banner.id = 'cookieConsentBanner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-labelledby', 'cookieConsentTitle');
    banner.setAttribute('aria-describedby', 'cookieConsentSummary');
    banner.innerHTML = `
      <div>
        <h2 id="cookieConsentTitle">Cookies</h2>
        <p id="cookieConsentSummary">Vi använder nödvändig teknik för sidan och laddar Google Analytics och Microsoft Clarity först om du godkänner analyscookies. <a href="integritet.html">Läs integritetspolicyn</a>.</p>
      </div>
      <div class="cookie-actions">
        <button type="button" class="cookie-button cookie-button-primary" data-cookie-accept>Acceptera analyscookies</button>
        <button type="button" class="cookie-button" data-cookie-necessary>Endast nödvändiga</button>
        <button type="button" class="cookie-button cookie-button-ghost" data-cookie-details>Läs mer</button>
      </div>
    `;
    document.body.appendChild(banner);
    bindConsentButtons(banner);
  }

  function renderModal() {
    const existingDialog = document.querySelector('#cookieConsentBackdrop .cookie-consent-modal');
    if (existingDialog) {
      existingDialog.focus({ preventScroll: true });
      return;
    }

    modalReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const backdrop = document.createElement('div');
    backdrop.className = 'cookie-backdrop';
    backdrop.id = 'cookieConsentBackdrop';
    backdrop.innerHTML = `
      <div class="cookie-consent-modal" role="dialog" aria-modal="true" aria-labelledby="cookieModalTitle" aria-describedby="cookieModalDescription" tabindex="-1">
        <h2 id="cookieModalTitle">Vad är cookies?</h2>
        <p id="cookieModalDescription">Cookies är små textfiler som sparas på din enhet när du besöker en hemsida. De används för att få hemsidan att fungera korrekt, förbättra användarupplevelsen och analysera trafik.</p>

        <h3>Vilka cookies eller liknande teknik använder vi?</h3>
        <h3>Nödvändiga cookies eller liknande teknik</h3>
        <p>Hemsidan använder nödvändig teknik för att fungera korrekt. Vi sparar även ditt cookieval lokalt i webbläsaren så att du slipper välja igen vid nästa besök.</p>

        <h3>Analyscookies</h3>
        <p>Vi kan använda analystjänster, exempelvis Google Analytics och Microsoft Clarity, för att förstå hur besökare använder hemsidan och för att förbättra innehåll och funktioner.</p>
        <p>Informationen används endast för statistik och utveckling av hemsidan.</p>

        <h3>Hur kan du kontrollera cookies?</h3>
        <p>Du kan själv välja att blockera eller radera cookies via inställningarna i din webbläsare.</p>
        <p>Observera att vissa funktioner på hemsidan kan påverkas om cookies stängs av.</p>

        <h3>Kontakt</h3>
        <p>Har du frågor om vår användning av cookies är du välkommen att kontakta oss på:</p>
        <p><strong>info@bergafonsterputs.se</strong></p>
        <p><a href="integritet.html">Läs mer i vår integritetspolicy</a></p>

        <div class="cookie-modal-actions">
          <button type="button" class="cookie-button cookie-button-primary" data-cookie-accept>Acceptera analyscookies</button>
          <button type="button" class="cookie-button" data-cookie-necessary>Endast nödvändiga</button>
          <button type="button" class="cookie-button cookie-button-ghost" data-cookie-close>Stäng</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    bindConsentButtons(backdrop);

    const dialog = backdrop.querySelector('.cookie-consent-modal');

    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCookieModal();
        return;
      }

      if (event.key !== 'Tab' || !dialog) return;

      const focusableElements = getModalFocusableElements(dialog);
      if (!focusableElements.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === dialog || activeElement === firstElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (activeElement === lastElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus();
      }
    });

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeCookieModal();
    });

    dialog?.focus({ preventScroll: true });
  }

  function renderSettingsButton() {
    const existingButton = document.getElementById('cookieSettingsButton');
    if (existingButton) return existingButton;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cookie-settings-button';
    button.id = 'cookieSettingsButton';
    button.textContent = 'Cookieinställningar';
    button.addEventListener('click', renderModal);
    document.body.appendChild(button);
    return button;
  }

  function bindConsentButtons(root) {
    root.querySelectorAll('[data-cookie-accept]').forEach((button) => {
      button.addEventListener('click', () => setConsent('accepted'));
    });
    root.querySelectorAll('[data-cookie-necessary]').forEach((button) => {
      button.addEventListener('click', () => setConsent('necessary'));
    });
    root.querySelectorAll('[data-cookie-details]').forEach((button) => {
      button.addEventListener('click', renderModal);
    });
    root.querySelectorAll('[data-cookie-close]').forEach((button) => {
      button.addEventListener('click', () => {
        closeCookieModal();
      });
    });
  }

  function initCookieConsent() {
    const consent = getConsent();
    if (consent === 'accepted') {
      loadAnalytics();
      loadClarity();
      renderSettingsButton();
      return;
    }

    if (consent === 'necessary') {
      renderSettingsButton();
      return;
    }

    renderBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCookieConsent);
  } else {
    initCookieConsent();
  }
})();
