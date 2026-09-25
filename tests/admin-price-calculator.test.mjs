import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
await import(new URL('../admin-price-calculator.js', import.meta.url));

const { calculatePrice } = globalThis.bergaAdminPriceCalculator;

test('priskalkylatorn är en egen adminvy med responsiv layout', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('admin.html', root), 'utf8'),
    readFile(new URL('admin-price-calculator.css', root), 'utf8')
  ]);

  assert.match(html, /data-admin-view="priceCalculator"/);
  assert.match(html, /id="priceCalculatorPanel"/);
  assert.match(html, /id="priceCalculatorForm"/);
  assert.match(html, /admin-price-calculator\.js\?v=20260925/);
  assert.match(css, /@media \(max-width: 680px\)/);
});

test('grundpris och flerplanspris matchar bokningens prisregler', () => {
  const base = calculatePrice({
    housingType: 'one-floor',
    regularWindows: 10,
    muntinsWindows: 0,
    serviceScope: 'exterior',
    transportType: 'mainland',
    usesRut: true
  });
  const multiFloorWithoutRut = calculatePrice({
    housingType: 'multi-floor',
    regularWindows: 10,
    muntinsWindows: 0,
    serviceScope: 'exterior',
    transportType: 'mainland',
    usesRut: false
  });

  assert.equal(base.customerPrice, 949);
  assert.equal(base.laborBeforeRut, 1598);
  assert.equal(base.rutDeduction, 799);
  assert.equal(multiFloorWithoutRut.customerPrice, 2148);
  assert.equal(multiFloorWithoutRut.rutDeduction, 0);
});

test('adminens prisnivåer hålls synkade med kundbokningen', async () => {
  const bookingClient = await readFile(new URL('booking.js', root), 'utf8');
  const expectedConstants = {
    BASE_LABOR_PRICE_AFTER_RUT: globalThis.bergaAdminPriceCalculator.prices.baseLaborAfterRut,
    MATERIAL_FEE: globalThis.bergaAdminPriceCalculator.prices.material,
    INCLUDED_WINDOWS: globalThis.bergaAdminPriceCalculator.prices.includedWindows,
    TWO_FLOOR_ADDON: globalThis.bergaAdminPriceCalculator.prices.multiFloor,
    EXTRA_REGULAR_WINDOW_PRICE: globalThis.bergaAdminPriceCalculator.prices.extraRegularWindow,
    EXTRA_MUNTINS_WINDOW_PRICE: globalThis.bergaAdminPriceCalculator.prices.extraMuntinsWindow,
    INTERIOR_BASE_ADDON: globalThis.bergaAdminPriceCalculator.prices.interiorBase,
    INTERIOR_EXTRA_WINDOW_PRICE: globalThis.bergaAdminPriceCalculator.prices.interiorExtraWindow,
    ISLAND_START_PRICE: globalThis.bergaAdminPriceCalculator.prices.boatStart,
    ISLAND_PRICE_PER_SEA_MILE: globalThis.bergaAdminPriceCalculator.prices.boatPerSeaMile
  };

  for (const [name, value] of Object.entries(expectedConstants)) {
    assert.match(bookingClient, new RegExp(`const ${name} = ${value};`));
  }
});

test('extra fönster, spröjs och invändig puts räknas på samma sätt som i bokningen', () => {
  const price = calculatePrice({
    housingType: 'apartment-inward',
    regularWindows: 12,
    muntinsWindows: 1,
    serviceScope: 'interior-exterior',
    transportType: 'mainland',
    usesRut: true
  });

  assert.equal(price.extraRegular, 2);
  assert.equal(price.extraMuntins, 1);
  assert.equal(price.laborAfterRut, 1363);
  assert.equal(price.customerPrice, 1513);
});

test('båttransport läggs utanför RUT och går över till offert efter 15 sjömil', () => {
  const direct = calculatePrice({
    housingType: 'one-floor',
    regularWindows: 10,
    serviceScope: 'exterior',
    transportType: 'boat',
    seaMiles: 5,
    usesRut: true
  });
  const quote = calculatePrice({
    housingType: 'one-floor',
    regularWindows: 10,
    serviceScope: 'exterior',
    transportType: 'boat',
    seaMiles: 16,
    usesRut: true
  });

  assert.equal(direct.transportCost, 1424);
  assert.equal(direct.customerPrice, 2373);
  assert.equal(quote.requiresQuote, true);
  assert.equal(quote.customerPrice, null);
});
