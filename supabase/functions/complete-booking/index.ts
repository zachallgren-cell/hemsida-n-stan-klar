import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://bergafonsterputs.se',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin'
};

type CompleteBookingPayload = {
  bookingId: number;
  paymentMethod?: string;
  swishAmount?: number | string;
  invoiceReference?: string;
  actualWorkHours?: number | string;
  laborCostBeforeRut?: number | string;
  materialCost?: number | string;
  transportCost?: number | string;
  rutDeduction?: number | string;
};

const SWISH_NUMBER = '1236774384';
const SWISH_NUMBER_DISPLAY = '123 677 43 84';
const SWISH_RECIPIENT_NAME = 'Zac Hallgren';
const DEFAULT_MATERIAL_COST_ORE = 15000;
const ISLAND_START_PRICE_ORE = 79900;
const ISLAND_PRICE_PER_SEA_MILE_ORE = 12500;
const MAX_PAYMENT_AMOUNT_ORE = 100000000;

class ValidationError extends Error {}

type AdminCheckResult = {
  ok: true;
} | {
  ok: false;
  response: Response;
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

function getJwtAssuranceLevel(authHeader: string) {
  try {
    const token = authHeader.replace(/^bearer\s+/i, '');
    const payloadPart = token.split('.')[1] || '';
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return String(payload?.aal || 'aal1');
  } catch {
    return 'invalid';
  }
}

function parseMoneyToOre(value: number | string | undefined, allowZero = false) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
      ? Math.round(value * 100)
      : null;
  }

  const rawValue = String(value ?? '').trim();
  if (!rawValue || /offert|kontakta/i.test(rawValue)) {
    return null;
  }

  let normalized = rawValue.replace(/\s/g, '').replace(/[^\d,.-]/g, '');

  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replaceAll('.', '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replaceAll('.', '');
  } else {
    normalized = normalized.replace(',', '.');
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0)
    ? Math.round(parsed * 100)
    : null;
}

function hasOwnValue(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function parseOptionalMoney(value: number | string | undefined, fieldLabel: string) {
  if (!hasOwnValue(value)) {
    return null;
  }

  const parsed = parseMoneyToOre(value, true);
  if (parsed === null || parsed > MAX_PAYMENT_AMOUNT_ORE) {
    throw new ValidationError(`${fieldLabel} måste vara ett giltigt belopp mellan 0 och 1 000 000 kr.`);
  }

  return parsed;
}

function formatSekFromOre(valueOre: number | null) {
  if (valueOre === null) {
    return '';
  }

  const hasOre = valueOre % 100 !== 0;
  return `${(valueOre / 100).toLocaleString('sv-SE', {
    minimumFractionDigits: hasOre ? 2 : 0,
    maximumFractionDigits: 2
  })} kr`;
}

function formatSwishAmount(valueOre: number) {
  return (valueOre / 100).toFixed(2);
}

function getDefaultTransportCostOre(booking: Record<string, unknown>) {
  if (String(booking.transport_type || '') !== 'Båttransport behövs') {
    return 0;
  }

  const rawSeaMiles = String(booking.sea_miles ?? '').trim().replace(',', '.');
  const seaMiles = Number(rawSeaMiles);

  if (!Number.isFinite(seaMiles) || seaMiles < 0 || seaMiles > 1000) {
    throw new ValidationError('Bokningens antal sjömil är ogiltigt. Rätta bokningen innan klartmejlet skickas.');
  }

  return Math.round(ISLAND_START_PRICE_ORE + (seaMiles * ISLAND_PRICE_PER_SEA_MILE_ORE));
}

function usesRutDeduction(booking: Record<string, unknown>) {
  const choice = String(booking.rut_choice || '').trim();
  return /^Ja\b/i.test(choice);
}

function normalizeInvoiceReference(value: unknown) {
  const reference = String(value ?? '').trim();

  if (!reference) {
    throw new ValidationError('Fyll i fakturanumret eller referensen från den manuellt skapade fakturan.');
  }

  if (reference.length > 35 || !/^[A-Za-zÅÄÖåäö0-9 .:;,!?()\-”]+$/u.test(reference)) {
    throw new ValidationError('Fakturareferensen får vara högst 35 tecken och bara innehålla bokstäver, siffror, mellanslag och enkel skiljeteckensättning.');
  }

  return reference;
}

function parseActualWorkHours(value: number | string | undefined) {
  if (!hasOwnValue(value)) {
    return null;
  }

  const hours = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 1000 || Math.abs(Math.round(hours * 100) - (hours * 100)) > 1e-8) {
    throw new ValidationError('Faktisk arbetstid måste vara mellan 0,01 och 1 000 timmar och ha högst två decimaler.');
  }

  return hours;
}

function buildSwishUrl(amountOre: number, reference: string) {
  const url = new URL('https://app.swish.nu/1/p/sw/');
  url.searchParams.set('sw', SWISH_NUMBER);
  url.searchParams.set('amt', formatSwishAmount(amountOre));
  url.searchParams.set('cur', 'SEK');
  url.searchParams.set('msg', reference);
  url.searchParams.set('src', 'qr');
  return url.toString();
}

function hasDisplayValue(value: unknown) {
  return String(value ?? '').trim().length > 0;
}

function escapeDisplayValue(value: unknown) {
  return escapeHtml(String(value ?? '').trim());
}

function buildDetailRow(label: string, value: unknown) {
  if (!hasDisplayValue(value)) {
    return '';
  }

  return `
    <tr>
      <td width="42%" style="width: 42%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #5b6b7a; font-size: 14px; vertical-align: top;">${label}</td>
      <td width="58%" style="width: 58%; padding: 12px 0; border-bottom: 1px solid #e6edf3; color: #0f2638; font-size: 14px; font-weight: 700; text-align: right; vertical-align: top;">${escapeDisplayValue(value)}</td>
    </tr>
  `;
}

function buildWorkRow(value: unknown) {
  if (!hasDisplayValue(value)) {
    return '';
  }

  return `
    <tr>
      <td width="28" style="width: 28px; padding: 6px 0; color: #287a45; font-size: 15px; font-weight: 800; vertical-align: top;">&#10003;</td>
      <td style="padding: 6px 0; color: #0f2638; font-size: 14px; line-height: 1.55; font-weight: 700;">${escapeDisplayValue(value)}</td>
    </tr>
  `;
}

function splitAddons(value: unknown) {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requireBookingAdmin(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
  bookingId: number
): Promise<AdminCheckResult> {
  const authHeader = req.headers.get('authorization') || '';

  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, response: jsonResponse({ error: 'Admin login is required' }, 401) };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader
    }
  });

  if (!userRes.ok) {
    return { ok: false, response: jsonResponse({ error: 'Admin session could not be verified' }, 401) };
  }

  const user = await userRes.json();
  const userId = String(user?.id || '');

  if (!userId) {
    return { ok: false, response: jsonResponse({ error: 'Admin session is missing user id' }, 401) };
  }

  if (getJwtAssuranceLevel(authHeader) !== 'aal2') {
    return {
      ok: false,
      response: jsonResponse({ error: 'Tvåstegsverifiering krävs för att skicka klartmejlet.', code: 'mfa_required' }, 403)
    };
  }

  // Use the user's JWT for one RLS-protected read. private.is_booking_admin()
  // enforces the allowlist, AAL2 and a currently verified factor before any
  // service-role fetch, email or mutation is allowed below.
  const publicApiKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey;
  const adminRes = await fetch(`${supabaseUrl}/rest/v1/bookings?select=id&id=eq.${bookingId}&limit=1`, {
    headers: {
      apikey: publicApiKey,
      Authorization: authHeader,
      'Content-Type': 'application/json'
    }
  });

  if (!adminRes.ok) {
    console.error('Could not verify AAL2 booking admin', { status: adminRes.status });
    return { ok: false, response: jsonResponse({ error: 'Admin permission could not be verified' }, 403) };
  }

  const [adminUser] = await adminRes.json();

  if (!adminUser) {
    return { ok: false, response: jsonResponse({ error: 'Tvåstegsverifierad adminbehörighet krävs.' }, 403) };
  }

  return { ok: true };
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
    if (Number.isFinite(contentLength) && contentLength > 16_384) {
      return jsonResponse({ error: 'För stor begäran.' }, 413);
    }

    let payload: CompleteBookingPayload;
    try {
      payload = await readJsonWithLimit<CompleteBookingPayload>(req, 16_384);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: 'För stor begäran.' }, 413);
      }
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
      }
      throw error;
    }
    const bookingId = Number(payload.bookingId);

    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      return jsonResponse({ error: 'bookingId must be a positive integer' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const contactEmail = Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se';
    const fromEmail = Deno.env.get('BOOKING_FROM_EMAIL');
    const reviewUrl = Deno.env.get('BOOKING_REVIEW_URL') || 'https://g.page/r/CWdR_FURV7DOEBM/review';
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/, '');

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Supabase secrets are missing' }, 500);
    }

    const adminCheck = await requireBookingAdmin(req, supabaseUrl, serviceRoleKey, bookingId);
    if (!adminCheck.ok) {
      return adminCheck.response;
    }

    const bookingRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${bookingId}&select=*`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!bookingRes.ok) {
      const errorText = await bookingRes.text();
      console.error('Could not fetch booking', errorText);
      return jsonResponse({ error: 'Could not fetch booking', details: errorText }, 500);
    }

    const [booking] = await bookingRes.json();

    if (!booking) {
      return jsonResponse({ error: 'Booking not found' }, 404);
    }

    if (!booking.completed_at) {
      return jsonResponse({ error: 'Markera arbetet som utfört innan klartmejlet skickas.' }, 409);
    }

    if (!isValidEmail(booking.email || '')) {
      return jsonResponse({ error: 'Customer email is invalid for completion mail' }, 400);
    }

    if (booking.payment_email_sent) {
      return jsonResponse({
        success: true,
        alreadySent: true,
        bookingId: booking.id,
        paymentMethod: booking.payment_method || 'Swish Företag',
        swishAmount: booking.swish_amount ?? booking.price ?? null,
        swishReference: booking.swish_reference || booking.invoice_reference || `BFP-${booking.id}`,
        actualWorkHours: booking.actual_work_hours ?? null,
        laborCostBeforeRut: booking.labor_cost_before_rut ?? null,
        materialCost: booking.material_cost ?? null,
        transportCost: booking.transport_cost ?? null,
        rutDeduction: booking.rut_deduction ?? null,
        priceBeforeRut: booking.price_before_rut ?? null,
        rutRequestedAmount: booking.rut_requested_amount ?? booking.rut_deduction ?? null,
        discountAmount: booking.discount_amount ?? 0,
        rutDiscountReviewRequired: Number(booking.discount_amount || 0) > 0,
        paymentAlreadyPaid: String(booking.payment_status || '').toLowerCase() === 'paid' || Boolean(booking.paid_at) || Boolean(booking.stripe_paid_at)
      });
    }

    if (!resendApiKey || !fromEmail) {
      return jsonResponse({ error: 'Email secrets are missing' }, 500);
    }

    const paymentMethod = 'Swish Företag';
    const emailSentAt = new Date().toISOString();
    const isAlreadyPaid = String(booking.payment_status || '').toLowerCase() === 'paid'
      || Boolean(booking.paid_at)
      || Boolean(booking.stripe_paid_at);
    const storedSwishAmount = hasOwnValue(booking.swish_amount)
      ? booking.swish_amount as number | string
      : booking.price as number | string | undefined;
    const swishAmountInput = hasOwnValue(payload.swishAmount) ? payload.swishAmount : storedSwishAmount;
    const swishAmountOre = parseMoneyToOre(swishAmountInput);
    const discountAmountOre = parseMoneyToOre(booking.discount_amount as number | string | undefined, true) ?? 0;

    if (swishAmountOre === null || swishAmountOre > MAX_PAYMENT_AMOUNT_ORE) {
      throw new ValidationError('Swishbeloppet måste vara ett fast belopp mellan 0,01 och 1 000 000 kr.');
    }

    if (discountAmountOre > MAX_PAYMENT_AMOUNT_ORE) {
      throw new ValidationError('Bokningens sparade rabatt är ogiltig. Kontrollera bokningen innan mejlet skickas.');
    }

    const invoiceReference = normalizeInvoiceReference(
      hasOwnValue(payload.invoiceReference)
        ? payload.invoiceReference
        : booking.invoice_reference || booking.swish_reference
    );
    const actualWorkHours = parseActualWorkHours(
      hasOwnValue(payload.actualWorkHours) ? payload.actualWorkHours : booking.actual_work_hours as number | string | undefined
    );
    const suppliedMaterialCostOre = parseOptionalMoney(
      hasOwnValue(payload.materialCost) ? payload.materialCost : booking.material_cost as number | string | undefined,
      'Materialkostnaden'
    );
    const suppliedTransportCostOre = parseOptionalMoney(
      hasOwnValue(payload.transportCost) ? payload.transportCost : booking.transport_cost as number | string | undefined,
      'Transportkostnaden'
    );
    const suppliedLaborCostOre = parseOptionalMoney(
      hasOwnValue(payload.laborCostBeforeRut) ? payload.laborCostBeforeRut : booking.labor_cost_before_rut as number | string | undefined,
      'Arbetskostnaden'
    );
    const suppliedRutDeductionOre = parseOptionalMoney(
      hasOwnValue(payload.rutDeduction) ? payload.rutDeduction : booking.rut_deduction as number | string | undefined,
      'RUT-avdraget'
    );
    const materialCostOre = suppliedMaterialCostOre ?? DEFAULT_MATERIAL_COST_ORE;
    const transportCostOre = suppliedTransportCostOre ?? getDefaultTransportCostOre(booking);
    const hasRut = usesRutDeduction(booking);
    let laborCostBeforeRutOre = suppliedLaborCostOre;
    let rutDeductionOre = suppliedRutDeductionOre;

    if (laborCostBeforeRutOre === null && rutDeductionOre === null) {
      const customerLaborShareOre = swishAmountOre - materialCostOre - transportCostOre;
      if (customerLaborShareOre < 0) {
        throw new ValidationError('Swishbeloppet är lägre än material och transport. Kontrollera beloppen innan mejlet skickas.');
      }

      laborCostBeforeRutOre = hasRut ? customerLaborShareOre * 2 : customerLaborShareOre;
      rutDeductionOre = hasRut ? customerLaborShareOre : 0;
    } else if (laborCostBeforeRutOre === null) {
      laborCostBeforeRutOre = swishAmountOre - materialCostOre - transportCostOre + (rutDeductionOre || 0);
    } else if (rutDeductionOre === null) {
      rutDeductionOre = laborCostBeforeRutOre + materialCostOre + transportCostOre - swishAmountOre;
    }

    if (laborCostBeforeRutOre === null || rutDeductionOre === null) {
      throw new ValidationError('Det gick inte att räkna fram ett komplett betalningsunderlag.');
    }

    if (laborCostBeforeRutOre < 0 || rutDeductionOre < 0) {
      throw new ValidationError('Arbetskostnad, RUT, material och transport ger inte ett giltigt Swishbelopp.');
    }

    if (!hasRut && rutDeductionOre > 0) {
      throw new ValidationError('Bokningen är markerad utan RUT men ett RUT-avdrag har angetts.');
    }

    if (rutDeductionOre > Math.floor(laborCostBeforeRutOre / 2)) {
      throw new ValidationError('RUT-avdraget får inte vara större än 50 procent av arbetskostnaden.');
    }

    const calculatedSwishAmountOre = laborCostBeforeRutOre + materialCostOre + transportCostOre - rutDeductionOre;
    if (Math.abs(calculatedSwishAmountOre - swishAmountOre) > 100) {
      throw new ValidationError(`Beloppen stämmer inte. Arbete efter rabatt + material + transport - RUT blir ${formatSekFromOre(calculatedSwishAmountOre)}, men Swishbeloppet är ${formatSekFromOre(swishAmountOre)}.`);
    }

    if (rutDeductionOre > 0 && actualWorkHours === null) {
      throw new ValidationError('Ange faktisk arbetstid innan klartmejlet skickas. Den behövs för den manuella RUT-ansökan.');
    }

    const swishUrl = buildSwishUrl(swishAmountOre, invoiceReference);

    const logoUrl = `${siteUrl}/logga-fonsterputs-transparent.png`;
    const safeLogoUrl = escapeHtml(logoUrl);
    const safeContactEmail = escapeHtml(contactEmail);
    const safeReviewUrl = escapeHtml(reviewUrl);
    const safeSwishUrl = escapeHtml(swishUrl);
    const safeInvoiceReference = escapeHtml(invoiceReference);
    const priceBeforeRutOre = laborCostBeforeRutOre + materialCostOre + transportCostOre;
    const priceBeforeRutDisplay = formatSekFromOre(priceBeforeRutOre);
    const rutDeductionDisplay = `-${formatSekFromOre(rutDeductionOre)}`;
    const priceAfterRutDisplay = formatSekFromOre(swishAmountOre);
    const windowWorkItem = /^\d+$/.test(String(booking.window_count || '').trim())
      ? `${String(booking.window_count).trim()} glaspartier`
      : booking.window_count;
    const detailRows = [
      buildDetailRow('Datum', booking.booking_date),
      buildDetailRow('Tid', booking.booking_time),
      buildDetailRow('Adress', booking.address),
      buildDetailRow('Tjänst', booking.service_scope),
      buildDetailRow('Typ av bostad', booking.housing_type),
      ...(booking.transport_type ? [buildDetailRow('Transport', booking.transport_type)] : []),
      ...(booking.sea_miles ? [buildDetailRow('Sjömil', booking.sea_miles)] : []),
      ...(booking.coordinates ? [buildDetailRow('Koordinater', booking.coordinates)] : []),
      ...(actualWorkHours !== null ? [buildDetailRow('Faktisk arbetstid', `${actualWorkHours.toLocaleString('sv-SE')} timmar`)] : [])
    ].join('');
    const workRows = [
      windowWorkItem,
      ...splitAddons(booking.addons)
    ].map(buildWorkRow).join('');
    const priceRows = `
        <tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Arbetskostnad före RUT${discountAmountOre > 0 ? ' (efter rabatt)' : ''}</td>
          <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${formatSekFromOre(laborCostBeforeRutOre)}</td>
        </tr>
        <tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Material (ej RUT)</td>
          <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${formatSekFromOre(materialCostOre)}</td>
        </tr>
        ${transportCostOre > 0 ? `<tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">Transport (ej RUT)</td>
          <td align="right" style="padding: 9px 0; color: #0f2638; font-size: 15px; font-weight: 700;">${formatSekFromOre(transportCostOre)}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 9px 0; border-top: 1px solid #d7e7dd; color: #5b6b7a; font-size: 14px;">Summa före RUT</td>
          <td align="right" style="padding: 9px 0; border-top: 1px solid #d7e7dd; color: #0f2638; font-size: 15px; font-weight: 700;">${priceBeforeRutDisplay}</td>
        </tr>
        ${rutDeductionOre > 0 ? `<tr>
          <td style="padding: 9px 0; color: #5b6b7a; font-size: 14px;">RUT-avdrag (50%)</td>
          <td align="right" style="padding: 9px 0; color: #287a45; font-size: 15px; font-weight: 700;">${rutDeductionDisplay}</td>
        </tr>` : ''}
        ${discountAmountOre > 0 ? `<tr>
          <td colspan="2" style="padding: 10px 0 4px; color: #5b6b7a; font-size: 12px; line-height: 1.5;">Din rabatt på ${formatSekFromOre(discountAmountOre)} är redan inräknad i arbetskostnaden och RUT-beloppet ovan.</td>
        </tr>` : ''}
      `;
    const swishPaymentSection = isAlreadyPaid
      ? `
        <p style="margin: 0; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Betalningen är redan registrerad som mottagen. Tack!</p>
      `
      : `
        <p style="margin: 0 0 14px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Swisha exakt <strong style="color: #ffffff;">${priceAfterRutDisplay}</strong> till företagsnumret nedan. Knappen öppnar Swish med belopp och referens ifyllt på mobilen.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
          <tr>
            <td align="center" style="background: #ffffff; border-radius: 999px;">
              <a href="${safeSwishUrl}" style="display: block; padding: 14px 20px; color: #0f2638; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">SWISHA ${priceAfterRutDisplay}</a>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 16px; border-collapse: collapse; background: #ffffff; border-radius: 12px;">
          <tr>
            <td style="padding: 16px; color: #0f2638; font-size: 14px; line-height: 1.8;">
              <strong>Swish:</strong> ${SWISH_NUMBER_DISPLAY}<br>
              <strong>Mottagare:</strong> ${SWISH_RECIPIENT_NAME}<br>
              <strong>Belopp:</strong> ${priceAfterRutDisplay}<br>
              <strong>Meddelande:</strong> ${safeInvoiceReference}
            </td>
          </tr>
        </table>
        <p style="margin: 14px 0 0; color: #d8e1e8; font-size: 12px; line-height: 1.6;">Kontrollera alltid att <strong style="color: #ffffff;">${SWISH_RECIPIENT_NAME}</strong> visas som mottagare innan du godkänner betalningen. Om knappen inte fungerar kan du skriva in uppgifterna ovan manuellt.</p>
      `;
    const reviewSection = reviewUrl
      ? `
        <tr>
          <td style="background: #ffffff; padding: 18px 42px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #fff8ec; border: 1px solid #ffd08b; border-radius: 14px;">
              <tr>
                <td style="padding: 20px;">
                  <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Hjälp oss växa</h2>
                  <p style="margin: 0 0 14px; color: #536574; font-size: 14px; line-height: 1.7;">Om du är nöjd skulle vi bli otroligt glada om du lämnar en recension.</p>
                  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse; width: 100%;">
                    <tr>
                      <td align="center" style="background: #ffac37; border-radius: 999px;">
                        <a href="${safeReviewUrl}" style="display: block; padding: 14px 20px; color: #18364b; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-decoration: none;">LÄMNA RECENSION</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `
      : '';

    const emailHtml = `
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
                    <h1 style="margin: 0 0 12px; color: #0f2638; font-size: 34px; line-height: 1.16; font-weight: 800;">Tack! Fönsterputsningen är klar</h1>
                    <p style="margin: 0 0 8px; color: #173042; font-size: 17px; line-height: 1.6;">Hej ${escapeHtml(booking.customer_name || '')},</p>
                    <p style="margin: 0; color: #536574; font-size: 15px; line-height: 1.7;">Vi har nu slutfört arbetet och hoppas att du är riktigt nöjd med resultatet.</p>
                  </td>
                </tr>
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                      <tr>
                        <td style="padding: 22px; background: #0f2638; border-radius: 14px;">
                          <h2 style="margin: 0 0 10px; color: #ffffff; font-size: 20px;">Betala med Swish</h2>
                          <p style="margin: 0 0 16px; color: #d8e1e8; font-size: 14px; line-height: 1.7;">Fönsterputsningen är klar och betalningsuppgifterna finns direkt i detta mejl.</p>
                          ${swishPaymentSection}
                          ${!isAlreadyPaid ? '<p style="margin: 14px 0 0; color: #d8e1e8; font-size: 13px; line-height: 1.6;">Betala enligt fakturans villkor.</p>' : ''}
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
                          <h2 style="margin: 0 0 14px; color: #0f2638; font-size: 18px; line-height: 1.3;">Betalningsöversikt</h2>
                          ${priceRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${priceRows}</table>` : ''}
                          ${priceAfterRutDisplay ? `
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 12px; border-collapse: collapse; background: #247a43; border-radius: 12px;">
                            <tr>
                              <td style="padding: 18px 18px; color: #ffffff; font-size: 15px; font-weight: 700;">${isAlreadyPaid ? 'Betalt' : 'Att betala'}</td>
                              <td align="right" style="padding: 18px 18px; color: #ffffff; font-size: 26px; line-height: 1.1; font-weight: 800;">${priceAfterRutDisplay}</td>
                            </tr>
                          </table>
                          ` : ''}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${detailRows || workRows ? `
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px 20px 6px;">
                          <h2 style="margin: 0 0 6px; color: #0f2638; font-size: 18px; line-height: 1.3;">Jobbdetaljer</h2>
                          ${detailRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${detailRows}</table>` : ''}
                          ${workRows ? `
                            <h3 style="margin: 18px 0 8px; color: #0f2638; font-size: 15px; line-height: 1.3;">Utfört arbete</h3>
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">${workRows}</table>
                          ` : ''}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}
                ${reviewSection}
                <tr>
                  <td style="background: #ffffff; padding: 18px 42px 34px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f8fafb; border: 1px solid #e6edf3; border-radius: 14px;">
                      <tr>
                        <td style="padding: 20px;">
                          <h2 style="margin: 0 0 10px; color: #0f2638; font-size: 18px;">Frågor?</h2>
                          <p style="margin: 0 0 12px; color: #536574; font-size: 14px; line-height: 1.7;">Svara direkt på detta mail om du har frågor eller funderingar.</p>
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
    const emailText = [
      `Hej ${String(booking.customer_name || '').trim()},`,
      '',
      'Fönsterputsningen är klar. Tack för att du valde Berga Fönsterputs!',
      '',
      ...(isAlreadyPaid ? [
        'Betalningen är redan registrerad som mottagen. Tack!'
      ] : [
        `Swisha exakt ${formatSekFromOre(swishAmountOre)} till ${SWISH_NUMBER_DISPLAY}.`,
        `Mottagare: ${SWISH_RECIPIENT_NAME}`,
        `Meddelande: ${invoiceReference}`,
        `Öppna Swish: ${swishUrl}`,
        'Kontrollera att Zac Hallgren visas som mottagare innan du godkänner betalningen.',
        'Betala enligt fakturans villkor.'
      ]),
      '',
      `Arbetskostnad före RUT${discountAmountOre > 0 ? ' (efter rabatt)' : ''}: ${formatSekFromOre(laborCostBeforeRutOre)}`,
      ...(rutDeductionOre > 0 ? [`RUT-avdrag: -${formatSekFromOre(rutDeductionOre)}`] : []),
      `Material: ${formatSekFromOre(materialCostOre)}`,
      ...(transportCostOre > 0 ? [`Transport: ${formatSekFromOre(transportCostOre)}`] : []),
      ...(discountAmountOre > 0 ? [`Rabatten på ${formatSekFromOre(discountAmountOre)} är redan inräknad i arbetskostnaden och RUT-beloppet.`] : []),
      `${isAlreadyPaid ? 'Betalt' : 'Att betala'}: ${formatSekFromOre(swishAmountOre)}`,
      '',
      `Frågor? Svara på mejlet eller kontakta ${contactEmail}.`
    ].join('\n');
    const idempotencyReference = invoiceReference.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 35);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `complete-booking-swish-${booking.id}-${swishAmountOre}-${idempotencyReference}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [booking.email.trim()],
        subject: `Fönsterputsningen är klar - ${booking.customer_name || 'Berga Fönsterputs'}`,
        html: emailHtml,
        text: emailText,
        reply_to: contactEmail
      })
    });

    if (!emailRes.ok) {
      const errorText = await emailRes.text();
      console.error('Completion email failed', errorText);
      return jsonResponse({ error: 'Completion email failed', details: errorText }, 502);
    }

    const completionUpdateRes = await fetch(`${supabaseUrl}/rest/v1/bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        payment_method: paymentMethod,
        payment_provider: 'swish',
        payment_email_sent: true,
        payment_email_sent_at: emailSentAt,
        swish_amount: swishAmountOre / 100,
        invoice_reference: invoiceReference,
        actual_work_hours: actualWorkHours,
        labor_cost_before_rut: laborCostBeforeRutOre / 100,
        material_cost: materialCostOre / 100,
        transport_cost: transportCostOre / 100,
        rut_deduction: rutDeductionOre / 100,
        price_before_rut: priceBeforeRutOre / 100,
        rut_requested_amount: rutDeductionOre / 100,
        swish_reference: invoiceReference,
        swish_sent_at: emailSentAt
      })
    });

    if (!completionUpdateRes.ok) {
      const errorText = await completionUpdateRes.text();
      console.error('Completion email sent, but payment details could not be saved', errorText);
      return jsonResponse({ error: 'Klartmejlet skickades, men betalningsuppgifterna kunde inte sparas. Skicka inte mejlet igen innan bokningen har kontrollerats.', details: errorText }, 500);
    }

    return jsonResponse({
      success: true,
      alreadySent: false,
      bookingId: booking.id,
      paymentMethod,
      swishNumber: SWISH_NUMBER_DISPLAY,
      swishRecipientName: SWISH_RECIPIENT_NAME,
      swishAmount: swishAmountOre / 100,
      swishReference: invoiceReference,
      actualWorkHours,
      laborCostBeforeRut: laborCostBeforeRutOre / 100,
      materialCost: materialCostOre / 100,
      transportCost: transportCostOre / 100,
      rutDeduction: rutDeductionOre / 100,
      priceBeforeRut: priceBeforeRutOre / 100,
      rutRequestedAmount: rutDeductionOre / 100,
      discountAmount: discountAmountOre / 100,
      rutDiscountReviewRequired: discountAmountOre > 0,
      paymentAlreadyPaid: isAlreadyPaid
    });
  } catch (error) {
    console.error('Unhandled complete-booking error', error);
    const status = error instanceof ValidationError ? 400 : 500;
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, status);
  }
});
