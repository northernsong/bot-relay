import type { Deps } from './deps.js';

/**
 * Minimal Prometheus text-format metrics for the control plane only
 * (design §11): scales, inquiry outcomes, identity issuance/verification,
 * discovery, rate limiting + login failures, and one /v1 latency histogram.
 * There are no relay or delivery series anywhere — no messages exist here.
 */

/**
 * Latency buckets in seconds, chosen so the P95 acceptance targets are
 * readable off the histogram: directory/identity < 100ms, register and
 * inquiry acceptance < 500ms.
 */
const LATENCY_BUCKETS_SEC = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type CounterSeries = { key: string; labels: Record<string, string>; value: number };

type HistogramSeries = {
  key: string;
  labels: Record<string, string>;
  buckets: number[];
  sum: number;
  count: number;
};

type MetricMeta = { type: 'counter' | 'gauge' | 'histogram'; help: string };

/** Every metric this service can expose, in exposition order. */
export const METRIC_META: Record<string, MetricMeta> = {
  bots_registered: { type: 'gauge', help: 'Number of registered bots.' },
  bots_disabled: { type: 'gauge', help: 'Number of disabled bots.' },
  grants_active: { type: 'gauge', help: 'Number of active (non-revoked, non-abandoned) grants.' },
  admin_login_failures_total: { type: 'counter', help: 'Failed admin console logins.' },
  rate_limited_total: { type: 'counter', help: 'Requests rejected by a rate limit, by scope.' },
  inquiries_created_total: { type: 'counter', help: 'Authorization inquiries accepted for delivery.' },
  inquiry_outcome_total: { type: 'counter', help: 'Inquiry outcomes by terminal state.' },
  inquiry_delivery_failures_total: { type: 'counter', help: 'Failed inquiry deliveries by classified reason.' },
  identity_tokens_issued_total: { type: 'counter', help: 'Identity proof JWTs issued.' },
  identity_verify_total: { type: 'counter', help: 'Online identity verifications by result.' },
  directory_lookups_total: { type: 'counter', help: 'Directory list and single-entry lookups.' },
  grants_refresh_total: { type: 'counter', help: 'Controlled contact refreshes served.' },
  http_request_duration_seconds: { type: 'histogram', help: 'Business-plane (/v1) request latency in seconds.' },
};

/** In-memory series store; per process, reset on restart — good enough here. */
export class Metrics {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) existing.value += by;
    else this.counters.set(key, { key, labels, value: by });
  }

  observe(name: string, labels: Record<string, string>, valueSec: number): void {
    const key = seriesKey(name, labels);
    let series = this.histograms.get(key);
    if (!series) {
      series = { key, labels, buckets: LATENCY_BUCKETS_SEC.map(() => 0), sum: 0, count: 0 };
      this.histograms.set(key, series);
    }
    for (let i = 0; i < LATENCY_BUCKETS_SEC.length; i += 1) {
      if (valueSec <= (LATENCY_BUCKETS_SEC[i] as number)) series.buckets[i] = (series.buckets[i] as number) + 1;
    }
    series.sum += valueSec;
    series.count += 1;
  }

  /** Render Prometheus text. Gauges are computed by the caller at scrape time. */
  render(gauges: Array<[string, number]>): string {
    const lines: string[] = [];
    for (const [name, meta] of Object.entries(METRIC_META)) {
      if (meta.type === 'gauge') {
        const gauge = gauges.find(([gaugeName]) => gaugeName === name);
        if (!gauge) continue;
        lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} gauge`, `${name} ${formatValue(gauge[1])}`);
        continue;
      }
      if (meta.type === 'counter') {
        const series = [...this.counters.values()].filter((s) => s.key === name || s.key.startsWith(`${name}{`)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        if (series.length === 0) continue;
        lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} counter`);
        for (const s of series) lines.push(`${s.key} ${formatValue(s.value)}`);
        continue;
      }
      const series = [...this.histograms.values()].filter((s) => s.key === name || s.key.startsWith(`${name}{`)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (series.length === 0) continue;
      lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} histogram`);
      for (const s of series) {
        for (let i = 0; i < LATENCY_BUCKETS_SEC.length; i += 1) {
          lines.push(
            `${name}_bucket${renderLabels({ ...s.labels, le: formatValue(LATENCY_BUCKETS_SEC[i] as number) })} ${formatValue(s.buckets[i] as number)}`,
          );
        }
        lines.push(`${name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${formatValue(s.count)}`);
        lines.push(`${name}_sum${renderLabels(s.labels)} ${formatValue(s.sum)}`);
        lines.push(`${name}_count${renderLabels(s.labels)} ${formatValue(s.count)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Gauges are live database counts; everything else comes from `deps.metrics`. */
export function renderMetrics(deps: Deps): string {
  const bots = deps.db.listBots();
  const activeGrants = deps.db.listGrants({}).filter((grant) => grant.revokedAt === null && grant.abandonedAt === null);
  const gauges: Array<[string, number]> = [
    ['bots_registered', bots.length],
    ['bots_disabled', bots.filter((bot) => bot.disabled).length],
    ['grants_active', activeGrants.length],
  ];
  return (deps.metrics ?? new Metrics()).render(gauges);
}

/** Literal path segments; anything else (bot ids, inq_/grt_ ids) becomes :id. */
const ROUTE_LITERALS = new Set([
  'v1',
  'me',
  'directory',
  'inquiries',
  'grants',
  'identity-token',
  'identity',
  'verify',
  'bots',
  'status',
  'contact',
  'abandon',
  'revoke',
  'token',
  'rotate',
  'decision',
]);

/** Collapse ids in a request path so the route label stays low-cardinality. */
export function normalizeRoute(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean).map((segment) => (ROUTE_LITERALS.has(segment) ? segment : ':id'));
  return `${method.toUpperCase()} /${segments.join('/')}`;
}

/** Map internal delivery_error classifications to the §11 label values. */
export function deliveryFailureReason(error: string | null): string {
  switch (error) {
    case 'timeout':
      return 'timeout';
    case 'http_4xx':
    case 'http_5xx':
      return 'http_error';
    case 'blocked_address':
      return 'blocked';
    default:
      return 'network';
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const suffix = renderLabels(labels);
  return suffix === '' ? name : `${name}${suffix}`;
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
}
