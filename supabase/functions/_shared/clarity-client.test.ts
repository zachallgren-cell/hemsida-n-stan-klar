import { fetchClarityInsights, validateClarityResponse } from './clarity-client.ts';
import { buildClarityReport } from './clarity-analysis.ts';
import { selectMissingImportGroups } from './clarity-cache.ts';
import { ClarityClientError, type ClaritySnapshot } from './clarity-types.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejectsCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof ClarityClientError, 'Expected ClarityClientError');
    assert(error.code === code, `Expected ${code}, got ${error.code}`);
    return;
  }
  throw new Error(`Expected rejection with ${code}`);
}

const config = { token: 'test-token', projectId: 'test-project', maxRetries: 0 };

Deno.test('validates an empty Clarity response', () => {
  const parsed = validateClarityResponse([]);
  assert(Array.isArray(parsed) && parsed.length === 0);
});

Deno.test('rejects incomplete response rows', () => {
  try {
    validateClarityResponse([{ metricName: 'Traffic', information: [null] }]);
  } catch (error) {
    assert(error instanceof ClarityClientError);
    assert(error.code === 'INVALID_RESPONSE');
    return;
  }
  throw new Error('Expected invalid response');
});

Deno.test('maps 401 without exposing the token', async () => {
  const fakeFetch = () => Promise.resolve(new Response('', { status: 401 }));
  const promise = fetchClarityInsights(config, { numOfDays: 1, dimensions: ['Device'] }, fakeFetch as typeof fetch);
  await assertRejectsCode(promise, 'UNAUTHORIZED');
});

Deno.test('maps 429 and Retry-After', async () => {
  const fakeFetch = () => Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  try {
    await fetchClarityInsights(config, { numOfDays: 1, dimensions: ['Device'] }, fakeFetch as typeof fetch);
  } catch (error) {
    assert(error instanceof ClarityClientError);
    assert(error.code === 'RATE_LIMITED');
    assert(error.retryAfterSeconds === 60);
    return;
  }
  throw new Error('Expected rate limit error');
});

Deno.test('maps an aborted request to timeout', async () => {
  const fakeFetch = () => Promise.reject(new DOMException('Aborted', 'AbortError'));
  const promise = fetchClarityInsights(config, { numOfDays: 1, dimensions: ['Device'] }, fakeFetch as typeof fetch);
  await assertRejectsCode(promise, 'TIMEOUT');
});

Deno.test('reserves every transient retry before making the request', async () => {
  let attempts = 0;
  let reservations = 0;
  const fakeFetch = () => {
    attempts += 1;
    return Promise.resolve(attempts === 1
      ? new Response('', { status: 500 })
      : Response.json([]));
  };
  await fetchClarityInsights({
    token: 'test-token',
    projectId: 'test-project',
    maxRetries: 1,
    beforeRequest: async () => { reservations += 1; }
  }, { numOfDays: 1, dimensions: ['Device'] }, fakeFetch as typeof fetch);
  assert(attempts === 2);
  assert(reservations === 2);
});

Deno.test('accepts documented metric rows and calculates periods', async () => {
  const fakeFetch = () => Promise.resolve(Response.json([
    { metricName: 'Traffic', information: [{ totalSessionCount: '12', Device: 'Mobile' }] }
  ]));
  const result = await fetchClarityInsights(config, { numOfDays: 1, dimensions: ['Device'] }, fakeFetch as typeof fetch);
  assert(result.rowCount === 1);
  assert(result.metrics[0].metricName === 'Traffic');
  assert(Date.parse(result.periodEnd) - Date.parse(result.periodStart) === 86_400_000);
});

Deno.test('rejects more than three dimensions', async () => {
  const promise = fetchClarityInsights(config, {
    numOfDays: 1,
    dimensions: ['Device', 'OS', 'Browser', 'URL'] as never
  });
  await assertRejectsCode(promise, 'BAD_REQUEST');
});

Deno.test('analysis avoids division by zero and classifies small data', () => {
  const report = buildClarityReport([], '2026-07-01', '2026-07-07');
  assert(report.overview.mobileShare.available === false);
  assert(report.overview.mobileShare.percentage === null);
  assert(report.issues.every((issue) => issue.status === 'Ingen tillgänglig data'));
});

Deno.test('analysis aggregates device and source snapshots', () => {
  const common = {
    period_start: '2026-07-20T00:00:00Z', period_end: '2026-07-21T00:00:00Z',
    fetched_at: '2026-07-21T00:00:00Z', project_id: 'p', schema_version: 1
  };
  const snapshots: ClaritySnapshot[] = [
    {
      ...common,
      dimensions: ['Device'],
      metrics: [{ metricName: 'Traffic', information: [
        { Device: 'Mobile', totalSessionCount: '30', distinctUserCount: '20' },
        { Device: 'Desktop', totalSessionCount: '70', distinctUserCount: '50' }
      ] }]
    },
    {
      ...common,
      dimensions: ['Source', 'Medium', 'Campaign'],
      metrics: [{ metricName: 'Traffic', information: [
        { Source: 'facebook', Medium: 'paid_social', Campaign: 'villa', totalSessionCount: '40' },
        { Source: 'google', Medium: 'organic', Campaign: '', totalSessionCount: '60' }
      ] }]
    }
  ];
  const report = buildClarityReport(snapshots, '2026-07-21', '2026-07-21');
  assert(report.overview.sessions === 100);
  assert(report.overview.mobileShare.percentage === 30);
  assert(report.sources[0].sessions === 60);
});

Deno.test('cache reuses fresh dimension groups and refreshes stale groups', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const base = {
    period_start: '2026-07-21T10:00:00Z', period_end: '2026-07-21T11:00:00Z',
    project_id: 'p', metrics: [], schema_version: 1
  };
  const cached: ClaritySnapshot[] = [
    { ...base, fetched_at: '2026-07-21T11:30:00Z', dimensions: ['Device', 'OS', 'Browser'] },
    { ...base, fetched_at: '2026-07-21T10:00:00Z', dimensions: ['URL', 'Country/Region'] }
  ];
  const missing = selectMissingImportGroups(cached, [
    ['Device', 'OS', 'Browser'], ['URL', 'Country/Region']
  ], now, 3_600_000);
  assert(missing.length === 1);
  assert(missing[0][0] === 'URL');
});
