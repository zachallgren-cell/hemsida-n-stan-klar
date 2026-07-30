import {
  CLARITY_DIMENSIONS,
  ClarityClientError,
  type ClarityDimension,
  type ClarityFetchResult,
  type ClarityInformationRow,
  type ClarityMetric
} from './clarity-types.ts';

export const DEFAULT_CLARITY_API_BASE_URL = 'https://www.clarity.ms/export-data/api/v1';
const INSIGHTS_PATH = '/project-live-insights';
const MAX_RESPONSE_BYTES = 5_000_000;

export type ClarityClientConfig = {
  token: string;
  projectId: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  beforeRequest?: () => Promise<void>;
};

type FetchLike = typeof fetch;

function cleanConfig(config: ClarityClientConfig) {
  const token = config.token.trim();
  const projectId = config.projectId.trim();
  const baseUrl = (config.baseUrl || DEFAULT_CLARITY_API_BASE_URL).trim().replace(/\/$/, '');

  if (!token) throw new ClarityClientError('CONFIGURATION', 'CLARITY_API_TOKEN saknas.');
  if (!projectId) throw new ClarityClientError('CONFIGURATION', 'CLARITY_PROJECT_ID saknas.');

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ClarityClientError('CONFIGURATION', 'CLARITY_API_BASE_URL är ogiltig.');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.clarity.ms' || parsed.pathname !== '/export-data/api/v1') {
    throw new ClarityClientError('CONFIGURATION', 'CLARITY_API_BASE_URL måste vara Microsofts officiella Data Export API.');
  }

  return {
    token,
    projectId,
    baseUrl,
    timeoutMs: Math.min(Math.max(config.timeoutMs ?? 10_000, 1_000), 30_000),
    maxRetries: Math.min(Math.max(config.maxRetries ?? 2, 0), 3),
    beforeRequest: config.beforeRequest
  };
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function validateClarityResponse(value: unknown): ClarityMetric[] {
  if (!Array.isArray(value)) {
    throw new ClarityClientError('INVALID_RESPONSE', 'Clarity returnerade inte en lista med mätvärden.');
  }

  return value.map((entry, metricIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ClarityClientError('INVALID_RESPONSE', `Clarity-mätvärde ${metricIndex + 1} är ogiltigt.`);
    }

    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.metricName !== 'string' || !candidate.metricName.trim() || !Array.isArray(candidate.information)) {
      throw new ClarityClientError('INVALID_RESPONSE', `Clarity-mätvärde ${metricIndex + 1} saknar dokumenterade fält.`);
    }

    const information = candidate.information.map((row, rowIndex) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new ClarityClientError('INVALID_RESPONSE', `Clarity-rad ${rowIndex + 1} är ogiltig.`);
      }

      const safeRow: ClarityInformationRow = {};
      for (const [key, rowValue] of Object.entries(row)) {
        if (!key || key.length > 120 || !isPrimitive(rowValue)) {
          throw new ClarityClientError('INVALID_RESPONSE', 'Clarity-svaret innehåller ett oväntat eller komplext fält.');
        }
        safeRow[key] = rowValue;
      }
      return safeRow;
    });

    return { metricName: candidate.metricName.trim().slice(0, 160), information };
  });
}

function parseRetryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapStatus(status: number, retryAfter?: number) {
  if (status === 400) return new ClarityClientError('BAD_REQUEST', 'Clarity avvisade parametrarna.', status);
  if (status === 401) return new ClarityClientError('UNAUTHORIZED', 'Clarity-tokenen är ogiltig eller har gått ut.', status);
  if (status === 403) return new ClarityClientError('FORBIDDEN', 'Clarity-tokenen saknar behörighet.', status);
  if (status === 429) return new ClarityClientError('RATE_LIMITED', 'Claritys dagliga anropsgräns är nådd.', status, retryAfter);
  return new ClarityClientError('UPSTREAM', 'Clarity-tjänsten är tillfälligt otillgänglig.', status);
}

export async function fetchClarityInsights(
  rawConfig: ClarityClientConfig,
  options: { numOfDays: 1 | 2 | 3; dimensions: ClarityDimension[] },
  fetchImpl: FetchLike = fetch
): Promise<ClarityFetchResult> {
  const config = cleanConfig(rawConfig);
  if (![1, 2, 3].includes(options.numOfDays)) {
    throw new ClarityClientError('BAD_REQUEST', 'numOfDays måste vara 1, 2 eller 3.');
  }
  if (options.dimensions.length > 3 || new Set(options.dimensions).size !== options.dimensions.length) {
    throw new ClarityClientError('BAD_REQUEST', 'Högst tre unika dimensioner får skickas.');
  }
  for (const dimension of options.dimensions) {
    if (!(CLARITY_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new ClarityClientError('BAD_REQUEST', `Dimensionen ${dimension} stöds inte.`);
    }
  }

  const url = new URL(`${config.baseUrl}${INSIGHTS_PATH}`);
  url.searchParams.set('numOfDays', String(options.numOfDays));
  options.dimensions.forEach((dimension, index) => url.searchParams.set(`dimension${index + 1}`, dimension));

  let lastError: ClarityClientError | null = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    await config.beforeRequest?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const mapped = mapStatus(response.status, retryAfter);
        const retryable = response.status >= 500 && attempt < config.maxRetries;
        if (!retryable) throw mapped;
        lastError = mapped;
        await wait(250 * (2 ** attempt) + Math.floor(Math.random() * 100));
        continue;
      }

      const contentLength = Number(response.headers.get('content-length') || '0');
      if (contentLength > MAX_RESPONSE_BYTES) {
        throw new ClarityClientError('INVALID_RESPONSE', 'Clarity-svaret är större än tillåtet.');
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new ClarityClientError('INVALID_RESPONSE', 'Clarity-svaret är större än tillåtet.');
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(text || '[]');
      } catch {
        throw new ClarityClientError('INVALID_RESPONSE', 'Clarity returnerade ogiltig JSON.');
      }

      const metrics = validateClarityResponse(decoded);
      const fetchedAt = new Date();
      return {
        metrics,
        rowCount: metrics.reduce((sum, metric) => sum + metric.information.length, 0),
        fetchedAt: fetchedAt.toISOString(),
        periodStart: new Date(fetchedAt.getTime() - options.numOfDays * 86_400_000).toISOString(),
        periodEnd: fetchedAt.toISOString(),
        dimensions: [...options.dimensions]
      };
    } catch (error) {
      if (error instanceof ClarityClientError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new ClarityClientError('TIMEOUT', 'Clarity-anropet tog för lång tid.');
      } else {
        lastError = new ClarityClientError('NETWORK', 'Clarity kunde inte nås.');
      }
      if (attempt >= config.maxRetries) throw lastError;
      await wait(250 * (2 ** attempt) + Math.floor(Math.random() * 100));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new ClarityClientError('UPSTREAM', 'Clarity-anropet misslyckades.');
}
