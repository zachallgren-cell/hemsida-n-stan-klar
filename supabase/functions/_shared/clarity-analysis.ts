import type { ClarityInformationRow, ClaritySnapshot } from './clarity-types.ts';

type CountMetric = { numerator: number | null; denominator: number | null; percentage: number | null; available: boolean };

export type ClarityReport = {
  period: { start: string; end: string; timezone: 'Europe/Stockholm'; snapshotDays: number };
  status: { state: 'ready' | 'empty'; latestFetch: string | null; apiWindowNote: string };
  overview: {
    sessions: number;
    users: number;
    usersAreDailySum: true;
    mobileShare: CountMetric;
    bookingStarted: null;
    priceShown: null;
    summaryShown: null;
    bookingCompleted: null;
    bookingErrors: null;
    websiteConversion: CountMetric;
  };
  devices: Array<{ name: string; sessions: number; share: number }>;
  sources: Array<{ name: string; sessions: number; share: number }>;
  issues: Array<{
    title: string;
    status: 'Bekräftat problem' | 'Trolig hypotes' | 'Svag signal' | 'Ingen tillgänglig data';
    data: string;
    scope: string;
    audience: string;
    code: string;
    possibleCause: string;
    recommendation: string;
    primaryMetric: string;
    secondaryMetric: string;
    risk: string;
  }>;
  limitations: string[];
};

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getField(row: ClarityInformationRow, names: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z]/g, ''), value]));
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[^a-z]/g, ''));
    if (value !== undefined) return value;
  }
  return undefined;
}

function classifySource(row: ClarityInformationRow) {
  const source = String(getField(row, ['Source']) || '').toLowerCase();
  const medium = String(getField(row, ['Medium']) || '').toLowerCase();
  const campaign = String(getField(row, ['Campaign']) || '').toLowerCase();
  const haystack = `${source} ${medium} ${campaign}`;
  if (/facebook|fb|meta/.test(haystack)) return 'Facebook';
  if (/instagram|ig/.test(haystack)) return 'Instagram';
  if (/flygblad|flyer|offline/.test(haystack)) return 'Flygblad';
  if (/referral|recommendation|rekommendation|customer/.test(haystack)) return 'Rekommendation';
  if (/google/.test(source) && /(cpc|ppc|paid|ads)/.test(medium)) return 'Google Ads';
  if (/google/.test(source)) return 'Google organic';
  if (/direct|\(direct\)/.test(haystack) || (!source && !medium && !campaign)) return 'Direct';
  return 'Övrigt';
}

function ratio(numerator: number | null, denominator: number | null): CountMetric {
  if (numerator === null || denominator === null) return { numerator, denominator, percentage: null, available: false };
  return {
    numerator,
    denominator,
    percentage: denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : null,
    available: denominator > 0
  };
}

function trafficRows(snapshot: ClaritySnapshot) {
  const metric = snapshot.metrics.find((entry) => entry.metricName.toLowerCase() === 'traffic');
  return metric?.information || [];
}

function sumSessions(rows: ClarityInformationRow[]) {
  return rows.reduce((sum, row) => sum + numberValue(getField(row, ['totalSessionCount'])), 0);
}

function codeForUrl(url: string) {
  if (/bokning\.html/i.test(url)) return 'bokning.html, booking.js och booking.css';
  if (/offert\.html/i.test(url)) return 'offert.html och request-photo-quote';
  if (/admin\.html/i.test(url)) return 'admin.html och admin-analytics.js';
  if (/hantera-bokning\.html/i.test(url)) return 'hantera-bokning.html och manage-booking';
  return url ? `Sida/komponent för ${url}` : 'Berörd URL behöver verifieras i Clarity';
}

export function buildClarityReport(snapshots: ClaritySnapshot[], start: string, end: string): ClarityReport {
  const deviceSnapshots = snapshots.filter((snapshot) => snapshot.dimensions.includes('Device'));
  const sourceSnapshots = snapshots.filter((snapshot) => snapshot.dimensions.includes('Source'));
  const dailySessions = new Map<string, number>();
  const dailyUsers = new Map<string, number>();
  const devices = new Map<string, number>();
  const sources = new Map<string, number>();

  for (const snapshot of deviceSnapshots) {
    const day = snapshot.fetched_at.slice(0, 10);
    const rows = trafficRows(snapshot);
    dailySessions.set(day, Math.max(dailySessions.get(day) || 0, sumSessions(rows)));
    dailyUsers.set(day, Math.max(
      dailyUsers.get(day) || 0,
      rows.reduce((sum, row) => sum + numberValue(getField(row, ['distinctUserCount', 'distantUserCount'])), 0)
    ));
    for (const row of rows) {
      const name = String(getField(row, ['Device']) || 'Okänd');
      devices.set(name, (devices.get(name) || 0) + numberValue(getField(row, ['totalSessionCount'])));
    }
  }

  for (const snapshot of sourceSnapshots) {
    for (const row of trafficRows(snapshot)) {
      const name = classifySource(row);
      sources.set(name, (sources.get(name) || 0) + numberValue(getField(row, ['totalSessionCount'])));
    }
  }

  const sessions = [...dailySessions.values()].reduce((sum, value) => sum + value, 0);
  const users = [...dailyUsers.values()].reduce((sum, value) => sum + value, 0);
  const mobileSessions = [...devices.entries()]
    .filter(([name]) => /mobile|phone|android|ios/i.test(name))
    .reduce((sum, [, value]) => sum + value, 0);
  const asShares = (map: Map<string, number>) => [...map.entries()]
    .map(([name, count]) => ({ name, sessions: count, share: sessions > 0 ? Number(((count / sessions) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.sessions - a.sessions);

  const frictionKeys = [
    ['rage', 'Rage clicks'],
    ['dead', 'Dead clicks'],
    ['script', 'JavaScript-fel'],
    ['quickback', 'Quick backs'],
    ['excessive', 'Överdriven scrollning']
  ] as const;
  const issues: ClarityReport['issues'] = [];
  for (const [needle, label] of frictionKeys) {
    let count = 0;
    const urlCounts = new Map<string, number>();
    for (const snapshot of snapshots.filter((item) => item.dimensions.includes('URL'))) {
      for (const metric of snapshot.metrics.filter((item) => item.metricName.toLowerCase().includes(needle))) {
        for (const row of metric.information) {
          const rowCount = Object.entries(row)
            .filter(([key]) => key.toLowerCase().includes('count'))
            .reduce((sum, [, value]) => sum + numberValue(value), 0);
          count += rowCount;
          const url = String(getField(row, ['URL']) || '');
          if (url && rowCount) urlCounts.set(url, (urlCounts.get(url) || 0) + rowCount);
        }
      }
    }
    const topUrl = [...urlCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const status = count === 0 ? 'Ingen tillgänglig data' : count < 10 ? 'Svag signal' : count <= 30 ? 'Trolig hypotes' : 'Bekräftat problem';
    issues.push({
      title: label,
      status,
      data: count ? `${count} aggregerade registreringar i Clarity-exporten.` : 'Exporten innehåller inga användbara rader för detta mått.',
      scope: `${count} registreringar`,
      audience: topUrl ? `Besökare på ${topUrl}` : 'Alla exporterade sessioner',
      code: codeForUrl(topUrl),
      possibleCause: count ? 'Mönstret behöver verifieras i Claritys inspelningar och motsvarande kod.' : 'Data Export API eller den aktuella perioden saknar måttet.',
      recommendation: count ? 'Granska först de mest drabbade URL:erna i Clarity och gör minsta reproducerbara kodfix.' : 'Ingen kodändring utan underlag.',
      primaryMetric: label,
      secondaryMetric: 'Bokningsgrad',
      risk: 'Aggregerad data visar korrelation, inte säker orsak.'
    });
  }

  return {
    period: { start, end, timezone: 'Europe/Stockholm', snapshotDays: dailySessions.size },
    status: {
      state: snapshots.length ? 'ready' : 'empty',
      latestFetch: snapshots.map((item) => item.fetched_at).sort().at(-1) || null,
      apiWindowNote: 'Varje snapshot är ett rullande 24-timmarsfönster i UTC; längre perioder är summor av dagliga snapshots.'
    },
    overview: {
      sessions,
      users,
      usersAreDailySum: true,
      mobileShare: ratio(mobileSessions, sessions),
      bookingStarted: null,
      priceShown: null,
      summaryShown: null,
      bookingCompleted: null,
      bookingErrors: null,
      websiteConversion: ratio(null, sessions)
    },
    devices: asShares(devices),
    sources: asShares(sources),
    issues,
    limitations: [
      'Data Export API stöder endast de senaste 1–3 dygnen, inte valfria historiska datum.',
      'API:t dokumenterar inte export av custom events eller Smart Events; bokningsfunneln kan därför inte räknas tillförlitligt här.',
      'Heatmaps och råa sessionsinspelningar kan inte hämtas via den dokumenterade endpointen.',
      'Unika användare över flera snapshots kan inte dedupliceras och visas därför som summan av dagliga unika värden.',
      'Högst 1 000 rader returneras och svaret kan inte pagineras.'
    ]
  };
}
