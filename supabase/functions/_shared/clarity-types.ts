export const CLARITY_DIMENSIONS = [
  'Browser',
  'Device',
  'Country/Region',
  'OS',
  'Source',
  'Medium',
  'Campaign',
  'Channel',
  'URL'
] as const;

export type ClarityDimension = typeof CLARITY_DIMENSIONS[number];

export type ClarityInformationRow = Record<string, string | number | boolean | null>;

export type ClarityMetric = {
  metricName: string;
  information: ClarityInformationRow[];
};

export type ClaritySnapshot = {
  id?: number;
  period_start: string;
  period_end: string;
  fetched_at: string;
  project_id: string;
  dimensions: ClarityDimension[];
  metrics: ClarityMetric[];
  schema_version: number;
};

export type ClarityFetchResult = {
  metrics: ClarityMetric[];
  rowCount: number;
  fetchedAt: string;
  periodStart: string;
  periodEnd: string;
  dimensions: ClarityDimension[];
};

export type ClarityClientErrorCode =
  | 'CONFIGURATION'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_RESPONSE';

export class ClarityClientError extends Error {
  readonly code: ClarityClientErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ClarityClientErrorCode,
    message: string,
    status?: number,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ClarityClientError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
