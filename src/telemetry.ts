import { trace, metrics, SpanKind, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TelemetryConfig {
    enabled: boolean;
    endpoint: string;          // OTLP HTTP endpoint (e.g. http://localhost:4318)
    serviceName: string;       // Service name in traces/metrics
    metricsInterval: number;   // Metrics export interval in ms
}

const DEFAULT_CONFIG: TelemetryConfig = {
    enabled: false,
    endpoint: 'http://localhost:4318',
    serviceName: 'midleman',
    metricsInterval: 15_000,
};

let telemetryConfig: TelemetryConfig = { ...DEFAULT_CONFIG };
let tracerProvider: BasicTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;

// ─── Initialization ─────────────────────────────────────────────────────────

export function initTelemetry(config: Partial<TelemetryConfig>): void {
    telemetryConfig = { ...DEFAULT_CONFIG, ...config };

    if (!telemetryConfig.enabled) {
        console.log('📊 OpenTelemetry: disabled');
        return;
    }

    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: telemetryConfig.serviceName,
        [ATTR_SERVICE_VERSION]: '1.0.0',
    });

    // ── Traces ──
    const traceExporter = new OTLPTraceExporter({
        url: `${telemetryConfig.endpoint}/v1/traces`,
    });

    tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });

    // Register as global tracer provider
    trace.setGlobalTracerProvider(tracerProvider);

    // ── Metrics ──
    const metricExporter = new OTLPMetricExporter({
        url: `${telemetryConfig.endpoint}/v1/metrics`,
    });

    meterProvider = new MeterProvider({
        resource,
        readers: [
            new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: telemetryConfig.metricsInterval,
            }),
        ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    console.log(`📊 OpenTelemetry: enabled → ${telemetryConfig.endpoint}`);
    console.log(`   Service: ${telemetryConfig.serviceName} | Metrics interval: ${telemetryConfig.metricsInterval}ms`);
}

export async function shutdownTelemetry(): Promise<void> {
    if (tracerProvider) await tracerProvider.shutdown();
    if (meterProvider) await meterProvider.shutdown();
}

export function getTelemetryConfig(): TelemetryConfig {
    return { ...telemetryConfig };
}

// ─── Tracer & Meter instances ───────────────────────────────────────────────

const tracer = trace.getTracer('midleman', '1.0.0');
const meter = metrics.getMeter('midleman', '1.0.0');

// ─── Metrics: Target (main forward) ────────────────────────────────────────

const targetRequestCounter = meter.createCounter('target.requests.total', {
    description: 'Total requests forwarded to main target',
});

const targetRequestDuration = meter.createHistogram('target.request.duration_ms', {
    description: 'Duration of requests forwarded to main target (ms)',
});

const targetErrorCounter = meter.createCounter('target.errors.total', {
    description: 'Total errors forwarding to main target',
});

const targetActiveRequests = meter.createUpDownCounter('target.requests.active', {
    description: 'Currently active target requests',
});

// ─── Metrics: Proxy (per-profile) ──────────────────────────────────────────

const proxyRequestCounter = meter.createCounter('proxy.requests.total', {
    description: 'Total proxy requests per profile',
});

const proxyRequestDuration = meter.createHistogram('proxy.request.duration_ms', {
    description: 'Duration of proxy requests per profile (ms)',
});

const proxyErrorCounter = meter.createCounter('proxy.errors.total', {
    description: 'Total proxy errors per profile',
});

const proxyActiveRequests = meter.createUpDownCounter('proxy.requests.active', {
    description: 'Currently active proxy requests per profile',
});

const proxyBlockedCounter = meter.createCounter('proxy.blocked.total', {
    description: 'Total blocked requests per profile (extensions/content-type)',
});

const proxyRedirectCounter = meter.createCounter('proxy.redirects.total', {
    description: 'Total upstream redirects followed per profile',
});

// ─── In-memory metrics store (always active, powers the dashboard) ──────────

const LATENCY_BUFFER_SIZE = 500;   // last N durations for percentile calc
const TIMELINE_BUCKETS = 60;       // 60 buckets for timeline chart
const TIMELINE_BUCKET_MS = 60_000; // 1 minute per bucket

interface LatencyRing {
    buf: Float64Array;
    pos: number;
    len: number;
}

function newRing(): LatencyRing {
    return { buf: new Float64Array(LATENCY_BUFFER_SIZE), pos: 0, len: 0 };
}

function pushRing(ring: LatencyRing, value: number): void {
    ring.buf[ring.pos] = value;
    ring.pos = (ring.pos + 1) % LATENCY_BUFFER_SIZE;
    if (ring.len < LATENCY_BUFFER_SIZE) ring.len++;
}

function percentile(ring: LatencyRing, p: number): number {
    if (ring.len === 0) return 0;
    const sorted = ring.buf.slice(0, ring.len).sort();
    const idx = Math.min(Math.floor(p / 100 * ring.len), ring.len - 1);
    return sorted[idx];
}

interface TimelineBucket {
    ts: number;   // bucket start timestamp
    count: number;
    errors: number;
    totalMs: number;
}

interface InternalMetrics {
    requests: number;
    errors: number;
    active: number;
    blocked: number;
    redirects: number;
    totalDurationMs: number;
    latency: LatencyRing;
    timeline: TimelineBucket[];
    statusCodes: Record<number, number>;
}

function newMetrics(): InternalMetrics {
    return {
        requests: 0,
        errors: 0,
        active: 0,
        blocked: 0,
        redirects: 0,
        totalDurationMs: 0,
        latency: newRing(),
        timeline: [],
        statusCodes: {},
    };
}

function getTimelineBucket(m: InternalMetrics, now: number): TimelineBucket {
    const bucketStart = Math.floor(now / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
    const last = m.timeline[m.timeline.length - 1];
    if (last && last.ts === bucketStart) return last;
    const bucket: TimelineBucket = { ts: bucketStart, count: 0, errors: 0, totalMs: 0 };
    m.timeline.push(bucket);
    // Keep only last TIMELINE_BUCKETS
    if (m.timeline.length > TIMELINE_BUCKETS) {
        m.timeline.splice(0, m.timeline.length - TIMELINE_BUCKETS);
    }
    return bucket;
}

// Target metrics (always collected)
const targetMetrics: InternalMetrics = newMetrics();

// Per-profile metrics
const proxyMetricsMap = new Map<string, InternalMetrics>();

function getProxyMetrics(profileName: string): InternalMetrics {
    let m = proxyMetricsMap.get(profileName);
    if (!m) {
        m = newMetrics();
        proxyMetricsMap.set(profileName, m);
    }
    return m;
}

/** Snapshot returned by getMetricsSnapshot() */
export interface MetricsSnapshot {
    target: MetricsSummary;
    targets: Record<string, MetricsSummary>;
    profiles: Record<string, MetricsSummary>;
    otel: { enabled: boolean; endpoint: string };
}

export interface MetricsSummary {
    requests: number;
    errors: number;
    active: number;
    blocked: number;
    redirects: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    statusCodes: Record<number, number>;
    timeline: { ts: number; count: number; errors: number; avgMs: number }[];
}

function summarize(m: InternalMetrics): MetricsSummary {
    return {
        requests: m.requests,
        errors: m.errors,
        active: m.active,
        blocked: m.blocked,
        redirects: m.redirects,
        avgLatencyMs: m.requests > 0 ? Math.round(m.totalDurationMs / m.requests * 100) / 100 : 0,
        p50LatencyMs: Math.round(percentile(m.latency, 50) * 100) / 100,
        p95LatencyMs: Math.round(percentile(m.latency, 95) * 100) / 100,
        p99LatencyMs: Math.round(percentile(m.latency, 99) * 100) / 100,
        statusCodes: { ...m.statusCodes },
        timeline: m.timeline.map(b => ({
            ts: b.ts,
            count: b.count,
            errors: b.errors,
            avgMs: b.count > 0 ? Math.round(b.totalMs / b.count * 100) / 100 : 0,
        })),
    };
}

export function getMetricsSnapshot(): MetricsSnapshot {
    const targets: Record<string, MetricsSummary> = {};
    for (const [name, m] of targetMetricsMap) {
        targets[name] = summarize(m);
    }
    const profiles: Record<string, MetricsSummary> = {};
    for (const [name, m] of proxyMetricsMap) {
        profiles[name] = summarize(m);
    }
    return {
        target: summarize(targetMetrics),
        targets,
        profiles,
        otel: { enabled: telemetryConfig.enabled, endpoint: telemetryConfig.endpoint },
    };
}

// ─── Target instrumentation ─────────────────────────────────────────────────

export interface TargetSpanOptions {
    method: string;
    path: string;
    targetUrl: string;
    requestId: string;
    targetName?: string;    // named target identifier
}

// Per-named-target metrics map
const targetMetricsMap = new Map<string, InternalMetrics>();

function getTargetMetrics(targetName: string): InternalMetrics {
    let m = targetMetricsMap.get(targetName);
    if (!m) {
        m = newMetrics();
        targetMetricsMap.set(targetName, m);
    }
    return m;
}

export function startTargetSpan(opts: TargetSpanOptions): Span {
    const spanName = opts.targetName ? `target.forward.${opts.targetName}` : 'target.forward';
    const span = tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: {
            'http.method': opts.method,
            'http.url': opts.targetUrl,
            'http.route': opts.path,
            'request.id': opts.requestId,
            'midleman.type': 'target',
            ...(opts.targetName ? { 'midleman.target': opts.targetName } : {}),
        },
    });

    targetActiveRequests.add(1);
    targetRequestCounter.add(1, { 'http.method': opts.method });

    // In-memory — global + per-target
    targetMetrics.active++;
    if (opts.targetName) getTargetMetrics(opts.targetName).active++;

    return span;
}

export function endTargetSpan(span: Span, statusCode: number, durationMs: number, error?: Error, targetName?: string): void {
    targetActiveRequests.add(-1);

    const attrs: Attributes = { 'http.status_code': statusCode };
    targetRequestDuration.record(durationMs, attrs);

    if (statusCode >= 400 || error) {
        targetErrorCounter.add(1, { 'http.status_code': statusCode });
        span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
    } else {
        span.setStatus({ code: SpanStatusCode.OK });
    }

    span.setAttribute('http.status_code', statusCode);
    span.setAttribute('duration_ms', durationMs);
    span.end();

    // In-memory — global
    const now = Date.now();
    targetMetrics.active--;
    targetMetrics.requests++;
    targetMetrics.totalDurationMs += durationMs;
    targetMetrics.statusCodes[statusCode] = (targetMetrics.statusCodes[statusCode] || 0) + 1;
    pushRing(targetMetrics.latency, durationMs);
    if (statusCode >= 400 || error) targetMetrics.errors++;
    const bucket = getTimelineBucket(targetMetrics, now);
    bucket.count++;
    bucket.totalMs += durationMs;
    if (statusCode >= 400 || error) bucket.errors++;

    // In-memory — per-target
    if (targetName) {
        const m = getTargetMetrics(targetName);
        m.active--;
        m.requests++;
        m.totalDurationMs += durationMs;
        m.statusCodes[statusCode] = (m.statusCodes[statusCode] || 0) + 1;
        pushRing(m.latency, durationMs);
        if (statusCode >= 400 || error) m.errors++;
        const tb = getTimelineBucket(m, now);
        tb.count++;
        tb.totalMs += durationMs;
        if (statusCode >= 400 || error) tb.errors++;
    }
}

// ─── Proxy instrumentation ──────────────────────────────────────────────────

export interface ProxySpanOptions {
    method: string;
    path: string;
    profileName: string;
    targetUrl: string;
}

export function startProxySpan(opts: ProxySpanOptions): Span {
    const span = tracer.startSpan(`proxy.forward.${opts.profileName}`, {
        kind: SpanKind.CLIENT,
        attributes: {
            'http.method': opts.method,
            'http.url': opts.targetUrl,
            'http.route': opts.path,
            'midleman.type': 'proxy',
            'midleman.profile': opts.profileName,
        },
    });

    proxyActiveRequests.add(1, { 'midleman.profile': opts.profileName });
    proxyRequestCounter.add(1, {
        'http.method': opts.method,
        'midleman.profile': opts.profileName,
    });

    // In-memory
    getProxyMetrics(opts.profileName).active++;

    return span;
}

export function endProxySpan(
    span: Span,
    profileName: string,
    statusCode: number,
    durationMs: number,
    error?: Error,
): void {
    const profileAttr = { 'midleman.profile': profileName };

    proxyActiveRequests.add(-1, profileAttr);

    proxyRequestDuration.record(durationMs, {
        ...profileAttr,
        'http.status_code': statusCode,
    });

    if (statusCode >= 400 || error) {
        proxyErrorCounter.add(1, { ...profileAttr, 'http.status_code': statusCode });
        span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
    } else {
        span.setStatus({ code: SpanStatusCode.OK });
    }

    span.setAttribute('http.status_code', statusCode);
    span.setAttribute('duration_ms', durationMs);
    span.end();

    // In-memory
    const now = Date.now();
    const m = getProxyMetrics(profileName);
    m.active--;
    m.requests++;
    m.totalDurationMs += durationMs;
    m.statusCodes[statusCode] = (m.statusCodes[statusCode] || 0) + 1;
    pushRing(m.latency, durationMs);
    if (statusCode >= 400 || error) m.errors++;
    const bucket = getTimelineBucket(m, now);
    bucket.count++;
    bucket.totalMs += durationMs;
    if (statusCode >= 400 || error) bucket.errors++;
}

export function recordProxyBlocked(profileName: string, reason: string): void {
    proxyBlockedCounter.add(1, {
        'midleman.profile': profileName,
        'midleman.block_reason': reason,
    });
    // In-memory
    getProxyMetrics(profileName).blocked++;
}

export function recordProxyRedirect(profileName: string): void {
    proxyRedirectCounter.add(1, {
        'midleman.profile': profileName,
    });
    // In-memory
    getProxyMetrics(profileName).redirects++;
}
