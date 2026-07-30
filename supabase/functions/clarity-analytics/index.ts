import { buildClarityReport } from '../_shared/clarity-analysis.ts';
import { selectMissingImportGroups } from '../_shared/clarity-cache.ts';
import { fetchClarityInsights } from '../_shared/clarity-client.ts';
import { ClarityClientError, type ClarityDimension, type ClaritySnapshot } from '../_shared/clarity-types.ts';
import {
  InvalidJsonBodyError,
  readJsonWithLimit,
  RequestBodyTooLargeError
} from '../_shared/read-json.ts';

const ALLOWED_ORIGIN = 'https://bergafonsterputs.se';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 270;
const IMPORT_GROUPS: ClarityDimension[][] = [
  ['Source', 'Medium', 'Campaign'],
  ['Device', 'OS', 'Browser'],
  ['URL', 'Country/Region']
];

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin'
};

const responseHeaders = {
  ...corsHeaders,
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

type Action = 'report' | 'refresh' | 'test' | 'scheduled-import';
type RequestPayload = { action?: Action; start?: string; end?: string };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function requiredEnvironment() {
  const values = {
    supabaseUrl: (Deno.env.get('SUPABASE_URL') || '').trim(),
    serviceRoleKey: (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim(),
    clarityToken: (Deno.env.get('CLARITY_API_TOKEN') || '').trim(),
    clarityProjectId: (Deno.env.get('CLARITY_PROJECT_ID') || '').trim(),
    clarityBaseUrl: (Deno.env.get('CLARITY_API_BASE_URL') || 'https://www.clarity.ms/export-data/api/v1').trim(),
    cronSecret: (Deno.env.get('CLARITY_CRON_SECRET') || '').trim(),
    mockMode: (Deno.env.get('CLARITY_MOCK_MODE') || '').trim() === 'true',
    environment: (Deno.env.get('CLARITY_ENVIRONMENT') || 'production').trim().toLowerCase()
  };
  if (!values.supabaseUrl || !values.serviceRoleKey) throw new Error('Supabase server configuration is missing');
  return values;
}

function isSafeMock(config: ReturnType<typeof requiredEnvironment>) {
  return config.mockMode && !['production', 'prod'].includes(config.environment);
}

function analyticsProjectId(config: ReturnType<typeof requiredEnvironment>) {
  return isSafeMock(config) ? 'mock-testdata' : config.clarityProjectId;
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

async function requireAdmin(req: Request, supabaseUrl: string, serviceRoleKey: string) {
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ') || getJwtAssuranceLevel(authHeader) !== 'aal2') return false;
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey;

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: publicKey, Authorization: authHeader }
  });
  if (!userResponse.ok) return false;

  const adminResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/is_clarity_analytics_admin`, {
    method: 'POST',
    headers: {
      apikey: publicKey,
      Authorization: authHeader,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  if (!adminResponse.ok) return false;
  return await adminResponse.json() === true;
}

function stockholmDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, hour: Number(pick('hour')) };
}

function parseDate(value: unknown) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function defaultRange() {
  const end = stockholmDateParts().date;
  const startDate = new Date(`${end}T12:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end };
}

function validateRange(startValue: unknown, endValue: unknown) {
  const defaults = defaultRange();
  const start = parseDate(startValue) || defaults.start;
  const end = parseDate(endValue) || defaults.end;
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) return null;
  return { start, end, days };
}

async function serviceRequest(config: ReturnType<typeof requiredEnvironment>, path: string, init: RequestInit = {}) {
  return await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function reserveCalls(config: ReturnType<typeof requiredEnvironment>, count: number) {
  const response = await serviceRequest(config, 'rpc/reserve_clarity_api_calls', {
    method: 'POST',
    body: JSON.stringify({ p_call_count: count })
  });
  return response.ok && await response.json() === true;
}

async function reserveOneCall(config: ReturnType<typeof requiredEnvironment>) {
  if (!await reserveCalls(config, 1)) {
    throw new ClarityClientError('RATE_LIMITED', 'Den lokala säkerhetsbudgeten för Clarity-anrop är nådd.');
  }
}

async function latestSnapshots(config: ReturnType<typeof requiredEnvironment>, snapshotDate?: string) {
  const query = new URLSearchParams({
    select: 'id,snapshot_date,period_start,period_end,fetched_at,project_id,dimensions,metrics,schema_version',
    project_id: `eq.${analyticsProjectId(config)}`,
    order: 'fetched_at.desc',
    limit: '12'
  });
  if (snapshotDate) query.set('snapshot_date', `eq.${snapshotDate}`);
  const response = await serviceRequest(config, `clarity_analytics_snapshots?${query}`);
  if (!response.ok) throw new Error('Snapshot cache could not be read');
  return await response.json() as ClaritySnapshot[];
}

async function saveSnapshot(config: ReturnType<typeof requiredEnvironment>, result: Awaited<ReturnType<typeof fetchClarityInsights>>) {
  const snapshotDate = stockholmDateParts(new Date(result.fetchedAt)).date;
  const dimensionKey = result.dimensions.join('|');
  const response = await serviceRequest(config, 'clarity_analytics_snapshots?on_conflict=snapshot_date,project_id,dimension_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      snapshot_date: snapshotDate,
      period_start: result.periodStart,
      period_end: result.periodEnd,
      fetched_at: result.fetchedAt,
      project_id: analyticsProjectId(config),
      dimension_key: dimensionKey,
      dimensions: result.dimensions,
      metrics: result.metrics,
      row_count: result.rowCount,
      schema_version: 1
    })
  });
  if (!response.ok) throw new Error('Snapshot could not be saved');
}

async function importSnapshots(config: ReturnType<typeof requiredEnvironment>, force: boolean) {
  const mock = isSafeMock(config);
  if ((!config.clarityToken || !config.clarityProjectId) && !mock) {
    throw new ClarityClientError('CONFIGURATION', 'Clarity-integrationen är inte konfigurerad.');
  }

  const today = stockholmDateParts().date;
  const cached = await latestSnapshots(config, today);
  const groups = force
    ? IMPORT_GROUPS
    : selectMissingImportGroups(cached, IMPORT_GROUPS, Date.now(), CACHE_TTL_MS);
  if (!groups.length) return { source: 'cache', fetched: 0, snapshots: cached.length };
  let totalRows = 0;
  for (const dimensions of groups) {
    const result = mock ? mockResult(dimensions) : await fetchClarityInsights({
        token: config.clarityToken,
        projectId: config.clarityProjectId,
        baseUrl: config.clarityBaseUrl,
        beforeRequest: () => reserveOneCall(config)
      }, { numOfDays: 1, dimensions });
    await saveSnapshot(config, result);
    totalRows += result.rowCount;
  }
  return { source: mock ? 'mock' : 'api', fetched: groups.length, rows: totalRows };
}

function mockResult(dimensions: ClarityDimension[]) {
  const end = new Date();
  const rows = dimensions.includes('Device')
    ? [
        { Device: 'Mobile', OS: 'iOS', Browser: 'Safari', totalSessionCount: '18', distinctUserCount: '15' },
        { Device: 'Desktop', OS: 'Windows', Browser: 'Chrome', totalSessionCount: '12', distinctUserCount: '10' }
      ]
    : dimensions.includes('Source')
    ? [
        { Source: 'facebook', Medium: 'paid_social', Campaign: 'test_campaign', totalSessionCount: '14' },
        { Source: 'google', Medium: 'organic', Campaign: '', totalSessionCount: '16' }
      ]
    : [{ URL: '/bokning.html', 'Country/Region': 'Sweden', totalSessionCount: '30' }];
  return {
    metrics: [{ metricName: 'Traffic', information: rows }],
    rowCount: rows.length,
    fetchedAt: end.toISOString(),
    periodStart: new Date(end.getTime() - 86_400_000).toISOString(),
    periodEnd: end.toISOString(),
    dimensions
  };
}

async function report(config: ReturnType<typeof requiredEnvironment>, range: { start: string; end: string }) {
  const query = new URLSearchParams({
    select: 'id,period_start,period_end,fetched_at,project_id,dimensions,metrics,schema_version',
    project_id: `eq.${analyticsProjectId(config)}`,
    snapshot_date: `gte.${range.start}`,
    order: 'fetched_at.asc'
  });
  query.append('snapshot_date', `lte.${range.end}`);
  const response = await serviceRequest(config, `clarity_analytics_snapshots?${query}`);
  if (!response.ok) throw new Error('Analytics report could not be read');
  return buildClarityReport(await response.json() as ClaritySnapshot[], range.start, range.end);
}

function safeClientError(error: ClarityClientError) {
  const status = error.code === 'UNAUTHORIZED' ? 502
    : error.code === 'FORBIDDEN' ? 502
    : error.code === 'RATE_LIMITED' ? 429
    : error.code === 'CONFIGURATION' ? 503
    : error.code === 'BAD_REQUEST' ? 400
    : 502;
  return jsonResponse({ error: error.message, code: error.code, retryAfterSeconds: error.retryAfterSeconds || null }, status);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: responseHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (req.headers.get('origin') && req.headers.get('origin') !== ALLOWED_ORIGIN) return jsonResponse({ error: 'Origin not allowed' }, 403);

  try {
    const payload = await readJsonWithLimit<RequestPayload>(req, 4096);
    const action = payload.action || 'report';
    if (!['report', 'refresh', 'test', 'scheduled-import'].includes(action)) return jsonResponse({ error: 'Ogiltig åtgärd.' }, 400);
    const config = requiredEnvironment();

    if (action === 'scheduled-import') {
      const supplied = req.headers.get('x-clarity-cron-secret') || '';
      if (!config.cronSecret || supplied !== config.cronSecret) return jsonResponse({ error: 'Forbidden' }, 403);
      const localTime = stockholmDateParts();
      if (localTime.hour !== 2) return jsonResponse({ ok: true, skipped: true, reason: 'outside_stockholm_schedule' });
      return jsonResponse({ ok: true, import: await importSnapshots(config, false) });
    }

    if (!await requireAdmin(req, config.supabaseUrl, config.serviceRoleKey)) {
      return jsonResponse({ error: 'Tvåstegsverifierad adminbehörighet krävs.' }, 403);
    }

    if (action === 'test') {
      const mock = isSafeMock(config);
      if ((!config.clarityToken || !config.clarityProjectId) && !mock) {
        throw new ClarityClientError('CONFIGURATION', 'Clarity-integrationen är inte konfigurerad.');
      }
      const result = mock ? mockResult(['Device']) : await fetchClarityInsights({
        token: config.clarityToken,
        projectId: config.clarityProjectId,
        baseUrl: config.clarityBaseUrl,
        beforeRequest: () => reserveOneCall(config)
      }, { numOfDays: 1, dimensions: ['Device'] });
      return jsonResponse({
        ok: true,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        rowCount: result.rowCount,
        metricCount: result.metrics.length,
        tokenExposed: false,
        testData: mock
      });
    }

    if (action === 'refresh') await importSnapshots(config, false);
    const range = validateRange(payload.start, payload.end);
    if (!range) return jsonResponse({ error: 'Datumintervallet måste vara 1–270 dagar.' }, 400);
    return jsonResponse({ ok: true, report: await report(config, range), testData: isSafeMock(config) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return jsonResponse({ error: 'För stor begäran.' }, 413);
    if (error instanceof InvalidJsonBodyError) return jsonResponse({ error: 'Begäran innehåller inte giltig JSON.' }, 400);
    if (error instanceof ClarityClientError) return safeClientError(error);
    console.error('Clarity analytics request failed', { type: error instanceof Error ? error.name : 'unknown' });
    return jsonResponse({ error: 'Analysdata kunde inte hämtas.' }, 500);
  }
});
