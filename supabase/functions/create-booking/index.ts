import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type BookingPayload = {
  name: string;
  email: string;
  phone: string;
  boatSize: string;
  housingType?: string;
  rutChoice?: string;
  rut_choice?: string;
  windowCount?: string;
  serviceScope?: string;
  paymentMethod?: string;
  addons?: string;
  transportType?: string;
  seaMiles?: string;
  coordinates?: string;
  date: string;
  time: string;
  location: string;
  postalCode?: string;
  postal_code?: string;
  recurrenceWeeks?: number | string | null;
  recurrence_weeks?: number | string | null;
  rebookedFromBookingId?: string | null;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  landingPage?: string;
  message?: string;
  price?: number | string;
  discountCode?: string;
  consentAccepted?: boolean;
  formStartedAt?: string;
  website?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizePhone(value: string) {
  return value.replace(/[^\d+]/g, '');
}

function normalizePostalCode(value: string | undefined) {
  return String(value || '').replace(/\D/g, '');
}

function isDirectServicePostalCode(value: string) {
  // The public service promise covers Stockholm, Österåker, Täby, Vaxholm
  // and the Stockholm archipelago. Those areas use Swedish 1xx xx codes.
  return /^1\d{4}$/.test(value);
}

function normalizeAttribution(value: string | undefined) {
  const normalized = String(value || '').trim();
  return normalized && /^[A-Za-z0-9ÅÄÖåäö._~:/?&=%+\-]{1,160}$/u.test(normalized)
    ? normalized
    : null;
}

function getRecurrenceWeeks(payload: BookingPayload) {
  const raw = payload.recurrenceWeeks ?? payload.recurrence_weeks;
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  return parsed === 8 || parsed === 12 ? parsed : Number.NaN;
}

function formatSek(value: number | null) {
  return value === null ? 'Ej angivet' : `${Math.round(value).toLocaleString('sv-SE')} kr`;
}

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
const MAX_DIRECT_BOOKING_SEA_MILES = 15;
const MAX_BOOKING_HORIZON_DAYS = 365;

function parseCount(value: string | undefined, pattern = /\d+/) {
  const match = String(value || '').match(pattern);
  return match ? Number(match[1] || match[0]) : 0;
}

type RutMode = 'with-rut' | 'without-rut' | 'undecided';

type BookingPriceBreakdown = {
  laborCostBeforeRut: number;
  materialCost: number;
  transportCost: number;
  rutDeduction: number;
  priceBeforeRut: number;
  customerPriceBeforeDiscount: number;
  usesRut: boolean;
};

type FinalizedPriceBreakdown = {
  laborCostBeforeRut: number;
  materialCost: number;
  transportCost: number;
  rutDeduction: number;
  priceBeforeRut: number;
  customerPrice: number;
};

function getRutMode(payload: BookingPayload): RutMode | null {
  const value = String(payload.rutChoice || payload.rut_choice || '').trim();
  if (value === 'Ja, skicka säkert RUT-formulär via bekräftelsemejl') return 'with-rut';
  if (value === 'Nej, jag vill inte använda RUT-avdrag') return 'without-rut';
  if (value === 'Jag är osäker och vill bli kontaktad') return 'undecided';
  return null;
}

function calculateBookingPrice(payload: BookingPayload) {
  const housingType = payload.housingType || payload.boatSize;
  if (!['En våning', 'Två våningar'].includes(housingType)) return null;

  const rutMode = getRutMode(payload);
  if (!rutMode) return null;

  const totalWindows = parseCount(payload.windowCount);
  const regularWindows = parseCount(payload.addons, /(\d+)\s+utan spröjs/i);
  const muntinsWindows = parseCount(payload.addons, /(\d+)\s+med spröjs/i);

  if (totalWindows < 1 || totalWindows > MAX_TOTAL_WINDOWS || regularWindows + muntinsWindows !== totalWindows) {
    return null;
  }

  const includedRegular = Math.min(regularWindows, INCLUDED_WINDOWS);
  const includedMuntins = Math.min(muntinsWindows, Math.max(0, INCLUDED_WINDOWS - includedRegular));
  const extraRegular = Math.max(0, regularWindows - includedRegular);
  const extraMuntins = Math.max(0, muntinsWindows - includedMuntins);
  const floorAddon = housingType === 'Två våningar' ? TWO_FLOOR_ADDON : 0;
  const windowPrice = (extraRegular * EXTRA_REGULAR_WINDOW_PRICE) + (extraMuntins * EXTRA_MUNTINS_WINDOW_PRICE);
  const interiorPrice = payload.serviceScope === 'Invändig + utvändig'
    ? INTERIOR_BASE_ADDON + (Math.max(0, totalWindows - INCLUDED_WINDOWS) * INTERIOR_EXTRA_WINDOW_PRICE)
    : payload.serviceScope === 'Endast utvändig' ? 0 : NaN;

  let transportPrice = 0;
  if (payload.transportType === 'Båttransport behövs') {
    const seaMilesValue = String(payload.seaMiles || '').trim();
    if (!/^\d+$/.test(seaMilesValue) || !String(payload.coordinates || '').trim()) return null;
    const seaMiles = Number(seaMilesValue);
    if (!Number.isFinite(seaMiles) || seaMiles < 0 || seaMiles > MAX_DIRECT_BOOKING_SEA_MILES) return null;
    transportPrice = ISLAND_START_PRICE + (seaMiles * ISLAND_PRICE_PER_SEA_MILE);
  } else if (payload.transportType !== 'Fastland') {
    return null;
  }

  const laborCostAfterRut = BASE_LABOR_PRICE_AFTER_RUT + floorAddon + windowPrice + interiorPrice;
  const laborCostBeforeRut = laborCostAfterRut * 2;
  const materialCost = MATERIAL_FEE;
  const transportCost = transportPrice;
  const usesRut = rutMode === 'with-rut';
  const rutDeduction = usesRut ? laborCostAfterRut : 0;
  const priceBeforeRut = laborCostBeforeRut + materialCost + transportCost;
  const customerPriceBeforeDiscount = priceBeforeRut - rutDeduction;

  if (![laborCostBeforeRut, transportCost, rutDeduction, priceBeforeRut, customerPriceBeforeDiscount].every(Number.isFinite)) {
    return null;
  }

  return {
    laborCostBeforeRut: Math.round(laborCostBeforeRut),
    materialCost,
    transportCost: Math.round(transportCost),
    rutDeduction: Math.round(rutDeduction),
    priceBeforeRut: Math.round(priceBeforeRut),
    customerPriceBeforeDiscount: Math.round(customerPriceBeforeDiscount),
    usesRut
  } satisfies BookingPriceBreakdown;
}

function getCustomerLaborPriceBeforeDiscount(price: BookingPriceBreakdown) {
  return price.usesRut ? price.laborCostBeforeRut / 2 : price.laborCostBeforeRut;
}

function applyCustomerLaborDiscount(
  price: BookingPriceBreakdown,
  customerDiscountAmount: number
): FinalizedPriceBreakdown | null {
  const customerLaborBeforeDiscount = getCustomerLaborPriceBeforeDiscount(price);
  const customerLaborAfterDiscount = customerLaborBeforeDiscount - customerDiscountAmount;

  // A discount code only reduces the customer's labor share. With RUT, the same
  // reduction must also lower the requested RUT amount, so the discounted gross
  // labor cost remains exactly 2 × the customer's remaining labor share.
  if (!Number.isFinite(customerLaborAfterDiscount) || customerLaborAfterDiscount <= 0) return null;

  const laborCostBeforeRut = price.usesRut
    ? customerLaborAfterDiscount * 2
    : customerLaborAfterDiscount;
  const rutDeduction = price.usesRut ? customerLaborAfterDiscount : 0;
  const priceBeforeRut = laborCostBeforeRut + price.materialCost + price.transportCost;
  const customerPrice = customerLaborAfterDiscount + price.materialCost + price.transportCost;

  return {
    laborCostBeforeRut: Math.round(laborCostBeforeRut),
    materialCost: price.materialCost,
    transportCost: price.transportCost,
    rutDeduction: Math.round(rutDeduction),
    priceBeforeRut: Math.round(priceBeforeRut),
    customerPrice: Math.round(customerPrice)
  };
}

type AppliedDiscount = {
  discount_code_id: number;
  normalized_code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  discount_amount: number;
  final_price: number;
};

async function consumeDiscountCode(
  supabaseUrl: string,
  serviceRoleKey: string,
  code: string,
  originalPrice: number
) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_discount_code`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_code: code, p_original_price: originalPrice })
  });

  if (!response.ok) {
    return null;
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] as AppliedDiscount : null;
}

async function callServiceBooleanRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  functionName: 'release_discount_code_usage' | 'discard_unconfirmed_booking',
  body: Record<string, unknown>
) {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      console.error('Booking compensation RPC failed', {
        functionName,
        status: response.status
      });
      return false;
    }
    return (await response.json().catch(() => false)) === true;
  } catch {
    console.error('Booking compensation RPC request failed', { functionName });
    return false;
  }
}

function isSuspiciouslyFastSubmission(startedAt: string | undefined) {
  const startedTime = Number(startedAt || 0);
  const elapsed = Date.now() - startedTime;
  return !Number.isFinite(startedTime)
    || startedTime <= 0
    || elapsed < 1200
    || elapsed > 2 * 60 * 60 * 1000;
}

function isBookableTime(value: string) {
  return ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'].includes(value);
}

function getStockholmDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value || '';
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}

function addDaysToDateString(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isBookableDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsedDate = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) return false;
  const minBookableDate = addDaysToDateString(getStockholmDateString(), 2);
  const maxBookableDate = addDaysToDateString(getStockholmDateString(), MAX_BOOKING_HORIZON_DAYS);
  return value >= minBookableDate && value <= maxBookableDate;
}

async function fetchSupabaseRows(url: string, serviceRoleKey: string) {
  return await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    }
  });
}

function createRutFormToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function consumeRateLimit(
  supabaseUrl: string,
  serviceRoleKey: string,
  namespace: string,
  rawKey: string,
  maxAttempts: number,
  windowSeconds = 3600
) {
  const keyHash = await sha256Hex(serviceRoleKey + ':' + namespace + ':' + rawKey);
  const response = await fetch(supabaseUrl + '/rest/v1/rpc/consume_booking_rate_limit', {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: 'Bearer ' + serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_key_hash: keyHash,
      p_max_attempts: maxAttempts,
      p_window_seconds: windowSeconds
    })
  });

  if (!response.ok) {
    console.error('Booking rate limit could not be checked', await response.text());
    throw new Error('RATE_LIMIT_UNAVAILABLE');
  }

  return (await response.json()) === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(contentLength) && contentLength > 32_768) {
      return jsonResponse({ error: 'För stor begäran.' }, 413);
    }

    let payload: BookingPayload;
    try {
      payload = await readJsonWithLimit<BookingPayload>(req, 32_768);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: 'För stor begäran.' }, 413);
      }
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      }
      throw error;
    }

    if (!payload.name || !payload.email || !payload.phone || !payload.boatSize || !payload.date || !payload.time || !payload.location) {
      return jsonResponse({ error: 'Missing required booking fields' }, 400);
    }

    payload.name = String(payload.name).trim();
    payload.email = String(payload.email).trim().toLowerCase();
    payload.phone = String(payload.phone).trim();
    payload.location = String(payload.location).trim();
    payload.message = String(payload.message || '').trim();

    const normalizedPhone = normalizePhone(payload.phone);
    const normalizedPostalCode = normalizePostalCode(payload.postalCode || payload.postal_code);
    const recurrenceWeeks = getRecurrenceWeeks(payload);
    const rebookedFromBookingId = String(payload.rebookedFromBookingId || '').trim();

    if (payload.name.length < 2 || payload.name.length > 100) {
      return jsonResponse({ error: 'Ange ett giltigt namn med högst 100 tecken.' }, 400);
    }

    if (!isValidEmail(payload.email) || payload.email.length > 254) {
      return jsonResponse({ error: 'Ange en giltig e-postadress.' }, 400);
    }

    if (!/^\+?\d{7,15}$/.test(normalizedPhone)) {
      return jsonResponse({ error: 'Ange ett giltigt telefonnummer.' }, 400);
    }

    if (payload.location.length < 5 || payload.location.length > 240) {
      return jsonResponse({ error: 'Ange en giltig adress med högst 240 tecken.' }, 400);
    }

    if (!isDirectServicePostalCode(normalizedPostalCode)) {
      return jsonResponse({
        error: 'Postnumret ligger utanför området för direktbokning. Skicka i stället en kostnadsfri offertförfrågan.',
        code: 'quote_required',
        quoteUrl: 'offert.html'
      }, 409);
    }

    if (payload.message.length > 2000 || String(payload.coordinates || '').length > 240) {
      return jsonResponse({ error: 'Meddelandet eller platsinformationen är för lång.' }, 400);
    }

    if (Number.isNaN(recurrenceWeeks)) {
      return jsonResponse({ error: 'Välj engångsbesök, var 8:e vecka eller var 12:e vecka.' }, 400);
    }

    if (rebookedFromBookingId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(rebookedFromBookingId)) {
      return jsonResponse({ error: 'Källbokningen för återbokningen är ogiltig.' }, 400);
    }

    if (payload.consentAccepted !== true) {
      return jsonResponse({ error: 'Du behöver bekräfta integritetsinformationen innan bokningen skickas.' }, 400);
    }

    if (!isBookableTime(payload.time)) {
      return jsonResponse({ error: 'Den valda tiden går inte att boka. Välj en tid mellan 10:00 och 17:00.' }, 400);
    }

    if (!isBookableDate(payload.date)) {
      return jsonResponse({ error: 'Välj ett giltigt datum mellan två dagar och tolv månader framåt.' }, 400);
    }

    if (payload.transportType === 'Båttransport behövs') {
      const seaMiles = Number(String(payload.seaMiles || '').trim());
      if (Number.isFinite(seaMiles) && seaMiles > MAX_DIRECT_BOOKING_SEA_MILES) {
        return jsonResponse({
          error: 'Båttransport över 15 sjömil hanteras via offert.',
          code: 'quote_required',
          quoteUrl: 'offert.html'
        }, 409);
      }
    }

    const priceBreakdown = calculateBookingPrice(payload);
    if (priceBreakdown === null) {
      return jsonResponse({ error: 'Prisuppgifterna är ogiltiga. Kontrollera RUT-val, bostad, fönster och transport.' }, 400);
    }
    // Backwards-compatible meaning: the customer's selected RUT/no-RUT price before discount.
    const originalPrice = priceBreakdown.customerPriceBeforeDiscount;

    if (payload.website) {
      return jsonResponse({ error: 'Formuläret innehåller ett ogiltigt extrafält. Ladda om sidan och försök igen.' }, 400);
    }

    if (isSuspiciouslyFastSubmission(payload.formStartedAt)) {
      return jsonResponse({ error: 'Vänta ett ögonblick och försök skicka bokningen igen.' }, 429);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const notificationEmail = Deno.env.get('BOOKING_NOTIFICATION_EMAIL') || 'bokning@bergafonsterputs.se';
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase secrets are missing', {
        hasSupabaseUrl: Boolean(supabaseUrl),
        hasServiceRoleKey: Boolean(serviceRoleKey)
      });
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    if (!resendApiKey || !fromEmail) {
      console.error('Email secrets are missing', {
        hasResendApiKey: Boolean(resendApiKey),
        hasFromEmail: Boolean(fromEmail),
        notificationEmail,
        contactEmail
      });
      return jsonResponse({ error: 'Email secrets are missing' }, 500);
    }

    const clientIp = String(
      req.headers.get('cf-connecting-ip')
        || req.headers.get('x-real-ip')
        || req.headers.get('x-forwarded-for')?.split(',')[0]
        || 'unknown'
    ).trim().slice(0, 80);

    try {
      const rateLimitResults = await Promise.all([
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'ip', clientIp, 5),
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'email', payload.email, 3),
        consumeRateLimit(supabaseUrl, serviceRoleKey, 'phone', normalizedPhone, 3)
      ]);

      if (rateLimitResults.some((allowed) => !allowed)) {
        return jsonResponse({
          error: 'För många bokningsförsök på kort tid. Vänta en stund eller kontakta oss via e-post.'
        }, 429);
      }
    } catch {
      return jsonResponse({
        error: 'Bokningsskyddet kunde inte kontrolleras. Försök igen om en stund.'
      }, 503);
    }

    const blockedDateRes = await fetchSupabaseRows(
      `${supabaseUrl}/rest/v1/booking_blocked_dates?select=id&blocked_date=eq.${encodeURIComponent(payload.date)}&limit=1`,
      serviceRoleKey
    );

    if (!blockedDateRes.ok) {
      console.error('Could not check blocked booking dates', await blockedDateRes.text());
      return jsonResponse({ error: 'Could not check booking availability' }, 500);
    }

    const blockedDates = await blockedDateRes.json();
    if (Array.isArray(blockedDates) && blockedDates.length) {
      return jsonResponse({ error: 'Det valda datumet är inte bokbart. Välj en annan dag.' }, 409);
    }

    const existingBookingRes = await fetchSupabaseRows(
      `${supabaseUrl}/rest/v1/bookings?select=id&booking_date=eq.${encodeURIComponent(payload.date)}&status=in.(pending,confirmed)&limit=1`,
      serviceRoleKey
    );

    if (!existingBookingRes.ok) {
      console.error('Could not check existing bookings', await existingBookingRes.text());
      return jsonResponse({ error: 'Could not check booking availability' }, 500);
    }

    const existingBookings = await existingBookingRes.json();
    if (Array.isArray(existingBookings) && existingBookings.length) {
      return jsonResponse({ error: 'Det valda datumet är redan bokat. Välj en annan dag.' }, 409);
    }

    const normalizedDiscountCode = String(payload.discountCode || '').trim().toUpperCase();
    let appliedDiscount: AppliedDiscount | null = null;
    const customerLaborPriceBeforeDiscount = getCustomerLaborPriceBeforeDiscount(priceBreakdown);

    if (normalizedDiscountCode) {
      if (!/^[A-Z0-9_-]{3,32}$/.test(normalizedDiscountCode)) {
        return jsonResponse({ error: 'Rabattkoden är ogiltig.' }, 400);
      }

      appliedDiscount = await consumeDiscountCode(
        supabaseUrl,
        serviceRoleKey,
        normalizedDiscountCode,
        customerLaborPriceBeforeDiscount
      );
      if (!appliedDiscount) {
        return jsonResponse({ error: 'Rabattkoden är ogiltig, har gått ut eller har redan använts maximalt antal gånger.' }, 400);
      }
    }

    const customerDiscountAmount = appliedDiscount?.discount_amount || 0;
    const finalizedPrice = applyCustomerLaborDiscount(priceBreakdown, customerDiscountAmount);
    if (!finalizedPrice) {
      if (appliedDiscount?.discount_code_id) {
        await callServiceBooleanRpc(
          supabaseUrl,
          serviceRoleKey,
          'release_discount_code_usage',
          { p_discount_code_id: appliedDiscount.discount_code_id }
        );
      }
      return jsonResponse({ error: 'Rabatten är för stor för arbetskostnaden.' }, 400);
    }
    const finalPrice = finalizedPrice.customerPrice;
    const managementToken = createRutFormToken();
    const bookingInsert = {
      customer_name: payload.name,
      email: payload.email,
      phone: normalizedPhone || payload.phone,
      housing_type: payload.housingType || payload.boatSize,
      window_count: payload.windowCount || null,
      service_scope: payload.serviceScope || null,
      payment_method: 'Swish Företag',
      addons: payload.addons || null,
      transport_type: payload.transportType || 'Fastland',
      sea_miles: payload.seaMiles || null,
      coordinates: payload.coordinates || null,
      booking_date: payload.date,
      booking_time: payload.time,
      address: payload.location,
      postal_code: normalizedPostalCode,
      message: payload.message || null,
      price: String(finalPrice),
      // Trusted invoice components after any labor-only discount.
      labor_cost_before_rut: finalizedPrice.laborCostBeforeRut,
      material_cost: finalizedPrice.materialCost,
      transport_cost: finalizedPrice.transportCost,
      rut_deduction: finalizedPrice.rutDeduction,
      price_before_rut: finalizedPrice.priceBeforeRut,
      customer_price_before_discount: priceBreakdown.customerPriceBeforeDiscount,
      // Kept for older admin/payment code; same value as customer_price_before_discount.
      original_price: originalPrice,
      discount_amount: customerDiscountAmount,
      discount_code: appliedDiscount?.normalized_code || null,
      discount_code_id: appliedDiscount?.discount_code_id || null,
      rut_choice: payload.rutChoice || payload.rut_choice || null,
      rut_form_token: null,
      rut_status: priceBreakdown.usesRut
        ? 'Ej skickat'
        : getRutMode(payload) === 'without-rut' ? 'Ej RUT' : 'Ej skickat',
      rut_application_status: 'not_ready',
      management_token: managementToken,
      email_confirmation_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      recurrence_weeks: recurrenceWeeks,
      recurrence_opt_in_at: recurrenceWeeks ? new Date().toISOString() : null,
      rebooked_from_booking_id: rebookedFromBookingId || null,
      utm_source: normalizeAttribution(payload.utmSource),
      utm_medium: normalizeAttribution(payload.utmMedium),
      utm_campaign: normalizeAttribution(payload.utmCampaign),
      utm_content: normalizeAttribution(payload.utmContent),
      utm_term: normalizeAttribution(payload.utmTerm),
      landing_page: normalizeAttribution(payload.landingPage),
      consent_accepted: true,
      status: 'awaiting_confirmation',
      payment_status: 'unpaid'
    };

    const optionalPriceColumns = [
      'labor_cost_before_rut',
      'material_cost',
      'transport_cost',
      'rut_deduction',
      'price_before_rut',
      'customer_price_before_discount'
    ];
    const optionalRutWorkflowColumns = [
      'rut_status',
      'rut_application_status'
    ];
    const insertWithSchemaFallback: Record<string, unknown> = { ...bookingInsert };
    let bookingRes: Response | null = null;
    let bookingErrorText = '';

    for (let attempt = 0; attempt < 6; attempt += 1) {
      bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=id`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(insertWithSchemaFallback)
      });

      if (bookingRes.ok) break;

      bookingErrorText = await bookingRes.text();
      let removedUnsupportedField = false;

      if (optionalPriceColumns.some((column) => bookingErrorText.includes(column))) {
        optionalPriceColumns.forEach((column) => delete insertWithSchemaFallback[column]);
        removedUnsupportedField = true;
      }

      optionalRutWorkflowColumns.forEach((column) => {
        if (bookingErrorText.includes(column)) {
          delete insertWithSchemaFallback[column];
          removedUnsupportedField = true;
        }
      });

      if (/rut_choice/i.test(bookingErrorText) && !/rut_form_token/i.test(bookingErrorText)) {
        delete insertWithSchemaFallback.rut_choice;
        removedUnsupportedField = true;
      }

      if (!removedUnsupportedField) break;
    }

    if (!bookingRes?.ok) {
      console.error('Could not save booking', bookingErrorText);
      if (appliedDiscount?.discount_code_id) {
        await callServiceBooleanRpc(
          supabaseUrl,
          serviceRoleKey,
          'release_discount_code_usage',
          { p_discount_code_id: appliedDiscount.discount_code_id }
        );
      }
      return jsonResponse({ error: 'Bokningen kunde inte sparas just nu. Försök igen.' }, 500);
    }

    const [savedBooking] = await bookingRes.json();

    const safeMessage = payload.message ? escapeHtml(payload.message).replaceAll('\n', '<br>') : 'Ingen extra information';
    const safeHousingType = payload.housingType ? escapeHtml(payload.housingType) : escapeHtml(payload.boatSize);
    const safeWindowCount = payload.windowCount ? escapeHtml(payload.windowCount) : 'Ej angivet';
    const safeServiceScope = payload.serviceScope ? escapeHtml(payload.serviceScope) : 'Ej angivet';
    const safePaymentMethod = 'Swish Företag';
    const rawRutChoice = payload.rutChoice || payload.rut_choice || '';
    const rutMode = getRutMode(payload);
    const safeRutChoice = rawRutChoice ? escapeHtml(rawRutChoice) : 'Ej angivet';
    const safeAddons = payload.addons ? escapeHtml(payload.addons).replaceAll('\n', '<br>') : 'Inga tillägg';
    const safeTransportType = payload.transportType ? escapeHtml(payload.transportType) : 'Fastland';
    const safeSeaMiles = payload.seaMiles ? escapeHtml(payload.seaMiles) : 'Ej angivet';
    const safeCoordinates = payload.coordinates ? escapeHtml(payload.coordinates) : 'Ej angivet';
    const safePriceDisplay = formatSek(finalPrice);
    const safeOriginalPriceDisplay = formatSek(originalPrice);
    const safeDiscountDisplay = appliedDiscount ? `-${formatSek(appliedDiscount.discount_amount)}` : '';
    const safeDiscountCode = appliedDiscount ? escapeHtml(appliedDiscount.normalized_code) : '';
    const logoUrl = `${siteUrl}/logga-fonsterputs-transparent.png`;
    const safeLogoUrl = escapeHtml(logoUrl);
    const safeContactEmail = escapeHtml(contactEmail);
    const laborCostBeforeRutDisplay = formatSek(finalizedPrice.laborCostBeforeRut);
    const materialCostDisplay = formatSek(finalizedPrice.materialCost);
    const transportCostDisplay = formatSek(finalizedPrice.transportCost);
    const priceBeforeRutDisplay = formatSek(finalizedPrice.priceBeforeRut);
    const rutDeductionDisplay = finalizedPrice.rutDeduction > 0
      ? `-${formatSek(finalizedPrice.rutDeduction)}`
      : formatSek(0);
    const customerPriceDisplay = formatSek(finalPrice);
    const priceSectionTitle = priceBreakdown.usesRut ? 'Pris med RUT' : 'Pris utan RUT';
    const customerPriceLabel = priceBreakdown.usesRut ? 'Att betala med RUT' : 'Att betala utan RUT';
    const laborCostLabel = appliedDiscount ? 'Arbetskostnad efter rabatt, före RUT' : 'Arbetskostnad före RUT';
    const managementFragment = new URLSearchParams({
      bookingId: String(savedBooking?.id || ''),
      token: managementToken,
      action: 'confirm'
    });
    const manageUrl = `${siteUrl}/hantera-bokning.html#${managementFragment.toString()}`;
    const safeManageUrl = escapeHtml(manageUrl);
    const customerDetailRows = [
      ['Datum', escapeHtml(payload.date || 'Ej angivet')],
      ['Tid', escapeHtml(payload.time || 'Ej angivet')],
      ['Adress', escapeHtml(payload.location || 'Ej angivet')],
      ['Postnummer', escapeHtml(normalizedPostalCode)],
      ['Typ av bostad', safeHousingType || 'Ej angivet'],
      ['Tjänst', safeServiceScope],
      ['Antal fönster / glaspartier', safeWindowCount],
      ['Tillägg', safeAddons],
      ['Transport', safeTransportType],
      ['Återkommande', recurrenceWeeks ? `Var ${recurrenceWeeks}:e vecka` : 'Engångsbesök'],
      ...(payload.seaMiles ? [['Sjömil', safeSeaMiles]] : []),
      ...(payload.coordinates ? [['Koordinater', safeCoordinates]] : [])
      ,...(appliedDiscount ? [
        ['Rabattkod', safeDiscountCode],
        ['Ordinarie pris', safeOriginalPriceDisplay],
        ['Rabatt', safeDiscountDisplay]
      ] : [])
    ].map(([label, value]) => `
          <tr>
            <td width="42%" style="width: 42%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #5b6b7a; font-size: 14px; vertical-align: top;">${label}</td>
            <td width="58%" style="width: 58%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #0f2638; font-size: 14px; font-weight: 700; text-align: right; vertical-align: top;">${value || 'Ej angivet'}</td>
          </tr>
        `).join('');
    const confirmationSection = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fff8ec; border: 1px solid #ffd08b; border-radius: 14px;">
        <tr>
          <td style="padding: 20px;">
            <p style="margin: 0 0 8px; color: #7a5100; font-size: 12px; line-height: 1.3; font-weight: 800; text-transform: uppercase; letter-spacing: .05em;">Bekräfta din e-post</p>
            <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 20px; line-height: 1.25;">Ett klick kvar innan tiden reserveras</h2>
            <p style="margin: 0 0 14px; color: #536574; font-size: 14px; line-height: 1.7;">Bekräfta bokningen inom 24 timmar. Först då reserveras dagen i kalendern. Samma säkra sida kan senare användas för ombokning, avbokning, kalenderfil och återkommande putsning.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%;">
              <tr>
                <td align="center" style="background: #247a43; border-radius: 999px;">
                  <a href="${safeManageUrl}" style="display: block; padding: 14px 20px; color: #ffffff; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">BEKRÄFTA BOKNINGEN</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
    const safeRutFormUrl = '';
    const rutFormSection = rutMode === 'with-rut'
      ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f7fbf8; border: 1px solid #d7e7dd; border-radius: 14px;">
          <tr>
            <td style="padding: 20px;">
              <p style="margin: 0 0 8px; color: #287a45; font-size: 12px; line-height: 1.3; font-weight: 800; text-transform: uppercase; letter-spacing: .05em;">Viktigt inför RUT</p>
              <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 20px; line-height: 1.25;">Fyll i RUT-formuläret</h2>
          ${safeRutFormUrl
            ? `<p style="margin: 0 0 14px; color: #536574; font-size: 14px; line-height: 1.7;">För att vi ska kunna hantera RUT-avdraget behöver du fylla i uppgifterna i vårt säkra formulär.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%;">
                <tr>
                  <td align="center" style="background: #247a43; border-radius: 999px;">
                    <a href="${safeRutFormUrl}" style="display: block; padding: 14px 20px; color: #ffffff; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">FYLL I RUT-FORMULÄR</a>
                  </td>
                </tr>
              </table>`
            : '<p style="margin: 0; color: #536574; font-size: 14px; line-height: 1.7;">Vi skickar en säker formulärlänk för RUT-uppgifterna innan jobbet utförs.</p>'}
            </td>
          </tr>
        </table>
      `
      : rutMode === 'without-rut'
        ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fff8ec; border: 1px solid #ffd08b; border-radius: 14px;">
            <tr>
              <td style="padding: 18px 20px;">
                <p style="margin: 0; color: #0f2638; font-size: 14px; line-height: 1.7;"><strong>RUT-avdrag:</strong> Du har valt att inte använda RUT-avdrag. Priset är därför beräknat med hela arbetskostnaden.</p>
              </td>
            </tr>
          </table>
        `
        : `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fff8ec; border: 1px solid #ffd08b; border-radius: 14px;">
            <tr>
              <td style="padding: 18px 20px;">
                <p style="margin: 0; color: #0f2638; font-size: 14px; line-height: 1.7;"><strong>RUT-avdrag:</strong> Vi kontaktar dig om RUT-valet behöver stämmas av.</p>
              </td>
            </tr>
          </table>
        `;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; color: #173042; line-height: 1.6;">
        <h2 style="margin-bottom: 12px;">Ny obekräftad bokning</h2>
        <p>Kunden har skickat bokningen men behöver fortfarande bekräfta sin e-post. Dagen blockeras först efter bekräftelsen.</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 680px;">
          <tr><td style="padding: 8px 0; font-weight: 700;">Namn</td><td style="padding: 8px 0;">${escapeHtml(payload.name)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">E-post</td><td style="padding: 8px 0;">${escapeHtml(payload.email)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Telefon</td><td style="padding: 8px 0;">${escapeHtml(payload.phone)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Adress</td><td style="padding: 8px 0;">${escapeHtml(payload.location)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Postnummer</td><td style="padding: 8px 0;">${escapeHtml(normalizedPostalCode)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Datum</td><td style="padding: 8px 0;">${escapeHtml(payload.date)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tid</td><td style="padding: 8px 0;">${escapeHtml(payload.time)}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Typ av bostad</td><td style="padding: 8px 0;">${safeHousingType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">RUT-val</td><td style="padding: 8px 0;">${safeRutChoice}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Antal fönster / glaspartier</td><td style="padding: 8px 0;">${safeWindowCount}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Putsning</td><td style="padding: 8px 0;">${safeServiceScope}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Transport</td><td style="padding: 8px 0;">${safeTransportType}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Sjömil från Svinnige marina</td><td style="padding: 8px 0;">${safeSeaMiles}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Koordinater</td><td style="padding: 8px 0;">${safeCoordinates}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Betalningsmetod</td><td style="padding: 8px 0;">${safePaymentMethod}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Tillägg</td><td style="padding: 8px 0;">${safeAddons}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">${laborCostLabel}</td><td style="padding: 8px 0;">${laborCostBeforeRutDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Material (ej RUT)</td><td style="padding: 8px 0;">${materialCostDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Transport/resa (ej RUT)</td><td style="padding: 8px 0;">${transportCostDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">RUT-avdrag</td><td style="padding: 8px 0;">${rutDeductionDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Kundpris före rabatt</td><td style="padding: 8px 0;">${safeOriginalPriceDisplay}</td></tr>
          ${appliedDiscount ? `<tr><td style="padding: 8px 0; font-weight: 700;">Rabattkod</td><td style="padding: 8px 0;">${safeDiscountCode} (${safeDiscountDisplay})</td></tr>` : ''}
          <tr><td style="padding: 8px 0; font-weight: 700;">Att betala</td><td style="padding: 8px 0;">${safePriceDisplay}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700; vertical-align: top;">Meddelande</td><td style="padding: 8px 0;">${safeMessage}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Samtycke</td><td style="padding: 8px 0;">${payload.consentAccepted ? 'Ja' : 'Nej'}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Återkommande önskemål</td><td style="padding: 8px 0;">${recurrenceWeeks ? `Var ${recurrenceWeeks}:e vecka` : 'Engångsbesök'}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 700;">Boknings-ID</td><td style="padding: 8px 0;">${escapeHtml(String(savedBooking?.id || 'okänt'))}</td></tr>
        </table>
      </div>
    `;

    const customerEmailHtml = `
      <div style="margin: 0; padding: 0; background: #f3f6f8; font-family: Arial, Helvetica, sans-serif; color: #0f2638;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; background: #f3f6f8;">
          <tr>
            <td align="center" style="padding: 32px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 820px; border-collapse: collapse;">
                <tr>
                  <td style="background: #0f2638; border-radius: 18px 18px 0 0; padding: 28px 24px 20px; text-align: center;">
                    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 18px; border-collapse: collapse;">
                      <tr>
                        <td align="center" style="background: #ffffff; border-radius: 16px; padding: 10px 12px;">
                          <img src="${safeLogoUrl}" width="118" alt="Berga Fönsterputs" style="display: block; width: 118px; max-width: 118px; height: auto; margin: 0 auto;">
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">Tryggt &amp; säkert</td>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">Skinande resultat</td>
                        <td align="center" style="padding: 4px; color: #ffffff; font-size: 12px; font-weight: 700;">Personlig service</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 38px 42px 14px;">
                    <h1 style="margin: 0 0 12px; color: #0f2638; font-size: 34px; line-height: 1.16; font-weight: 800;">Tack för din bokning!</h1>
                    <p style="margin: 0 0 8px; color: #173042; font-size: 17px; line-height: 1.6;">Hej ${escapeHtml(payload.name || '')},</p>
                    <p style="margin: 0; color: #536574; font-size: 15px; line-height: 1.7;">Vi har tagit emot din bokning och ser fram emot att hjälpa dig.</p>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 22px 42px 8px;">
                    ${confirmationSection}
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    ${rutFormSection}
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 20px; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                          <h2 style="margin: 0 0 12px; color: #0f2638; font-size: 18px;">Inför besöket</h2>
                          <ul style="margin: 0; padding-left: 20px; color: #536574; font-size: 14px; line-height: 1.7;">
                            <li>Plocka undan föremål nära fönster.</li>
                            <li>Säkerställ att vi kommer åt fönstren.</li>
                            <li>Meddela oss om något fönster är skadat eller svårt att nå.</li>
                          </ul>
                          <p style="margin: 14px 0 0; padding: 12px 14px; background: #eef3f6; border-left: 4px solid #0f2638; color: #173042; font-size: 13px; line-height: 1.6;">Vi utför endast arbete som kan genomföras säkert från mark, normal hushållsstege eller inifrån bostaden.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px 20px 6px;">
                          <h2 style="margin: 0 0 6px; color: #0f2638; font-size: 18px; line-height: 1.3;">Bokningsdetaljer</h2>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            ${customerDetailRows}
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #d7e7dd; border-radius: 14px; background: #f7fbf8;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 14px; color: #0f2638; font-size: 18px; line-height: 1.3;">${priceSectionTitle}</h2>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">${laborCostLabel}</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${laborCostBeforeRutDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Material (ej RUT)</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${materialCostDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Transport/resa (ej RUT)</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${transportCostDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Pris före RUT</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${priceBeforeRutDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">RUT-avdrag (50% av arbetskostnaden)</td>
                              <td align="right" style="padding: 9px 0; color: #287a45; font-size: 15px; font-weight: 700;">${rutDeductionDisplay}</td>
                            </tr>
                            ${appliedDiscount ? `
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Kundpris före rabatt</td>
                              <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${safeOriginalPriceDisplay}</td>
                            </tr>
                            <tr>
                              <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Din arbetsrabatt ${safeDiscountCode} (inräknad)</td>
                              <td align="right" style="padding: 9px 0; color: #287a45; font-size: 15px; font-weight: 700;">${safeDiscountDisplay}</td>
                            </tr>` : ''}
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 12px; border-collapse: collapse; background: #247a43; border-radius: 12px;">
                            <tr>
                              <td style="padding: 18px 18px; color: #ffffff; font-size: 15px; font-weight: 700;">${customerPriceLabel}</td>
                              <td align="right" style="padding: 18px 18px; color: #ffffff; font-size: 26px; line-height: 1.1; font-weight: 800;">${customerPriceDisplay}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 20px; background: #0f2638; border-radius: 14px;">
                          <h2 style="margin: 0 0 12px; color: #ffffff; font-size: 18px;">Betalning</h2>
                          <p style="margin: 0 0 14px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">När jobbet är klart skickar vi belopp, Swish-nummer och referens i klartmejlet.</p>
                          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                            <tr>
                              <td style="padding: 8px 12px; background: #ffffff; color: #0f2638; font-size: 13px; font-weight: 700; border-radius: 999px;">Swish Företag i klartmejlet</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 34px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Frågor?</h2>
                          <p style="margin: 0 0 12px; color: #536574; font-size: 14px; line-height: 1.7;">Svara direkt på detta mail om du har frågor eller vill ändra din bokning.</p>
                          <p style="margin: 0; color: #0f2638; font-size: 14px; line-height: 1.8;"><strong>E-post:</strong> <a href="mailto:${safeContactEmail}" style="color: #0f5475; text-decoration: underline;">${safeContactEmail}</a></p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background: #0f2638; border-radius: 0 0 18px 18px; padding: 24px 20px; text-align: center;">
                    <p style="margin: 0 0 6px; color: #ffffff; font-size: 16px; font-weight: 800;">Tack för att du väljer Berga Fönsterputs!</p>
                    <p style="margin: 0; color: #d8e1e8; font-size: 13px; line-height: 1.6;">Lokalt företag – personligt bemötande – skinande resultat</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    `;

    const emailPayload: Record<string, unknown> = {
      from: fromEmail,
      to: [notificationEmail],
      subject: `Obekräftad bokning ${payload.date} ${payload.time} - ${payload.name}`,
      html: emailHtml
    };

    if (isValidEmail(payload.email)) {
      emailPayload.reply_to = payload.email.trim();
    }

    let customerEmailSent = false;
    let customerEmailRes: Response | null = null;

    if (isValidEmail(payload.email)) {
      try {
        customerEmailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `create-booking-confirmation-${savedBooking?.id || 'unknown'}`
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [payload.email.trim()],
            subject: `Bekräfta din bokning hos Berga Fönsterputs ${payload.date}`,
            html: customerEmailHtml,
            reply_to: contactEmail
          })
        });
      } catch {
        console.error('Customer confirmation email request failed');
      }

      if (customerEmailRes && !customerEmailRes.ok) {
        const customerErrorText = await customerEmailRes.text();
        console.error('Customer confirmation email failed', customerErrorText);
      } else if (customerEmailRes?.ok) {
        customerEmailSent = true;
      }
    }

    if (!customerEmailSent) {
      const rolledBack = customerEmailRes && savedBooking?.id
        ? await callServiceBooleanRpc(
            supabaseUrl,
            serviceRoleKey,
            'discard_unconfirmed_booking',
            { p_booking_id: String(savedBooking.id) }
          )
        : false;
      return jsonResponse({
        error: rolledBack
          ? 'Bekräftelsemejlet kunde inte skickas och bokningen genomfördes inte. Försök igen.'
          : 'Bekräftelsemejlet kunde inte skickas. Kontakta oss innan du försöker igen.'
      }, 502);
    }

    if (customerEmailSent && savedBooking?.id) {
      await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${encodeURIComponent(savedBooking.id)}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          confirmation_email_sent: true,
          confirmation_email_sent_at: new Date().toISOString()
        })
      });
    }

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `create-booking-admin-${savedBooking?.id || 'unknown'}`
        },
        body: JSON.stringify(emailPayload)
      });

      if (!emailRes.ok) {
        const errorText = await emailRes.text();
        console.error('Admin booking notification failed', errorText);
      }
    } catch {
      console.error('Admin booking notification request failed');
    }

    return jsonResponse({
      success: true,
      bookingId: savedBooking?.id || null,
      price: finalPrice,
      originalPrice,
      laborCostBeforeRut: finalizedPrice.laborCostBeforeRut,
      materialCost: finalizedPrice.materialCost,
      transportCost: finalizedPrice.transportCost,
      rutDeduction: finalizedPrice.rutDeduction,
      priceBeforeRut: finalizedPrice.priceBeforeRut,
      customerPriceBeforeDiscount: priceBreakdown.customerPriceBeforeDiscount,
      usesRut: priceBreakdown.usesRut,
      discountAmount: customerDiscountAmount,
      discountCode: appliedDiscount?.normalized_code || null,
      customerEmailSent,
      requiresEmailConfirmation: true,
      stripeCheckoutUrl: null,
      stripeCheckoutSessionId: null
    });
  } catch (error) {
    console.error('Unhandled create-booking error', error);
    return jsonResponse({ error: 'Bokningen kunde inte hanteras just nu. Försök igen.' }, 500);
  }
});
