(() => {
  'use strict';

  const SUPABASE_URL = 'https://xeyippgcoqfskcmqzazx.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq';
  const BOOKING_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/create-booking`;
  const VALIDATE_DISCOUNT_URL = `${SUPABASE_URL}/functions/v1/validate-discount`;
  const BOOKED_SLOTS_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/booked-slots`;
  const BOOKABLE_TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  const MONTH_NAMES = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  const DRAFT_KEY = 'bergaBookingDraft';
  const CONFIRMATION_KEY = 'bergaBookingConfirmation';
  const REBOOK_KEY = 'bergaRebookPrefill';
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  const BASE_LABOR_PRICE_AFTER_RUT = 799;
  const MATERIAL_FEE = 150;
  const INCLUDED_WINDOWS = 15;
  const MAX_TOTAL_WINDOWS = 60;
  const TWO_FLOOR_ADDON = 200;
  const EXTRA_REGULAR_WINDOW_PRICE = 39;
  const EXTRA_MUNTINS_WINDOW_PRICE = 49;
  const INTERIOR_BASE_ADDON = 320;
  const INTERIOR_EXTRA_WINDOW_PRICE = 39;
  const ISLAND_START_PRICE = 799;
  const ISLAND_PRICE_PER_SEA_MILE = 125;

  const form = document.getElementById('bookingForm');
  if (!form) return;

  const byId = (id) => document.getElementById(id);
  const stepSections = Array.from(document.querySelectorAll('[data-booking-step]'));
  const progressItems = Array.from(document.querySelectorAll('[data-progress-step]'));
  const stepCounter = byId('stepCounter');
  const stepName = byId('stepName');
  const bookingStatus = byId('bookingStatus');
  const dateInput = byId('date');
  const timeInput = byId('time');
  const formStartedAtInput = byId('formStartedAt');
  const websiteInput = byId('website');
  const calendarGrid = byId('calendarGrid');
  const calendarTitle = byId('calendarTitle');
  const calendarStatus = byId('calendarStatus');
  const calendarStatusText = byId('calendarStatusText');
  const retryCalendarButton = byId('retryCalendarButton');
  const prevMonthButton = byId('prevMonth');
  const nextMonthButton = byId('nextMonth');
  const selectedDateBox = byId('selectedDateBox');
  const timePicker = byId('timePicker');
  const timeSlots = byId('timeSlots');
  const dateTimeError = byId('dateTimeError');
  const boatFields = byId('boatFields');
  const seaMilesInput = byId('seaMiles');
  const coordinatesInput = byId('coordinates');
  const boatQuoteNotice = byId('boatQuoteNotice');
  const discountCodeInput = byId('discountCode');
  const applyDiscountButton = byId('applyDiscountButton');
  const discountCodeStatus = byId('discountCodeStatus');
  const submitBookingButton = byId('submitBookingButton');

  const livePriceValue = byId('livePriceValue');
  const livePriceLabel = byId('livePriceLabel');
  const livePriceText = byId('livePriceText');
  const laborCostLabel = byId('laborCostLabel');
  const laborCostValue = byId('laborCostValue');
  const materialCostValue = byId('materialCostValue');
  const transportCostValue = byId('transportCostValue');
  const rutDeductionValue = byId('rutDeductionValue');
  const discountBreakdownRow = byId('discountBreakdownRow');
  const discountBreakdownValue = byId('discountBreakdownValue');

  const stockholmTodayParts = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  const todayDate = new Date(
    Number(stockholmTodayParts.year),
    Number(stockholmTodayParts.month) - 1,
    Number(stockholmTodayParts.day),
    12
  );
  const minBookableDate = new Date(todayDate);
  minBookableDate.setDate(minBookableDate.getDate() + 2);
  const lastBookableDate = new Date(todayDate);
  lastBookableDate.setDate(lastBookableDate.getDate() + 365);
  const firstCalendarMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1, 12);
  const lastCalendarMonth = new Date(lastBookableDate.getFullYear(), lastBookableDate.getMonth(), 1, 12);
  const todayString = formatDate(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const minBookableString = formatDate(minBookableDate.getFullYear(), minBookableDate.getMonth(), minBookableDate.getDate());
  const lastBookableString = formatDate(lastBookableDate.getFullYear(), lastBookableDate.getMonth(), lastBookableDate.getDate());

  let currentStep = 1;
  let desiredInitialStep = 1;
  let currentCalendarMonth = new Date(firstCalendarMonth);
  let selectedDate = '';
  let selectedTime = '';
  let bookingsCache = [];
  let blockedDatesCache = [];
  let calendarReady = false;
  let appliedDiscount = null;
  let rebookedFromBookingId = '';
  let bookingPending = false;
  let beginTracked = false;
  let rebookPrefillApplied = false;

  function getHeaders() {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    };
  }

  function trackEvent(eventName, parameters = {}) {
    try {
      if (typeof window.bergaTrack === 'function') {
        window.bergaTrack(eventName, parameters);
      }
    } catch {
      // Mätning får aldrig hindra bokningen.
    }
  }

  function trackBeginBooking() {
    if (beginTracked) return;
    beginTracked = true;
    trackEvent('begin_booking', { entry_step: currentStep, page_path: window.location.pathname });
  }

  function formatDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function formatDateForDisplay(dateString) {
    const dateObject = new Date(`${dateString}T12:00:00`);
    if (Number.isNaN(dateObject.getTime())) return dateString;
    return dateObject.toLocaleDateString('sv-SE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function normalizePostalCode(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function checkedValue(name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value || '';
  }

  function setCheckedValue(name, value) {
    const normalized = String(value || '');
    const option = Array.from(form.querySelectorAll(`input[name="${name}"]`))
      .find((input) => input.value === normalized);
    if (option) option.checked = true;
  }

  function setSelectValue(id, value) {
    const select = byId(id);
    const normalized = String(value ?? '');
    if (select && Array.from(select.options).some((option) => option.value === normalized)) {
      select.value = normalized;
    }
  }

  function setInputValue(id, value, maxLength = 240) {
    const input = byId(id);
    if (!input || value === undefined || value === null) return;
    input.value = String(value).slice(0, maxLength);
  }

  function getWindowCountValue() {
    return Number(byId('windowCount')?.textContent || 0) || 0;
  }

  function getMuntinsCountValue() {
    return Number(byId('muntinsCount')?.textContent || 0) || 0;
  }

  function setWindowCountValue(nextValue, shouldRefresh = true) {
    const maximum = Math.max(0, MAX_TOTAL_WINDOWS - getMuntinsCountValue());
    const safeValue = Math.max(0, Math.min(maximum, Number(nextValue) || 0));
    byId('windowCount').textContent = String(safeValue);
    if (shouldRefresh) refreshBookingState();
  }

  function setMuntinsCountValue(nextValue, shouldRefresh = true) {
    const maximum = Math.max(0, MAX_TOTAL_WINDOWS - getWindowCountValue());
    const safeValue = Math.max(0, Math.min(maximum, Number(nextValue) || 0));
    byId('muntinsCount').textContent = String(safeValue);
    if (shouldRefresh) refreshBookingState();
  }

  function safelyReadSession(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function safelyRemoveSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Bokningen fungerar även när sessionslagring är blockerad.
    }
  }

  function collectDraft() {
    return {
      version: 1,
      currentStep,
      date: selectedDate,
      time: selectedTime,
      rutChoice: checkedValue('rutChoice'),
      housingType: checkedValue('housingType'),
      regularWindowCount: getWindowCountValue(),
      muntinsCount: getMuntinsCountValue(),
      serviceScope: checkedValue('serviceScope'),
      transportType: checkedValue('transportType'),
      seaMiles: seaMilesInput.value,
      coordinates: coordinatesInput.value,
      discountCode: discountCodeInput.value,
      name: byId('name').value,
      phone: byId('phone').value,
      email: byId('email').value,
      postalCode: byId('postalCode').value,
      location: byId('location').value,
      recurrenceWeeks: byId('recurrenceWeeks').value,
      message: byId('message').value,
      consentAccepted: byId('consent').checked,
      rebookedFromBookingId
    };
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
    } catch {
      // Ett lagringsfel ska inte stoppa formuläret.
    }
  }

  function restoreDraft() {
    const draft = safelyReadSession(DRAFT_KEY);
    if (!draft || typeof draft !== 'object') return false;

    const draftStep = Number(draft.currentStep);
    desiredInitialStep = Number.isInteger(draftStep) && draftStep >= 1 && draftStep <= 4 ? draftStep : 1;
    selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(draft.date || '')) ? String(draft.date) : '';
    selectedTime = BOOKABLE_TIMES.includes(String(draft.time || '')) ? String(draft.time) : '';
    setCheckedValue('rutChoice', draft.rutChoice);
    setCheckedValue('housingType', draft.housingType);
    setWindowCountValue(Number(draft.regularWindowCount), false);
    setMuntinsCountValue(Number(draft.muntinsCount), false);
    setCheckedValue('serviceScope', draft.serviceScope);
    setCheckedValue('transportType', draft.transportType);
    setInputValue('seaMiles', String(draft.seaMiles || '').replace(/\D/g, '').slice(0, 3), 3);
    setInputValue('coordinates', draft.coordinates, 240);
    setInputValue('discountCode', draft.discountCode, 32);
    setInputValue('name', draft.name, 100);
    setInputValue('phone', draft.phone, 24);
    setInputValue('email', draft.email, 254);
    setInputValue('postalCode', String(draft.postalCode || '').slice(0, 6), 6);
    setInputValue('location', draft.location, 240);
    setSelectValue('recurrenceWeeks', draft.recurrenceWeeks);
    setInputValue('message', draft.message, 2000);
    byId('consent').checked = Boolean(draft.consentAccepted);
    const sourceId = String(draft.rebookedFromBookingId || '');
    rebookedFromBookingId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(sourceId) ? sourceId : '';

    if (discountCodeInput.value.trim()) desiredInitialStep = Math.min(desiredInitialStep, 2);
    return true;
  }

  function applyRebookPrefill() {
    const prefill = safelyReadSession(REBOOK_KEY);
    safelyRemoveSession(REBOOK_KEY);
    if (!prefill || typeof prefill !== 'object') return false;

    safelyRemoveSession(DRAFT_KEY);
    selectedDate = '';
    selectedTime = '';
    desiredInitialStep = 1;
    setInputValue('name', prefill.name, 100);
    setInputValue('email', prefill.email, 254);
    setInputValue('phone', prefill.phone, 24);
    setInputValue('location', prefill.location, 240);
    setInputValue('postalCode', String(prefill.postalCode || '').replace(/\D/g, '').slice(0, 5), 5);
    setCheckedValue('housingType', prefill.housingType);
    setCheckedValue('rutChoice', prefill.rutChoice);
    setCheckedValue('serviceScope', prefill.serviceScope);
    setCheckedValue('transportType', prefill.transportType);
    setSelectValue('recurrenceWeeks', prefill.recurrenceWeeks);

    const sourceId = String(prefill.rebookedFromBookingId || '');
    rebookedFromBookingId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(sourceId) ? sourceId : '';
    const regularCount = Number(prefill.regularWindowCount);
    const muntinsCount = Number(prefill.muntinsCount);
    if (Number.isInteger(regularCount) && regularCount >= 0) {
      setWindowCountValue(Math.min(regularCount, MAX_TOTAL_WINDOWS), false);
    }
    if (Number.isInteger(muntinsCount) && muntinsCount >= 0) {
      setMuntinsCountValue(Math.min(muntinsCount, MAX_TOTAL_WINDOWS - getWindowCountValue()), false);
    }
    setInputValue('seaMiles', String(prefill.seaMiles || '').replace(/\D/g, '').slice(0, 3), 3);
    setInputValue('coordinates', prefill.coordinates, 240);
    rebookPrefillApplied = true;
    return true;
  }

  function applyQuerySelection() {
    const params = new URLSearchParams(window.location.search);
    const queryDate = params.get('date') || params.get('booking_date') || '';
    const queryTime = params.get('time') || params.get('booking_time') || '';
    const hasQuerySelection = params.has('date') || params.has('booking_date')
      || params.has('time') || params.has('booking_time');
    if (!hasQuerySelection) return;

    selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(queryDate) ? queryDate : '';
    selectedTime = BOOKABLE_TIMES.includes(queryTime) ? queryTime : '';
    desiredInitialStep = selectedDate && selectedTime ? Math.max(desiredInitialStep, 2) : 1;
  }

  function setStatus(message, type = 'error') {
    bookingStatus.textContent = message;
    bookingStatus.dataset.state = type;
    bookingStatus.hidden = false;
  }

  function clearStatus() {
    bookingStatus.textContent = '';
    bookingStatus.removeAttribute('data-state');
    bookingStatus.hidden = true;
  }

  function setCalendarState(state, message) {
    calendarStatus.dataset.state = state;
    calendarStatusText.textContent = message;
    retryCalendarButton.hidden = state !== 'error';
    calendarGrid.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  function normalizeBookingData(data) {
    if (!data || !Array.isArray(data.bookings) || !Array.isArray(data.blockedDates)) {
      throw new Error('Kalendern gav ett oväntat svar.');
    }
    const bookings = data.bookings
      .map((booking) => ({
        date: typeof booking?.date === 'string' ? booking.date : '',
        time: typeof booking?.time === 'string' ? booking.time.slice(0, 5) : ''
      }))
      .filter((booking) => /^\d{4}-\d{2}-\d{2}$/.test(booking.date));
    const blockedDates = data.blockedDates
      .map((blockedDate) => ({
        date: typeof blockedDate?.date === 'string' ? blockedDate.date : '',
        reason: typeof blockedDate?.reason === 'string' ? blockedDate.reason.slice(0, 160) : ''
      }))
      .filter((blockedDate) => /^\d{4}-\d{2}-\d{2}$/.test(blockedDate.date));
    return { bookings, blockedDates };
  }

  function getBookedTimes(date) {
    return bookingsCache.filter((booking) => booking.date === date).map((booking) => booking.time);
  }

  function getBlockedDate(date) {
    return blockedDatesCache.find((blockedDate) => blockedDate.date === date) || null;
  }

  function isDateWithinBookableRange(date) {
    return date >= minBookableString && date <= lastBookableString;
  }

  function isFullyBooked(date) {
    return getBookedTimes(date).length > 0 || Boolean(getBlockedDate(date));
  }

  function isDateSelectable(date) {
    return calendarReady && isDateWithinBookableRange(date) && !isFullyBooked(date);
  }

  function syncDateInputs() {
    dateInput.value = selectedDate;
    timeInput.value = selectedTime;
  }

  function syncBookingUrl() {
    const url = new URL(window.location.href);
    if (selectedDate) url.searchParams.set('date', selectedDate);
    else url.searchParams.delete('date');
    if (selectedTime) url.searchParams.set('time', selectedTime);
    else url.searchParams.delete('time');
    url.searchParams.delete('booking_date');
    url.searchParams.delete('booking_time');
    window.history.replaceState({}, '', url);
  }

  function clearDateTimeError() {
    dateTimeError.hidden = true;
    dateTimeError.textContent = '';
    calendarGrid.removeAttribute('aria-invalid');
    timePicker.removeAttribute('aria-invalid');
  }

  function updateSelectedDateBox() {
    if (!calendarReady) {
      selectedDateBox.textContent = 'Tillgängligheten måste kontrolleras innan du kan välja en tid.';
    } else if (!selectedDate) {
      selectedDateBox.textContent = 'Välj en ledig dag i kalendern.';
    } else if (!selectedTime) {
      selectedDateBox.textContent = `Valt datum: ${formatDateForDisplay(selectedDate)}. Välj en starttid.`;
    } else {
      selectedDateBox.textContent = `Vald tid: ${formatDateForDisplay(selectedDate)} kl. ${selectedTime}.`;
    }
    syncDateInputs();
  }

  function selectBookingTime(time) {
    if (!isDateSelectable(selectedDate) || !BOOKABLE_TIMES.includes(time)) return;
    selectedTime = time;
    clearDateTimeError();
    updateSelectedDateBox();
    renderTimes();
    syncBookingUrl();
    saveDraft();
  }

  function renderTimes() {
    timeSlots.replaceChildren();
    if (!calendarReady || !selectedDate) return;

    BOOKABLE_TIMES.forEach((time) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'time-slot';
      button.textContent = time;
      button.setAttribute('aria-pressed', selectedTime === time ? 'true' : 'false');
      if (selectedTime === time) button.classList.add('selected');
      if (!isDateSelectable(selectedDate)) {
        button.disabled = true;
        button.textContent = `${time} · ej ledig`;
      } else {
        button.addEventListener('click', () => selectBookingTime(time));
      }
      timeSlots.appendChild(button);
    });
  }

  function renderCalendar() {
    calendarGrid.replaceChildren();
    const year = currentCalendarMonth.getFullYear();
    const month = currentCalendarMonth.getMonth();
    calendarTitle.textContent = `${MONTH_NAMES[month]} ${year}`;
    prevMonthButton.disabled = !calendarReady || currentCalendarMonth <= firstCalendarMonth;
    nextMonthButton.disabled = !calendarReady || currentCalendarMonth >= lastCalendarMonth;

    const firstDay = new Date(year, month, 1, 12);
    const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
    const offset = (firstDay.getDay() + 6) % 7;
    for (let index = 0; index < offset; index += 1) {
      const empty = document.createElement('span');
      empty.className = 'calendar-empty';
      empty.setAttribute('aria-hidden', 'true');
      calendarGrid.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = formatDate(year, month, day);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      button.textContent = String(day);
      const past = date < todayString;
      const tooSoon = !past && date < minBookableString;
      const tooLate = date > lastBookableString;
      const blocked = Boolean(getBlockedDate(date));
      const booked = getBookedTimes(date).length > 0;
      const selectable = calendarReady && !past && !tooSoon && !tooLate && !blocked && !booked;

      if (date === todayString) {
        button.classList.add('today');
        button.setAttribute('aria-current', 'date');
      }
      if (selectedDate === date) button.classList.add('selected');
      if (blocked || booked) button.classList.add('fully-booked');
      if (past || tooLate || !calendarReady) button.classList.add('past');
      if (tooSoon) button.classList.add('advance-notice');
      button.setAttribute('aria-pressed', selectedDate === date ? 'true' : 'false');
      button.disabled = !selectable;

      const state = !calendarReady
        ? 'tillgänglighet ej kontrollerad'
        : blocked ? 'ej bokbar'
          : booked ? 'bokad'
            : past || tooSoon || tooLate ? 'inte valbar' : 'ledig';
      button.setAttribute('aria-label', `${formatDateForDisplay(date)}: ${state}`);

      if (selectable) {
        button.addEventListener('click', () => {
          selectedDate = date;
          selectedTime = '';
          clearDateTimeError();
          updateSelectedDateBox();
          renderCalendar();
          renderTimes();
          syncBookingUrl();
          saveDraft();
          window.setTimeout(() => timeSlots.querySelector('button')?.focus(), 0);
        });
      }
      calendarGrid.appendChild(button);
    }
  }

  function applyAvailableInitialSelection() {
    const dateObject = new Date(`${selectedDate}T12:00:00`);
    const dateIsValid = selectedDate
      && !Number.isNaN(dateObject.getTime())
      && formatDate(dateObject.getFullYear(), dateObject.getMonth(), dateObject.getDate()) === selectedDate
      && isDateSelectable(selectedDate);

    if (!dateIsValid) {
      selectedDate = '';
      selectedTime = '';
      desiredInitialStep = 1;
      return;
    }

    currentCalendarMonth = new Date(dateObject.getFullYear(), dateObject.getMonth(), 1, 12);
    if (!BOOKABLE_TIMES.includes(selectedTime)) selectedTime = '';
    if (!selectedTime) desiredInitialStep = 1;
  }

  async function fetchAvailability() {
    calendarReady = false;
    bookingsCache = [];
    blockedDatesCache = [];
    setCalendarState('loading', 'Kontrollerar lediga dagar…');
    renderCalendar();
    renderTimes();
    updateSelectedDateBox();

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(BOOKED_SLOTS_FUNCTION_URL, {
        headers: getHeaders(),
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Kalendern kunde inte hämtas.');
      const normalized = normalizeBookingData(await response.json());
      bookingsCache = normalized.bookings;
      blockedDatesCache = normalized.blockedDates;
      calendarReady = true;
      setCalendarState('ready', 'Kalendern är uppdaterad. Välj en ledig dag.');
      applyAvailableInitialSelection();
      updateSelectedDateBox();
      renderCalendar();
      renderTimes();
      saveDraft();
      restoreInitialStep();
    } catch (error) {
      console.error('Bokningskalendern kunde inte laddas:', error);
      selectedDate = '';
      selectedTime = '';
      syncDateInputs();
      setCalendarState('error', 'Vi kan inte kontrollera lediga dagar just nu. Försök igen.');
      renderCalendar();
      renderTimes();
      updateSelectedDateBox();
      showStep(1, false);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function getHousingTypeLabel() {
    return checkedValue('housingType');
  }

  function getBaseLaborPriceAfterRut(housingTypeLabel) {
    return BASE_LABOR_PRICE_AFTER_RUT + (housingTypeLabel === 'Två våningar' ? TWO_FLOOR_ADDON : 0);
  }

  function getInteriorAddon(_housingTypeLabel, windowCount) {
    const extraWindows = Math.max(0, windowCount - INCLUDED_WINDOWS);
    return INTERIOR_BASE_ADDON + (extraWindows * INTERIOR_EXTRA_WINDOW_PRICE);
  }

  function getSeaMilesAddon() {
    const rawValue = seaMilesInput.value;
    if (rawValue === '') return { label: '', price: 0, isQuote: false };
    const parsedMiles = Number(rawValue);
    const safeMiles = Number.isFinite(parsedMiles) ? Math.max(0, parsedMiles) : 0;
    if (safeMiles > 15) return { label: `${safeMiles} sjömil`, price: 0, isQuote: true };
    return {
      label: `${safeMiles} sjömil`,
      price: ISLAND_START_PRICE + (safeMiles * ISLAND_PRICE_PER_SEA_MILE),
      isQuote: false
    };
  }

  function calculateEstimatedPrice() {
    const housingTypeLabel = getHousingTypeLabel();
    const regularWindowCount = getWindowCountValue();
    const muntinsCount = getMuntinsCountValue();
    const windowCount = regularWindowCount + muntinsCount;
    const extraWindowCount = Math.max(0, windowCount - INCLUDED_WINDOWS);
    const includedRegularWindowCount = Math.min(regularWindowCount, INCLUDED_WINDOWS);
    const includedMuntinsCount = Math.min(muntinsCount, Math.max(0, INCLUDED_WINDOWS - includedRegularWindowCount));
    const extraRegularWindowCount = Math.max(0, regularWindowCount - includedRegularWindowCount);
    const extraMuntinsCount = Math.max(0, muntinsCount - includedMuntinsCount);
    const serviceScopeValue = checkedValue('serviceScope');
    const baseLaborAfterRut = getBaseLaborPriceAfterRut(housingTypeLabel);
    const windowLaborAfterRut = (extraRegularWindowCount * EXTRA_REGULAR_WINDOW_PRICE)
      + (extraMuntinsCount * EXTRA_MUNTINS_WINDOW_PRICE);
    const interiorLaborAfterRut = serviceScopeValue === 'Invändig + utvändig'
      ? getInteriorAddon(housingTypeLabel, windowCount)
      : 0;
    const transportType = checkedValue('transportType');
    const seaMilesAddon = transportType === 'Båttransport behövs'
      ? getSeaMilesAddon()
      : { label: '', price: 0, isQuote: false };
    const rutChoiceValue = checkedValue('rutChoice');
    const rutChoiceSelected = Boolean(rutChoiceValue);
    const usesRut = /^Ja\b/i.test(rutChoiceValue.trim());
    const laborCostAfterRut = baseLaborAfterRut + windowLaborAfterRut + interiorLaborAfterRut;
    const laborCostBeforeRut = laborCostAfterRut * 2;
    const materialCost = MATERIAL_FEE;
    const transportCost = seaMilesAddon.price;
    const rutDeduction = usesRut ? laborCostAfterRut : 0;
    const priceBeforeRut = seaMilesAddon.isQuote ? null : laborCostBeforeRut + materialCost + transportCost;
    const customerPriceBeforeDiscount = priceBeforeRut === null ? null : priceBeforeRut - rutDeduction;

    return {
      customerPriceBeforeDiscount,
      priceBeforeRut,
      laborCostAfterRut,
      laborCostBeforeRut,
      materialCost,
      transportCost,
      rutDeduction,
      usesRut,
      rutChoiceSelected,
      baseLaborAfterRut,
      windowLaborAfterRut,
      interiorLaborAfterRut,
      muntinsCount,
      regularWindowCount,
      extraWindowCount,
      extraMuntinsCount,
      extraRegularWindowCount,
      transportType,
      seaMilesAddon,
      isQuote: seaMilesAddon.isQuote,
      housingTypeLabel,
      windowCount,
      serviceScopeValue
    };
  }

  function getDiscountAmount(originalPrice) {
    if (!appliedDiscount || !Number.isFinite(originalPrice)) return 0;
    const amount = appliedDiscount.discountType === 'percentage'
      ? Math.round(originalPrice * appliedDiscount.discountValue / 100)
      : appliedDiscount.discountValue;
    return Math.min(Math.max(amount, 0), Math.max(originalPrice - 1, 0));
  }

  function getCustomerLaborPriceBeforeDiscount(estimate) {
    return estimate.usesRut ? estimate.laborCostAfterRut : estimate.laborCostBeforeRut;
  }

  function calculateDiscountedPrice(estimate) {
    const customerLaborBeforeDiscount = getCustomerLaborPriceBeforeDiscount(estimate);
    const discountAmount = getDiscountAmount(customerLaborBeforeDiscount);
    const customerLaborAfterDiscount = customerLaborBeforeDiscount - discountAmount;
    const laborCostBeforeRut = estimate.usesRut ? customerLaborAfterDiscount * 2 : customerLaborAfterDiscount;
    const rutDeduction = estimate.usesRut ? customerLaborAfterDiscount : 0;
    const priceBeforeRut = laborCostBeforeRut + estimate.materialCost + estimate.transportCost;
    const customerPrice = customerLaborAfterDiscount + estimate.materialCost + estimate.transportCost;
    return {
      customerLaborBeforeDiscount,
      customerLaborAfterDiscount,
      discountAmount,
      laborCostBeforeRut,
      rutDeduction,
      priceBeforeRut,
      customerPrice
    };
  }

  function formatSek(value) {
    return `${Math.round(value).toLocaleString('sv-SE')} kr`;
  }

  function renderPriceBreakdown(estimate, discountedPrice) {
    laborCostLabel.textContent = discountedPrice.discountAmount > 0
      ? 'Arbetskostnad efter rabatt, före RUT'
      : 'Arbetskostnad före RUT';
    laborCostValue.textContent = formatSek(discountedPrice.laborCostBeforeRut);
    materialCostValue.textContent = formatSek(estimate.materialCost);
    transportCostValue.textContent = formatSek(estimate.transportCost);
    rutDeductionValue.textContent = discountedPrice.rutDeduction > 0
      ? `−${formatSek(discountedPrice.rutDeduction)}`
      : formatSek(0);
    discountBreakdownRow.hidden = discountedPrice.discountAmount <= 0;
    discountBreakdownValue.textContent = discountedPrice.discountAmount > 0
      ? `${formatSek(discountedPrice.discountAmount)} (inräknad)`
      : formatSek(0);
  }

  function updateLivePrice() {
    const estimate = calculateEstimatedPrice();
    const transportNeedsMiles = estimate.transportType === 'Båttransport behövs' && !estimate.seaMilesAddon.label;
    boatQuoteNotice.hidden = !estimate.isQuote;

    if (estimate.isQuote) {
      livePriceValue.textContent = 'Offert';
      livePriceLabel.textContent = 'Båttransport över 15 sjömil';
      livePriceText.textContent = 'Längre skärgårdsjobb planeras tillsammans med dig och får ett separat tydligt pris.';
      laborCostValue.textContent = 'Fastställs i offert';
      materialCostValue.textContent = 'Fastställs i offert';
      transportCostValue.textContent = 'Fastställs i offert';
      rutDeductionValue.textContent = 'Fastställs i offert';
      discountBreakdownRow.hidden = true;
      return;
    }

    const discountedPrice = calculateDiscountedPrice(estimate);
    renderPriceBreakdown(estimate, discountedPrice);
    if (appliedDiscount) {
      discountCodeStatus.textContent = `Rabattkod använd på arbetsandelen: −${formatSek(discountedPrice.discountAmount)}.`;
      discountCodeStatus.className = 'discount-status is-success';
    }

    if (!estimate.housingTypeLabel || !estimate.rutChoiceSelected || !estimate.serviceScopeValue || !estimate.transportType) {
      livePriceValue.textContent = 'Från 949 kr';
      livePriceLabel.textContent = 'Pris efter RUT-avdrag';
      livePriceText.textContent = 'Gör dina val så ser du ditt uppskattade totalpris direkt.';
      laborCostLabel.textContent = 'Arbetskostnad före RUT';
      laborCostValue.textContent = formatSek(BASE_LABOR_PRICE_AFTER_RUT * 2);
      materialCostValue.textContent = formatSek(MATERIAL_FEE);
      transportCostValue.textContent = formatSek(0);
      rutDeductionValue.textContent = `−${formatSek(BASE_LABOR_PRICE_AFTER_RUT)}`;
      discountBreakdownRow.hidden = true;
      return;
    }

    livePriceValue.textContent = formatSek(discountedPrice.customerPrice);
    livePriceLabel.textContent = estimate.usesRut ? 'Pris efter RUT-avdrag' : 'Pris utan RUT-avdrag';
    if (!estimate.windowCount) {
      livePriceText.textContent = 'Fyll i antal fönster för att få rätt pris.';
      return;
    }
    if (transportNeedsMiles) {
      livePriceValue.textContent = 'Ange sjömil';
      livePriceLabel.textContent = 'Transporten räknas in före bokning';
      livePriceText.textContent = 'Ange antal sjömil så räknas transporten in före bokningen.';
      return;
    }

    const parts = [
      `arbetskostnad före RUT ${formatSek(discountedPrice.laborCostBeforeRut)}`,
      `material ${formatSek(estimate.materialCost)}`,
      `${INCLUDED_WINDOWS} fönster ingår`
    ];
    if (estimate.extraWindowCount > 0) {
      if (estimate.extraRegularWindowCount) parts.push(`${estimate.extraRegularWindowCount} extra utan spröjs`);
      if (estimate.extraMuntinsCount) parts.push(`${estimate.extraMuntinsCount} extra med spröjs`);
    }
    if (estimate.interiorLaborAfterRut > 0) parts.push('invändig puts');
    if (estimate.transportCost > 0) parts.push(`transport ${formatSek(estimate.transportCost)}`);
    if (discountedPrice.discountAmount > 0) {
      parts.push(`rabattkod ${appliedDiscount.code}: −${formatSek(discountedPrice.discountAmount)} på din arbetsandel`);
    }
    const rutText = estimate.usesRut
      ? `RUT-avdrag −${formatSek(discountedPrice.rutDeduction)}`
      : 'inget RUT-avdrag';
    livePriceText.textContent = `${parts.join(' · ')}. ${rutText}.`;
  }

  function clearControlError(controlId, errorId) {
    const control = byId(controlId);
    const error = byId(errorId);
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    if (!control) return;
    control.classList.remove('has-error');
    if (control.matches('fieldset')) {
      control.querySelectorAll('input').forEach((input) => input.removeAttribute('aria-invalid'));
      control.removeAttribute('aria-invalid');
    } else {
      control.removeAttribute('aria-invalid');
      control.closest('.field, .consent-field')?.classList.remove('has-error');
    }
  }

  function showControlError(controlId, errorId, message, fieldName, shouldFocus = true, shouldTrack = true) {
    const control = byId(controlId);
    const error = byId(errorId);
    if (!control || !error) return;
    error.textContent = message;
    error.hidden = false;
    control.classList.add('has-error');
    let focusTarget = control;
    if (control.matches('fieldset')) {
      const inputs = Array.from(control.querySelectorAll('input'));
      inputs.forEach((input) => input.setAttribute('aria-invalid', 'true'));
      control.setAttribute('aria-invalid', 'true');
      focusTarget = inputs[0] || control.querySelector('button') || control;
    } else {
      control.setAttribute('aria-invalid', 'true');
      control.closest('.field, .consent-field')?.classList.add('has-error');
    }
    if (shouldTrack) trackEvent('form_error', { step: currentStep, field: fieldName, error_type: message });
    if (shouldFocus) {
      window.setTimeout(() => {
        focusTarget.focus({ preventScroll: true });
        focusTarget.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }, 0);
    }
  }

  function clearStepErrors(step) {
    if (step === 1) clearDateTimeError();
    if (step === 2) {
      [
        ['rutChoiceGroup', 'rutChoiceError'],
        ['housingTypeGroup', 'housingTypeError'],
        ['windowCountGroup', 'windowCountError'],
        ['serviceScopeGroup', 'serviceScopeError'],
        ['transportTypeGroup', 'transportTypeError'],
        ['seaMiles', 'seaMilesError'],
        ['coordinates', 'coordinatesError'],
        ['discountCode', 'discountCodeError']
      ].forEach(([control, error]) => clearControlError(control, error));
    }
    if (step === 3) {
      [
        ['name', 'nameError'], ['phone', 'phoneError'], ['email', 'emailError'],
        ['postalCode', 'postalCodeError'], ['location', 'locationError'],
        ['recurrenceWeeks', 'recurrenceWeeksError'], ['message', 'messageError'],
        ['consent', 'consentError']
      ].forEach(([control, error]) => clearControlError(control, error));
    }
  }

  function validateStep1(options = {}) {
    const shouldFocus = options.focus !== false;
    const shouldTrack = options.track !== false;
    clearDateTimeError();
    let message = '';
    if (!calendarReady) message = 'Vänta tills kalendern har laddats eller försök igen.';
    else if (!selectedDate) message = 'Välj en ledig dag i kalendern.';
    else if (!isDateSelectable(selectedDate)) message = 'Den valda dagen är inte längre ledig. Välj en annan dag.';
    else if (!selectedTime || !BOOKABLE_TIMES.includes(selectedTime)) message = 'Välj en starttid för besöket.';
    if (!message) return true;

    dateTimeError.textContent = message;
    dateTimeError.hidden = false;
    calendarGrid.setAttribute('aria-invalid', 'true');
    timePicker.setAttribute('aria-invalid', 'true');
    if (shouldTrack) trackEvent('form_error', { step: 1, field: 'date_time', error_type: message });
    if (shouldFocus) {
      const target = selectedDate ? timeSlots.querySelector('button:not(:disabled)') : calendarGrid.querySelector('button:not(:disabled)');
      window.setTimeout(() => target?.focus(), 0);
    }
    return false;
  }

  function validateStep2(options = {}) {
    const shouldFocus = options.focus !== false;
    const shouldTrack = options.track !== false;
    clearStepErrors(2);
    const errors = [];
    const add = (control, error, message, field) => errors.push({ control, error, message, field });

    if (!checkedValue('rutChoice')) add('rutChoiceGroup', 'rutChoiceError', 'Välj om du vill använda RUT-avdrag.', 'rut_choice');
    if (!checkedValue('housingType')) add('housingTypeGroup', 'housingTypeError', 'Välj vilken typ av bostad det gäller.', 'housing_type');
    if (getWindowCountValue() + getMuntinsCountValue() < 1) {
      add('windowCountGroup', 'windowCountError', 'Ange minst ett fönster.', 'window_count');
    }
    if (!checkedValue('serviceScope')) add('serviceScopeGroup', 'serviceScopeError', 'Välj vilka sidor som ska putsas.', 'service_scope');
    if (!checkedValue('transportType')) add('transportTypeGroup', 'transportTypeError', 'Välj fastland eller båttransport.', 'transport_type');

    if (checkedValue('transportType') === 'Båttransport behövs') {
      const rawMiles = seaMilesInput.value.trim();
      const miles = Number(rawMiles);
      if (!rawMiles) add('seaMiles', 'seaMilesError', 'Ange ungefär antal sjömil.', 'sea_miles');
      else if (!/^\d+$/.test(rawMiles) || !Number.isInteger(miles) || miles < 0) {
        add('seaMiles', 'seaMilesError', 'Ange antal sjömil som ett helt tal, till exempel 10.', 'sea_miles');
      } else if (miles > 15) {
        add('seaMiles', 'seaMilesError', 'Över 15 sjömil behöver en offert. Använd offertlänken ovan.', 'sea_miles');
      }
      if (!coordinatesInput.value.trim()) {
        add('coordinates', 'coordinatesError', 'Ange koordinater eller exakt plats där vi kan lägga till.', 'coordinates');
      }
    }

    const typedCode = discountCodeInput.value.trim().toUpperCase();
    if (typedCode && (!appliedDiscount || appliedDiscount.code !== typedCode)) {
      add('discountCode', 'discountCodeError', 'Klicka på ”Använd kod” så att rabattkoden kontrolleras innan du fortsätter.', 'discount_code');
    }

    errors.forEach((item, index) => showControlError(
      item.control,
      item.error,
      item.message,
      item.field,
      shouldFocus && index === 0,
      shouldTrack
    ));
    return errors.length === 0;
  }

  function validateStep3(options = {}) {
    const shouldFocus = options.focus !== false;
    const shouldTrack = options.track !== false;
    clearStepErrors(3);
    const errors = [];
    const add = (control, error, message, field) => errors.push({ control, error, message, field });
    const name = byId('name').value.trim();
    const phone = byId('phone').value.trim();
    const normalizedPhone = phone.replace(/[^\d+]/g, '');
    const email = byId('email').value.trim();
    const postalCode = normalizePostalCode(byId('postalCode').value);
    const location = byId('location').value.trim();
    const recurrence = byId('recurrenceWeeks').value;
    const message = byId('message').value.trim();

    if (name.length < 2 || name.length > 100) add('name', 'nameError', 'Skriv ditt namn med minst två tecken.', 'name');
    if (!/^\+?\d{7,15}$/.test(normalizedPhone)) {
      add('phone', 'phoneError', 'Ange ett telefonnummer med 7–15 siffror.', 'phone');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      add('email', 'emailError', 'Ange en giltig e-postadress, till exempel namn@exempel.se.', 'email');
    }
    if (!/^1\d{4}$/.test(postalCode)) {
      add('postalCode', 'postalCodeError', 'Direktbokning gäller postnummer som börjar med 1 och har fem siffror.', 'postal_code');
    }
    if (location.length < 5 || location.length > 240) {
      add('location', 'locationError', 'Ange gatuadress och ort där jobbet ska utföras.', 'location');
    }
    if (!['', '8', '12'].includes(recurrence)) {
      add('recurrenceWeeks', 'recurrenceWeeksError', 'Välj ett av alternativen i listan.', 'recurrence_weeks');
    }
    if (message.length > 2000) add('message', 'messageError', 'Meddelandet får vara högst 2 000 tecken.', 'message');
    if (!byId('consent').checked) {
      add('consent', 'consentError', 'Godkänn integritetsinformationen och bokningsvillkoren för att fortsätta.', 'consent');
    }

    errors.forEach((item, index) => showControlError(
      item.control,
      item.error,
      item.message,
      item.field,
      shouldFocus && index === 0,
      shouldTrack
    ));
    return errors.length === 0;
  }

  function validateStep(step, options = {}) {
    if (step === 1) return validateStep1(options);
    if (step === 2) return validateStep2(options);
    if (step === 3) return validateStep3(options);
    return true;
  }

  function showStep(step, shouldFocus = true) {
    const safeStep = Math.max(1, Math.min(4, Number(step) || 1));
    currentStep = safeStep;
    const names = ['Datum och tid', 'Tjänst och pris', 'Kontaktuppgifter', 'Kontrollera och bekräfta'];
    stepSections.forEach((section) => {
      section.hidden = Number(section.dataset.bookingStep) !== safeStep;
    });
    progressItems.forEach((item) => {
      const itemStep = Number(item.dataset.progressStep);
      item.classList.toggle('is-current', itemStep === safeStep);
      item.classList.toggle('is-complete', itemStep < safeStep);
      if (itemStep === safeStep) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    stepCounter.textContent = `Steg ${safeStep} av 4`;
    stepName.textContent = names[safeStep - 1];
    clearStatus();
    if (safeStep === 4) {
      updateSummary();
      trackEvent('view_booking_summary', {
        price: calculateDiscountedPrice(calculateEstimatedPrice()).customerPrice,
        currency: 'SEK'
      });
    }
    saveDraft();
    if (shouldFocus) {
      const heading = stepSections.find((section) => Number(section.dataset.bookingStep) === safeStep)?.querySelector('h2');
      window.setTimeout(() => {
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }, 0);
    }
  }

  function restoreInitialStep() {
    let target = desiredInitialStep;
    if (target >= 2 && !validateStep1({ focus: false, track: false })) target = 1;
    clearStepErrors(1);
    if (target >= 3 && !validateStep2({ focus: false, track: false })) target = 2;
    clearStepErrors(2);
    if (target >= 4 && !validateStep3({ focus: false, track: false })) target = 3;
    clearStepErrors(3);
    showStep(target, false);
    if (rebookPrefillApplied) {
      setStatus('Uppgifterna från din förra bokning är ifyllda. Kontrollera dem och välj en ledig tid.', 'success');
      rebookPrefillApplied = false;
    }
  }

  function appendSummaryRow(list, label, value) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value || 'Ej angivet';
    row.append(term, description);
    list.appendChild(row);
  }

  function getRutChoiceDisplay(value) {
    if (/^Ja\b/i.test(value)) return 'Ja, använd RUT';
    if (/^Nej\b/i.test(value)) return 'Nej, utan RUT';
    if (value.includes('osäker')) return 'Osäker – kontakta mig';
    return value;
  }

  function updateSummary() {
    const estimate = calculateEstimatedPrice();
    const discountedPrice = calculateDiscountedPrice(estimate);
    const summaryTime = byId('summaryTime');
    const summaryService = byId('summaryService');
    const summaryContact = byId('summaryContact');
    const summaryPrice = byId('summaryPrice');
    summaryTime.replaceChildren();
    summaryService.replaceChildren();
    summaryContact.replaceChildren();
    summaryPrice.replaceChildren();

    appendSummaryRow(summaryTime, 'Datum', selectedDate ? formatDateForDisplay(selectedDate) : 'Ej valt');
    appendSummaryRow(summaryTime, 'Starttid', selectedTime ? `Kl. ${selectedTime}` : 'Ej vald');

    appendSummaryRow(summaryService, 'Bostad', estimate.housingTypeLabel);
    appendSummaryRow(summaryService, 'Fönster', `${estimate.windowCount} totalt (${estimate.regularWindowCount} utan spröjs, ${estimate.muntinsCount} med spröjs)`);
    appendSummaryRow(summaryService, 'Putsning', estimate.serviceScopeValue);
    appendSummaryRow(summaryService, 'RUT', getRutChoiceDisplay(checkedValue('rutChoice')));
    appendSummaryRow(summaryService, 'Transport', estimate.transportType);
    if (estimate.transportType === 'Båttransport behövs') {
      appendSummaryRow(summaryService, 'Sjömil', seaMilesInput.value);
      appendSummaryRow(summaryService, 'Plats', coordinatesInput.value.trim());
    }

    appendSummaryRow(summaryContact, 'Namn', byId('name').value.trim());
    appendSummaryRow(summaryContact, 'Telefon', byId('phone').value.trim());
    appendSummaryRow(summaryContact, 'E-post', byId('email').value.trim());
    appendSummaryRow(summaryContact, 'Adress', byId('location').value.trim());
    appendSummaryRow(summaryContact, 'Postnummer', normalizePostalCode(byId('postalCode').value));
    appendSummaryRow(
      summaryContact,
      'Ny bokningsinbjudan',
      byId('recurrenceWeeks').value ? `Efter ${byId('recurrenceWeeks').value} veckor` : 'Nej, engångsbesök'
    );
    if (byId('message').value.trim()) appendSummaryRow(summaryContact, 'Övrigt', byId('message').value.trim());

    const total = document.createElement('strong');
    total.className = 'summary-total';
    total.textContent = formatSek(discountedPrice.customerPrice);
    const label = document.createElement('p');
    label.className = 'summary-price-label';
    label.textContent = estimate.usesRut ? 'Pris efter RUT-avdrag' : 'Pris utan RUT-avdrag';
    const details = document.createElement('dl');
    details.className = 'summary-price-parts';
    appendSummaryRow(
      details,
      discountedPrice.discountAmount > 0 ? 'Arbetskostnad före RUT, efter rabatt' : 'Arbetskostnad före RUT',
      formatSek(discountedPrice.laborCostBeforeRut)
    );
    appendSummaryRow(details, 'Material', formatSek(estimate.materialCost));
    appendSummaryRow(details, 'Transport', formatSek(estimate.transportCost));
    appendSummaryRow(details, 'RUT-avdrag', discountedPrice.rutDeduction ? `−${formatSek(discountedPrice.rutDeduction)}` : formatSek(0));
    if (discountedPrice.discountAmount > 0) {
      appendSummaryRow(details, `Rabatt (${appliedDiscount.code})`, `${formatSek(discountedPrice.discountAmount)} (inräknad ovan)`);
    }
    const paymentNote = document.createElement('p');
    paymentNote.className = 'summary-payment-note';
    paymentNote.textContent = 'Du betalar efter utfört arbete.';
    summaryPrice.append(total, label, details, paymentNote);
  }

  function setDiscountStatus(message, state = '') {
    discountCodeStatus.textContent = message;
    discountCodeStatus.className = 'discount-status';
    if (state) discountCodeStatus.classList.add(`is-${state}`);
  }

  async function applyDiscountCode() {
    clearControlError('discountCode', 'discountCodeError');
    const code = discountCodeInput.value.trim().toUpperCase();
    const estimate = calculateEstimatedPrice();
    discountCodeInput.value = code;
    setDiscountStatus('');

    const fail = (message) => {
      appliedDiscount = null;
      setDiscountStatus('');
      showControlError('discountCode', 'discountCodeError', message, 'discount_code', true, true);
      updateLivePrice();
      saveDraft();
    };

    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      fail('Ange en giltig rabattkod med minst tre tecken.');
      return;
    }
    if (estimate.isQuote) {
      fail('Rabattkod kan användas först när ett fast bokningspris finns.');
      return;
    }
    if (!estimate.rutChoiceSelected || !estimate.housingTypeLabel || !estimate.windowCount
      || !estimate.serviceScopeValue || !estimate.transportType) {
      fail('Välj RUT, bostad, antal fönster, putsning och transport först.');
      return;
    }
    if (estimate.transportType === 'Båttransport behövs' && !estimate.seaMilesAddon.label) {
      fail('Ange antal sjömil innan du använder rabattkoden.');
      return;
    }

    applyDiscountButton.disabled = true;
    applyDiscountButton.setAttribute('aria-busy', 'true');
    applyDiscountButton.textContent = 'Kontrollerar…';
    try {
      const discountBase = getCustomerLaborPriceBeforeDiscount(estimate);
      const response = await fetch(VALIDATE_DISCOUNT_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ code, originalPrice: discountBase })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.valid) {
        throw new Error(body.message || body.error || 'Rabattkoden kunde inte användas.');
      }
      appliedDiscount = {
        code: String(body.code || code).toUpperCase(),
        discountType: body.discountType,
        discountValue: Number(body.discountValue)
      };
      const amount = getDiscountAmount(discountBase);
      setDiscountStatus(`Rabattkod använd på arbetsandelen: −${formatSek(amount)}.`, 'success');
      updateLivePrice();
      saveDraft();
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Rabattkoden kunde inte användas.');
    } finally {
      applyDiscountButton.disabled = false;
      applyDiscountButton.removeAttribute('aria-busy');
      applyDiscountButton.textContent = 'Använd kod';
    }
  }

  function updateBoatFields() {
    const boatRequired = checkedValue('transportType') === 'Båttransport behövs';
    boatFields.hidden = !boatRequired;
    seaMilesInput.required = boatRequired;
    coordinatesInput.required = boatRequired;
  }

  function refreshBookingState() {
    updateBoatFields();
    updateLivePrice();
    saveDraft();
  }

  function getCampaignAttribution() {
    try {
      if (localStorage.getItem('berga_cookie_consent') !== 'accepted') return {};
      const stored = JSON.parse(sessionStorage.getItem('bergaCampaignAttribution') || '{}');
      if (!stored || typeof stored !== 'object') return {};
      return {
        utmSource: String(stored.utmSource || '').slice(0, 160),
        utmMedium: String(stored.utmMedium || '').slice(0, 160),
        utmCampaign: String(stored.utmCampaign || '').slice(0, 160),
        utmContent: String(stored.utmContent || '').slice(0, 160),
        utmTerm: String(stored.utmTerm || '').slice(0, 160),
        landingPage: String(stored.landingPage || '').slice(0, 160)
      };
    } catch {
      return {};
    }
  }

  function buildBooking() {
    const estimate = calculateEstimatedPrice();
    const discountedPrice = calculateDiscountedPrice(estimate);
    const boatRequired = checkedValue('transportType') === 'Båttransport behövs';
    const booking = {
      name: byId('name').value.trim(),
      email: byId('email').value.trim(),
      phone: byId('phone').value.trim(),
      housingType: getHousingTypeLabel(),
      rutChoice: checkedValue('rutChoice'),
      windowCount: `${estimate.windowCount} fönster totalt`,
      serviceScope: checkedValue('serviceScope'),
      transportType: checkedValue('transportType') || 'Fastland',
      seaMiles: boatRequired ? seaMilesInput.value : '',
      coordinates: boatRequired ? coordinatesInput.value.trim() : '',
      addons: `${estimate.regularWindowCount} utan spröjs, ${estimate.muntinsCount} med spröjs, ${estimate.extraWindowCount} extra fönster`,
      date: selectedDate,
      time: selectedTime,
      location: byId('location').value.trim(),
      postalCode: normalizePostalCode(byId('postalCode').value),
      recurrenceWeeks: byId('recurrenceWeeks').value || null,
      rebookedFromBookingId,
      attribution: getCampaignAttribution(),
      message: byId('message').value.trim(),
      price: discountedPrice.customerPrice,
      discountCode: appliedDiscount?.code || '',
      consentAccepted: byId('consent').checked
    };

    return { booking, estimate, discountedPrice };
  }

  function buildFunctionPayload(booking) {
    return {
      name: booking.name,
      email: booking.email,
      phone: booking.phone,
      boatSize: booking.housingType,
      housing_type: booking.housingType,
      housingType: booking.housingType,
      rut_choice: booking.rutChoice,
      rutChoice: booking.rutChoice,
      window_count: booking.windowCount,
      windowCount: booking.windowCount,
      service_scope: booking.serviceScope,
      serviceScope: booking.serviceScope,
      transport_type: booking.transportType,
      transportType: booking.transportType,
      sea_miles: booking.seaMiles || null,
      seaMiles: booking.seaMiles || null,
      coordinates: booking.coordinates || null,
      addons: booking.addons || null,
      paymentMethod: null,
      booking_date: booking.date,
      date: booking.date,
      booking_time: booking.time,
      time: booking.time,
      location: booking.location,
      postalCode: booking.postalCode,
      recurrenceWeeks: booking.recurrenceWeeks || null,
      rebookedFromBookingId: booking.rebookedFromBookingId || null,
      utmSource: booking.attribution.utmSource || null,
      utmMedium: booking.attribution.utmMedium || null,
      utmCampaign: booking.attribution.utmCampaign || null,
      utmContent: booking.attribution.utmContent || null,
      utmTerm: booking.attribution.utmTerm || null,
      landingPage: booking.attribution.landingPage || null,
      consent_accepted: booking.consentAccepted,
      consentAccepted: booking.consentAccepted,
      message: booking.message || null,
      price: booking.price,
      discountCode: booking.discountCode || null,
      formStartedAt: formStartedAtInput.value || '',
      website: websiteInput.value || ''
    };
  }

  async function createBooking(booking) {
    const response = await fetch(BOOKING_FUNCTION_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(buildFunctionPayload(booking))
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok || responseBody?.error) {
      throw new Error(responseBody?.error || 'Bokningen kunde inte sparas.');
    }
    return responseBody;
  }

  function saveConfirmationSummary(createdBooking, booking, estimate, discountedPrice) {
    const confirmationSummary = {
      bookingId: createdBooking?.bookingId || null,
      name: booking.name,
      date: booking.date,
      time: booking.time,
      housingType: booking.housingType,
      windowCount: booking.windowCount,
      serviceScope: booking.serviceScope,
      addons: booking.addons,
      transportType: booking.transportType,
      seaMiles: booking.seaMiles,
      coordinates: booking.coordinates,
      postalCode: booking.postalCode,
      recurrenceWeeks: booking.recurrenceWeeks,
      requiresEmailConfirmation: Boolean(createdBooking?.requiresEmailConfirmation ?? true),
      price: String(createdBooking?.price ?? booking.price),
      discountCode: createdBooking?.discountCode || booking.discountCode,
      discountAmount: String(createdBooking?.discountAmount || 0),
      originalPrice: String(createdBooking?.originalPrice ?? estimate.customerPriceBeforeDiscount),
      laborCostBeforeRut: String(createdBooking?.laborCostBeforeRut ?? discountedPrice.laborCostBeforeRut),
      materialCost: String(createdBooking?.materialCost ?? estimate.materialCost),
      transportCost: String(createdBooking?.transportCost ?? estimate.transportCost),
      rutDeduction: String(createdBooking?.rutDeduction ?? discountedPrice.rutDeduction),
      priceBeforeRut: String(createdBooking?.priceBeforeRut ?? discountedPrice.priceBeforeRut),
      usesRut: Boolean(createdBooking?.usesRut ?? estimate.usesRut)
    };
    try {
      sessionStorage.setItem(CONFIRMATION_KEY, JSON.stringify(confirmationSummary));
    } catch (error) {
      console.warn('Bokningssammanfattningen kunde inte sparas i sessionen:', error);
    }
  }

  function showSubmissionError(error) {
    const rawMessage = error instanceof Error ? error.message : '';
    const message = rawMessage.toLocaleLowerCase('sv-SE');
    trackEvent('form_error', { step: 4, field: 'booking_submission', error_type: 'submission_error' });

    if (message.includes('för många') || message.includes('vänta ett ögonblick')) {
      showStep(4);
      formStartedAtInput.value = String(Date.now());
      setStatus(message.includes('vänta ett ögonblick')
        ? 'Sidan har varit öppen en längre stund. Vänta ett ögonblick och försök sedan igen. Dina uppgifter finns kvar.'
        : rawMessage || 'För många bokningsförsök gjordes på kort tid. Vänta en stund och försök igen.');
      submitBookingButton.focus();
      return;
    }
    if (message.includes('datum') || message.includes('valda tiden') || message.includes('bokad') || message.includes('slot')) {
      showStep(1);
      dateTimeError.textContent = 'Den valda tiden kunde inte bokas. Kalendern uppdateras så att du kan välja en ny ledig dag.';
      dateTimeError.hidden = false;
      calendarGrid.setAttribute('aria-invalid', 'true');
      setStatus('Tiden hann bli upptagen eller är inte längre tillgänglig. Välj en ny dag och tid.');
      fetchAvailability();
      return;
    }
    if (message.includes('postnummer') || message.includes('postal')) {
      showStep(3);
      showControlError('postalCode', 'postalCodeError', 'Kontrollera postnumret. Direktbokning kräver fem siffror och ska börja med 1.', 'postal_code');
      setStatus('Postnumret behöver rättas innan bokningen kan bekräftas.');
      return;
    }
    if (message.includes('e-post') || message.includes('email')) {
      showStep(3);
      showControlError('email', 'emailError', 'Kontrollera att e-postadressen är fullständig och rättstavad.', 'email');
      setStatus('E-postadressen behöver rättas innan bokningen kan bekräftas.');
      return;
    }
    if (message.includes('telefon') || message.includes('phone')) {
      showStep(3);
      showControlError('phone', 'phoneError', 'Kontrollera telefonnumret och försök igen.', 'phone');
      setStatus('Telefonnumret behöver rättas innan bokningen kan bekräftas.');
      return;
    }
    if (message.includes('adress') || message.includes('location')) {
      showStep(3);
      showControlError('location', 'locationError', 'Kontrollera att gatuadress och ort är ifyllda.', 'location');
      setStatus('Adressen behöver rättas innan bokningen kan bekräftas.');
      return;
    }
    if (message.includes('meddelande') || message.includes('platsinformationen') || message.includes('för stor begäran')) {
      showStep(3);
      showControlError('message', 'messageError', 'Korta meddelandet och kontrollera att platsinformationen inte är för lång.', 'message');
      setStatus('Någon fritext är för lång för att bokningen ska kunna skickas.');
      return;
    }
    if (message.includes('engångsbesök') || message.includes('vecka')) {
      showStep(3);
      showControlError('recurrenceWeeks', 'recurrenceWeeksError', 'Välj engångsbesök, efter 8 veckor eller efter 12 veckor.', 'recurrence_weeks');
      setStatus('Valet för en ny bokningsinbjudan behöver kontrolleras.');
      return;
    }
    if (message.includes('integritet') || message.includes('samtycke')) {
      showStep(3);
      showControlError('consent', 'consentError', 'Godkänn integritetsinformationen och bokningsvillkoren för att fortsätta.', 'consent');
      setStatus('Ditt godkännande behövs innan bokningen kan skickas.');
      return;
    }
    if (message.includes('pris') || message.includes('rut') || message.includes('bostad')
      || message.includes('fönster') || message.includes('transport') || message.includes('rabatt')) {
      showStep(2);
      setStatus('Något i tjänstevalet eller priset behöver kontrolleras. Se över valen och försök igen.');
      byId('step2Title').focus();
      return;
    }

    showStep(4);
    const technicalMessage = !rawMessage || /supabase|secret|could not|missing|required|method|json|failed to fetch|network/i.test(rawMessage);
    setStatus(technicalMessage
      ? 'Vi fick inte kontakt med bokningssystemet. Kontrollera anslutningen och försök igen. Dina uppgifter finns kvar. Om felet kvarstår kan du kontakta oss via e-post.'
      : `${rawMessage} Dina uppgifter finns kvar så att du kan rätta eller försöka igen.`);
    submitBookingButton.focus();
  }

  async function submitBooking() {
    if (bookingPending) return;
    for (let step = 1; step <= 3; step += 1) {
      if (!validateStep(step, { focus: false, track: false })) {
        clearStepErrors(step);
        showStep(step);
        validateStep(step, { focus: true, track: true });
        return;
      }
    }

    const { booking, estimate, discountedPrice } = buildBooking();
    if (estimate.isQuote) {
      showStep(2);
      setStatus('Båttransport över 15 sjömil behöver en personlig offert. Använd offertlänken i transportdelen.');
      seaMilesInput.focus();
      return;
    }

    bookingPending = true;
    submitBookingButton.disabled = true;
    submitBookingButton.setAttribute('aria-busy', 'true');
    submitBookingButton.textContent = 'Bekräftar bokningen…';
    setStatus('Bokningen sparas och ditt bekräftelsemejl förbereds…', 'success');

    try {
      const createdBooking = await createBooking(booking);
      saveConfirmationSummary(createdBooking, booking, estimate, discountedPrice);
      safelyRemoveSession(DRAFT_KEY);
      safelyRemoveSession(REBOOK_KEY);
      trackEvent('booking_step_complete', { step: 4, total_steps: 4 });
      trackEvent('booking_submitted', {
        booking_id: createdBooking?.bookingId || '',
        price: Number(createdBooking?.price ?? booking.price),
        currency: 'SEK',
        uses_rut: Boolean(createdBooking?.usesRut ?? estimate.usesRut),
        transport_type: booking.transportType
      });
      window.location.href = 'betalning.html';
    } catch (error) {
      console.error('Bokningen kunde inte slutföras:', error);
      bookingPending = false;
      submitBookingButton.disabled = false;
      submitBookingButton.removeAttribute('aria-busy');
      submitBookingButton.textContent = 'Bekräfta bokning';
      showSubmissionError(error);
    }
  }

  prevMonthButton.addEventListener('click', () => {
    if (!calendarReady || currentCalendarMonth <= firstCalendarMonth) return;
    currentCalendarMonth = new Date(currentCalendarMonth.getFullYear(), currentCalendarMonth.getMonth() - 1, 1, 12);
    renderCalendar();
  });

  nextMonthButton.addEventListener('click', () => {
    if (!calendarReady || currentCalendarMonth >= lastCalendarMonth) return;
    currentCalendarMonth = new Date(currentCalendarMonth.getFullYear(), currentCalendarMonth.getMonth() + 1, 1, 12);
    renderCalendar();
  });

  retryCalendarButton.addEventListener('click', fetchAvailability);
  applyDiscountButton.addEventListener('click', applyDiscountCode);

  byId('windowCountDecrease').addEventListener('click', () => {
    clearControlError('windowCountGroup', 'windowCountError');
    setWindowCountValue(getWindowCountValue() - 1);
  });
  byId('windowCountIncrease').addEventListener('click', () => {
    clearControlError('windowCountGroup', 'windowCountError');
    setWindowCountValue(getWindowCountValue() + 1);
  });
  byId('muntinsCountDecrease').addEventListener('click', () => {
    clearControlError('windowCountGroup', 'windowCountError');
    setMuntinsCountValue(getMuntinsCountValue() - 1);
  });
  byId('muntinsCountIncrease').addEventListener('click', () => {
    clearControlError('windowCountGroup', 'windowCountError');
    setMuntinsCountValue(getMuntinsCountValue() + 1);
  });

  const radioErrorMap = {
    rutChoice: ['rutChoiceGroup', 'rutChoiceError'],
    housingType: ['housingTypeGroup', 'housingTypeError'],
    serviceScope: ['serviceScopeGroup', 'serviceScopeError'],
    transportType: ['transportTypeGroup', 'transportTypeError']
  };
  form.querySelectorAll('input[type="radio"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mapping = radioErrorMap[radio.name];
      if (mapping) clearControlError(mapping[0], mapping[1]);
      refreshBookingState();
    });
  });

  const fieldErrorMap = {
    seaMiles: 'seaMilesError',
    coordinates: 'coordinatesError',
    name: 'nameError',
    phone: 'phoneError',
    email: 'emailError',
    postalCode: 'postalCodeError',
    location: 'locationError',
    recurrenceWeeks: 'recurrenceWeeksError',
    message: 'messageError',
    consent: 'consentError'
  };
  Object.entries(fieldErrorMap).forEach(([controlId, errorId]) => {
    const control = byId(controlId);
    const eventName = control instanceof HTMLSelectElement || control instanceof HTMLInputElement && control.type === 'checkbox'
      ? 'change'
      : 'input';
    control.addEventListener(eventName, () => {
      clearControlError(controlId, errorId);
      if (controlId === 'seaMiles') updateLivePrice();
      saveDraft();
    });
  });

  discountCodeInput.addEventListener('input', () => {
    clearControlError('discountCode', 'discountCodeError');
    const typedCode = discountCodeInput.value.trim().toUpperCase();
    if (appliedDiscount && typedCode !== appliedDiscount.code) {
      appliedDiscount = null;
      setDiscountStatus('Koden ändrades. Klicka på ”Använd kod” igen.');
      updateLivePrice();
    }
    saveDraft();
  });

  document.querySelectorAll('[data-next-step]').forEach((button) => {
    button.addEventListener('click', () => {
      trackBeginBooking();
      if (!validateStep(currentStep)) return;
      trackEvent('booking_step_complete', { step: currentStep, total_steps: 4 });
      if (currentStep === 3) updateSummary();
      showStep(currentStep + 1);
    });
  });

  document.querySelectorAll('[data-previous-step]').forEach((button) => {
    button.addEventListener('click', () => showStep(currentStep - 1));
  });

  document.querySelectorAll('[data-edit-step]').forEach((button) => {
    button.addEventListener('click', () => showStep(Number(button.dataset.editStep)));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    trackBeginBooking();
    submitBooking();
  });

  form.addEventListener('click', trackBeginBooking, { once: true });
  form.addEventListener('input', trackBeginBooking, { once: true });

  window.addEventListener('pageshow', () => {
    if (!bookingPending) {
      submitBookingButton.disabled = false;
      submitBookingButton.removeAttribute('aria-busy');
      submitBookingButton.textContent = 'Bekräfta bokning';
    }
  });

  restoreDraft();
  applyRebookPrefill();
  applyQuerySelection();
  formStartedAtInput.value = String(Date.now());
  updateBoatFields();
  updateLivePrice();
  showStep(1, false);
  fetchAvailability();
})();
