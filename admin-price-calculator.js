((global) => {
  'use strict';

  const PRICES = Object.freeze({
    baseLaborAfterRut: 799,
    material: 150,
    includedWindows: 10,
    maxWindows: 250,
    multiFloor: 200,
    extraRegularWindow: 39,
    extraMuntinsWindow: 49,
    interiorBase: 320,
    interiorExtraWindow: 39,
    fourSidedBase: 620,
    fourSidedExtraWindow: 78,
    boatStart: 799,
    boatPerSeaMile: 125,
    maxDirectSeaMiles: 15
  });

  const HOUSING_LABELS = Object.freeze({
    'one-floor': 'Enplansvilla',
    'multi-floor': 'Flerplansvilla',
    'apartment-inward': 'Lägenhet – fönstren öppnas inåt',
    'apartment-outward': 'Lägenhet – fönstren öppnas utåt'
  });

  const SERVICE_LABELS = Object.freeze({
    exterior: 'Endast utvändig',
    'interior-exterior': 'Invändig + utvändig',
    'four-sided': 'Fyrsidiga fönster'
  });

  function toWholeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }

  function calculatePrice(input = {}) {
    const regularWindows = toWholeNumber(input.regularWindows);
    const muntinsWindows = toWholeNumber(input.muntinsWindows);
    const totalWindows = regularWindows + muntinsWindows;
    const housingType = HOUSING_LABELS[input.housingType] ? input.housingType : 'one-floor';
    const serviceScope = SERVICE_LABELS[input.serviceScope] ? input.serviceScope : 'exterior';
    const usesRut = input.usesRut !== false;
    const usesBoat = input.transportType === 'boat';
    const seaMiles = toWholeNumber(input.seaMiles);
    const errors = [];

    if (totalWindows < 1) errors.push('Ange minst ett fönster.');
    if (totalWindows > PRICES.maxWindows) errors.push(`Du kan räkna på högst ${PRICES.maxWindows} fönster.`);

    const includedRegular = Math.min(regularWindows, PRICES.includedWindows);
    const includedMuntins = Math.min(muntinsWindows, Math.max(0, PRICES.includedWindows - includedRegular));
    const extraRegular = Math.max(0, regularWindows - includedRegular);
    const extraMuntins = Math.max(0, muntinsWindows - includedMuntins);
    const extraWindows = Math.max(0, totalWindows - PRICES.includedWindows);
    const hasMultiFloorPrice = housingType === 'multi-floor' || housingType === 'apartment-outward';
    const floorAddon = hasMultiFloorPrice ? PRICES.multiFloor : 0;
    const windowAddon = (extraRegular * PRICES.extraRegularWindow)
      + (extraMuntins * PRICES.extraMuntinsWindow);
    const serviceAddon = serviceScope === 'interior-exterior'
      ? PRICES.interiorBase + (extraWindows * PRICES.interiorExtraWindow)
      : serviceScope === 'four-sided'
        ? PRICES.fourSidedBase + (extraWindows * PRICES.fourSidedExtraWindow)
        : 0;
    const requiresQuote = usesBoat && seaMiles > PRICES.maxDirectSeaMiles;
    const transportCost = usesBoat && !requiresQuote
      ? PRICES.boatStart + (seaMiles * PRICES.boatPerSeaMile)
      : usesBoat ? null : 0;
    const laborAfterRut = PRICES.baseLaborAfterRut + floorAddon + windowAddon + serviceAddon;
    const laborBeforeRut = laborAfterRut * 2;
    const rutDeduction = usesRut ? laborAfterRut : 0;
    const priceBeforeRut = transportCost === null
      ? null
      : laborBeforeRut + PRICES.material + transportCost;
    const customerPrice = priceBeforeRut === null ? null : priceBeforeRut - rutDeduction;

    return {
      errors,
      requiresQuote,
      regularWindows,
      muntinsWindows,
      totalWindows,
      extraRegular,
      extraMuntins,
      extraWindows,
      housingType,
      housingLabel: HOUSING_LABELS[housingType],
      serviceScope,
      serviceLabel: SERVICE_LABELS[serviceScope],
      usesRut,
      usesBoat,
      seaMiles,
      laborAfterRut,
      laborBeforeRut,
      materialCost: PRICES.material,
      transportCost,
      rutDeduction,
      priceBeforeRut,
      customerPrice
    };
  }

  const api = Object.freeze({ calculatePrice, prices: PRICES });
  global.bergaAdminPriceCalculator = api;

  if (typeof document === 'undefined') return;

  const form = document.getElementById('priceCalculatorForm');
  if (!form) return;

  const elements = {
    housingType: document.getElementById('calculatorHousingType'),
    rutChoice: document.getElementById('calculatorRutChoice'),
    regularWindows: document.getElementById('calculatorRegularWindows'),
    muntinsWindows: document.getElementById('calculatorMuntinsWindows'),
    serviceScope: document.getElementById('calculatorServiceScope'),
    transportType: document.getElementById('calculatorTransportType'),
    seaMilesField: document.getElementById('calculatorSeaMilesField'),
    seaMiles: document.getElementById('calculatorSeaMiles'),
    total: document.getElementById('priceCalculatorTotal'),
    totalLabel: document.getElementById('priceCalculatorResultTitle'),
    summary: document.getElementById('priceCalculatorSummary'),
    laborBeforeRut: document.getElementById('calculatorLaborBeforeRut'),
    materialCost: document.getElementById('calculatorMaterialCost'),
    transportCost: document.getElementById('calculatorTransportCost'),
    priceBeforeRut: document.getElementById('calculatorPriceBeforeRut'),
    rutDeduction: document.getElementById('calculatorRutDeduction'),
    message: document.getElementById('priceCalculatorMessage'),
    reset: document.getElementById('priceCalculatorReset'),
    copy: document.getElementById('priceCalculatorCopy'),
    copyStatus: document.getElementById('priceCalculatorCopyStatus')
  };

  let latestCalculation = null;

  function formatSek(value) {
    return value === null ? 'Fastställs i offert' : `${Math.round(value).toLocaleString('sv-SE')} kr`;
  }

  function getInput() {
    return {
      housingType: elements.housingType.value,
      usesRut: elements.rutChoice.value === 'with-rut',
      regularWindows: elements.regularWindows.value,
      muntinsWindows: elements.muntinsWindows.value,
      serviceScope: elements.serviceScope.value,
      transportType: elements.transportType.value,
      seaMiles: elements.seaMiles.value
    };
  }

  function buildSummary(calculation) {
    const transport = calculation.usesBoat
      ? `${calculation.seaMiles} sjömil med båt`
      : 'fastland';
    return `${calculation.housingLabel} · ${calculation.totalWindows} fönster · ${calculation.serviceLabel.toLowerCase()} · ${transport}`;
  }

  function buildClipboardText(calculation) {
    if (calculation.errors.length) return '';
    const lines = [
      'Priskalkyl – Berga Fönsterputs',
      `Bostad: ${calculation.housingLabel}`,
      `Fönster: ${calculation.totalWindows} (${calculation.regularWindows} utan spröjs, ${calculation.muntinsWindows} med spröjs)`,
      `Putsning: ${calculation.serviceLabel}`,
      `Transport: ${calculation.usesBoat ? `${calculation.seaMiles} sjömil med båt` : 'Fastland'}`,
      `Arbetskostnad före RUT: ${formatSek(calculation.laborBeforeRut)}`,
      `Material: ${formatSek(calculation.materialCost)}`,
      `Transportkostnad: ${formatSek(calculation.transportCost)}`
    ];

    if (calculation.requiresQuote) {
      lines.push('Totalpris: Offert krävs för båttransport över 15 sjömil');
    } else {
      lines.push(`Pris före RUT: ${formatSek(calculation.priceBeforeRut)}`);
      lines.push(`RUT-avdrag: ${calculation.rutDeduction ? `−${formatSek(calculation.rutDeduction)}` : formatSek(0)}`);
      lines.push(`Att betala: ${formatSek(calculation.customerPrice)}`);
    }

    return lines.join('\n');
  }

  function render() {
    const calculation = calculatePrice(getInput());
    latestCalculation = calculation;
    elements.seaMilesField.hidden = !calculation.usesBoat;
    elements.message.textContent = calculation.errors.join(' ');
    elements.message.className = `status-message price-calculator-message${calculation.errors.length ? ' error' : ''}`;
    elements.copyStatus.textContent = '';
    elements.copy.disabled = calculation.errors.length > 0;

    if (calculation.errors.length) {
      elements.total.textContent = '–';
      elements.totalLabel.textContent = 'Kalkylen behöver kompletteras';
    } else if (calculation.requiresQuote) {
      elements.total.textContent = 'Offert';
      elements.totalLabel.textContent = 'Båttransport över 15 sjömil bedöms separat';
    } else {
      elements.total.textContent = formatSek(calculation.customerPrice);
      elements.totalLabel.textContent = calculation.usesRut ? 'Pris efter RUT-avdrag' : 'Pris utan RUT-avdrag';
    }

    elements.summary.textContent = buildSummary(calculation);
    elements.laborBeforeRut.textContent = formatSek(calculation.laborBeforeRut);
    elements.materialCost.textContent = formatSek(calculation.materialCost);
    elements.transportCost.textContent = formatSek(calculation.transportCost);
    elements.priceBeforeRut.textContent = formatSek(calculation.priceBeforeRut);
    elements.rutDeduction.textContent = calculation.rutDeduction
      ? `−${formatSek(calculation.rutDeduction)}`
      : formatSek(0);
  }

  async function copyCalculation() {
    const text = buildClipboardText(latestCalculation || calculatePrice(getInput()));
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      elements.copyStatus.textContent = 'Kalkylen är kopierad.';
    } catch {
      elements.copyStatus.textContent = 'Kunde inte kopiera. Markera uppgifterna manuellt.';
    }
  }

  form.addEventListener('input', render);
  form.addEventListener('change', render);
  form.addEventListener('submit', (event) => event.preventDefault());
  elements.reset.addEventListener('click', () => {
    form.reset();
    render();
    elements.housingType.focus();
  });
  elements.copy.addEventListener('click', copyCalculation);
  render();
})(typeof window === 'undefined' ? globalThis : window);
