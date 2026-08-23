import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function runSite(search, consent = 'accepted') {
  const sessionStorage = storage();
  const events = [];
  const classList = { add() {}, remove() {} };
  const document = {
    documentElement: { classList }, body: { classList },
    querySelector: () => null,
    addEventListener() {}
  };
  const window = {
    location: { search, pathname: '/kampanj.html' },
    localStorage: storage({ berga_cookie_consent: consent }),
    sessionStorage,
    addEventListener() {},
    clarity: (...args) => events.push(args),
    gtag: (...args) => events.push(args),
    innerWidth: 1200
  };
  const context = vm.createContext({ window, document, URLSearchParams, Object, String, JSON });
  vm.runInContext(fs.readFileSync('site.js', 'utf8'), context);
  return { window, sessionStorage, events };
}

test('preserves UTM attribution but never stores a raw referral identity', () => {
  const result = runSite('?utm_source=facebook&utm_medium=paid_social&utm_campaign=villa&ref=private-customer-id');
  const stored = JSON.parse(result.sessionStorage.getItem('bergaCampaignAttribution'));
  assert.equal(stored.utmSource, 'facebook');
  assert.equal(stored.utmMedium, 'paid_social');
  assert.equal(stored.referral, 'referral');
  assert.equal(JSON.stringify(stored).includes('private-customer-id'), false);
  assert.equal(result.events.some((entry) => entry.includes('referral_landing_view')), true);
});

test('does not retain attribution without analytics consent', () => {
  const result = runSite('?utm_source=facebook&ref=private-customer-id', 'necessary');
  assert.equal(result.sessionStorage.getItem('bergaCampaignAttribution'), null);
  assert.equal(result.events.length, 0);
});

test('sensitive forms and booking details are explicitly masked', () => {
  for (const file of ['bokning.html', 'offert.html', 'rut.html', 'hantera-bokning.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.equal(html.includes('data-clarity-mask="true"'), true, `${file} lacks Clarity mask`);
  }
});
