(function () {
  const consentKey = 'berga_cookie_consent';
  const analyticsId = 'G-B78CWM4L6V';
  let analyticsLoaded = false;

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
    } else if (window.gtag) {
      window.gtag('consent', 'update', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied'
      });
    }

    closeConsentUi();
    renderSettingsButton();
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

  function closeConsentUi() {
    document.getElementById('cookieConsentBanner')?.remove();
    document.getElementById('cookieConsentBackdrop')?.remove();
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
        <p id="cookieConsentSummary">Vi använder nödvändig teknik för sidan och Google Analytics först om du godkänner analyscookies.</p>
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
    if (document.getElementById('cookieConsentBackdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'cookie-backdrop';
    backdrop.id = 'cookieConsentBackdrop';
    backdrop.innerHTML = `
      <div class="cookie-consent-modal" role="dialog" aria-modal="true" aria-labelledby="cookieModalTitle">
        <h2 id="cookieModalTitle">Vad är cookies?</h2>
        <p>Cookies är små textfiler som sparas på din enhet när du besöker en hemsida. De används för att få hemsidan att fungera korrekt, förbättra användarupplevelsen och analysera trafik.</p>

        <h3>Vilka cookies eller liknande teknik använder vi?</h3>
        <h3>Nödvändiga cookies eller liknande teknik</h3>
        <p>Hemsidan använder nödvändig teknik för att fungera korrekt. Vi sparar även ditt cookieval lokalt i webbläsaren så att du slipper välja igen vid nästa besök.</p>

        <h3>Analyscookies</h3>
        <p>Vi kan använda analystjänster, exempelvis Google Analytics, för att förstå hur besökare använder hemsidan och för att förbättra innehåll och funktioner.</p>
        <p>Informationen används endast för statistik och utveckling av hemsidan.</p>

        <h3>Hur kan du kontrollera cookies?</h3>
        <p>Du kan själv välja att blockera eller radera cookies via inställningarna i din webbläsare.</p>
        <p>Observera att vissa funktioner på hemsidan kan påverkas om cookies stängs av.</p>

        <h3>Kontakt</h3>
        <p>Har du frågor om vår användning av cookies är du välkommen att kontakta oss på:</p>
        <p><strong>info@bergafonsterputs.se</strong></p>

        <div class="cookie-modal-actions">
          <button type="button" class="cookie-button cookie-button-primary" data-cookie-accept>Acceptera analyscookies</button>
          <button type="button" class="cookie-button" data-cookie-necessary>Endast nödvändiga</button>
          <button type="button" class="cookie-button cookie-button-ghost" data-cookie-close>Stäng</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    bindConsentButtons(backdrop);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
  }

  function renderSettingsButton() {
    if (document.getElementById('cookieSettingsButton')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cookie-settings-button';
    button.id = 'cookieSettingsButton';
    button.textContent = 'Cookieinställningar';
    button.addEventListener('click', renderModal);
    document.body.appendChild(button);
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
        document.getElementById('cookieConsentBackdrop')?.remove();
      });
    });
  }

  function initCookieConsent() {
    const consent = getConsent();
    if (consent === 'accepted') {
      loadAnalytics();
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
