import {
    Fragment,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type SetStateAction,
    type SubmitEvent,
} from "react";
import {
    FaAngleDoubleLeft,
    FaAngleDoubleRight,
    FaBan,
    FaBell,
    FaChartArea,
    FaChevronDown,
    FaChevronRight,
    FaClipboardList,
    FaRegCalendarAlt,
    FaServer,
    FaSignOutAlt,
    FaUndo,
    FaUsers,
    FaUserShield,
} from "react-icons/fa";
import {
    monitoringService,
    type AlertOperator,
    type AlertScope,
    type AuditLogEntry,
    type CronJob,
    type CronRun,
    type CronTriggerType,
    type EndpointCheckResult,
    type EndpointCheckRun,
    type EndpointStatsBucket,
    type ManagedUser,
    type MetricAgg,
    type MetricAlertRule,
    type MetricAlertRuleInput,
    type MetricContainer,
    type MetricGranularity,
    type MetricKind,
    type MetricNode,
    type MetricService,
    type MetricsOverview,
    type MetricTimeseriesPoint,
    type MetricTimeseriesResponse,
    type MonitorEndpoint,
    type MonitorGroup,
    type MonitorStatus,
    type SessionUser,
    type StatsGranularity,
    type StatsMode,
    type UserRole,
} from "./services/monitoringService";

// Like Partial, but realtime websocket merges also write explicit nulls.
type Nullable<T> = { [K in keyof T]?: T[K] | null };

// A latency/run data point: raw check runs and aggregated buckets are
// rendered by the same components, so both shapes are allowed.
type RunPoint = Nullable<EndpointCheckRun> & Nullable<EndpointStatsBucket>;
type RunsByEndpoint = Record<string, RunPoint[]>;

// Realtime cron run updates arrive over the websocket with only a subset of
// the full cron_runs row.
type CronRunSummary = Nullable<CronRun>;
type CronRunsByName = Record<string, CronRunSummary[]>;

type StatusTab = "services" | "crons";
type AdminTab = "routes" | "crons";
type CronRunsMode = "recent" | "window";

type GroupWithEndpoints = MonitorGroup & {
    endpoints: MonitorEndpoint[];
    group_status: MonitorStatus;
};

// /api/health response; the initial client-side value only knows a subset.
interface HealthSummary {
    status: string;
    endpointCount: number;
    cronCount?: number;
    timestamp?: string;
}

interface CronMonitorMeta {
    updatedBy: string | null;
    updatedAt: string | null;
}

// Payload of the "cron:run" websocket event (see server emitRunEvent).
interface CronRunEventPayload {
    runId: string;
    cron: string;
    status: string;
    triggerType?: CronTriggerType | null;
    triggeredAt?: string | null;
    firstPingAt?: string | null;
    lastPingAt?: string | null;
    completedAt?: string | null;
    pings?: number;
    durationMs?: number | null;
    responseCode?: number | null;
    errorMessage?: string | null;
}

// Form state mirrors input elements: numeric fields may hold strings while
// being edited; they are converted with Number() on submit.
interface EndpointFormState {
    group_name: string;
    name: string;
    monitor_type: string;
    url: string;
    method: string;
    headers_json: string;
    body_text: string;
    expected_status: number | string;
    expected_json_path: string;
    expected_json_value: string;
    connection_json: string;
    probe_command: string;
    expected_probe_value: string;
    interval_seconds: number | string;
    down_retries: number | string;
    up_retries: number | string;
}

interface CronFormState {
    cron: string;
    expression: string;
    service: string;
    endpoint: string;
    trigger_type: string;
    http_method: string;
    headers_json: string;
    body_text: string;
    nats_subject: string;
    start_window_seconds: number | string;
    ping_window_seconds: number | string;
    track_run: boolean;
    status: boolean;
}

const METHOD_OPTIONS: string[] = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
];
const MONITOR_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "http", label: "HTTP API" },
    { value: "mysql", label: "MySQL" },
    { value: "redis", label: "Redis" },
    { value: "nats", label: "NATS JetStream" },
    { value: "tcp", label: "TCP Port" },
];

const DEFAULT_CONNECTION_JSON: Record<string, string> = {
    http: '{\n  "timeoutMs": 10000\n}',
    mysql: '{\n  "host": "127.0.0.1",\n  "port": 3306,\n  "user": "root",\n  "password": "",\n  "database": "app_db"\n}',
    redis: '{\n  "host": "127.0.0.1",\n  "port": 6379\n}',
    nats: '{\n  "servers": ["nats://127.0.0.1:4222"]\n}',
    tcp: '{\n  "host": "127.0.0.1",\n  "port": 443,\n  "timeoutMs": 5000\n}',
};

const INITIAL_ENDPOINT_FORM: EndpointFormState = {
    group_name: "",
    name: "",
    monitor_type: "http",
    url: "",
    method: "GET",
    headers_json: "",
    body_text: "",
    expected_status: 200,
    expected_json_path: "",
    expected_json_value: "",
    connection_json: DEFAULT_CONNECTION_JSON.http,
    probe_command: "",
    expected_probe_value: "",
    interval_seconds: 60,
    down_retries: 3,
    up_retries: 1,
};

const CRON_TRIGGER_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "nats", label: "NATS" },
    { value: "http", label: "HTTP" },
];

const CRON_HTTP_METHOD_OPTIONS: string[] = ["GET", "POST"];

const INITIAL_CRON_FORM: CronFormState = {
    cron: "",
    expression: "",
    service: "apis",
    endpoint: "",
    trigger_type: "nats",
    http_method: "NONE",
    headers_json: "",
    body_text: "",
    nats_subject: "crons.uptime_monitor",
    start_window_seconds: 60,
    ping_window_seconds: 60,
    track_run: true,
    status: true,
};

const ADMIN_TAB_OPTIONS: Array<{ value: AdminTab; label: string }> = [
    { value: "routes", label: "Monitored Services" },
    { value: "crons", label: "Cron Health" },
];

const STATUS_TAB_OPTIONS: Array<{ value: StatusTab; label: string }> = [
    { value: "services", label: "Monitored Services" },
    { value: "crons", label: "Cron Health" },
];

const STATUS_VIEW_MODE_OPTIONS: Array<{ value: StatsMode; label: string }> = [
    { value: "aggregate", label: "Trend" },
    { value: "raw", label: "Last 50 checks" },
];

const CRON_RUNS_MODE_OPTIONS: Array<{ value: CronRunsMode; label: string }> = [
    { value: "recent", label: "Last 50 runs" },
    { value: "window", label: "Window" },
];

const CRON_STATUS_WINDOW_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 1, label: "Last 24h" },
    { value: 7, label: "Last 7d" },
    { value: 30, label: "Last 30d" },
];

const STATUS_GRANULARITY_OPTIONS: Array<{
    value: StatsGranularity;
    label: string;
}> = [
    { value: "minute", label: "Minute" },
    { value: "hour", label: "Hour" },
    { value: "day", label: "Day" },
];

const STATUS_RANGE_OPTIONS: Record<
    StatsGranularity,
    Array<{ value: number; label: string }>
> = {
    minute: [
        { value: 1, label: "Last 24h" },
        { value: 2, label: "Last 48h" },
    ],
    hour: [
        { value: 1, label: "Last 24h" },
        { value: 7, label: "Last 7d" },
        { value: 30, label: "Last 30d" },
    ],
    day: [
        { value: 7, label: "Last 7d" },
        { value: 30, label: "Last 30d" },
        { value: 90, label: "Last 90d" },
    ],
};

// Epoch millis for sorting/filtering; NaN when the input is missing/invalid.
function toTimeMs(input: string | number | Date | null | undefined): number {
    if (input == null) return NaN;
    return new Date(input).getTime();
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatRelativeTime(
    input: string | number | Date | null | undefined,
    nowMs: number = Date.now(),
): string {
    if (!input) return "never";

    // const date = moment.utc(input).local().toDate()
    const date = new Date(input);

    if (Number.isNaN(date.getTime())) return "never";

    const deltaSeconds = Math.round((date.getTime() - nowMs) / 1000);
    const absSeconds = Math.abs(deltaSeconds);
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

    if (absSeconds < 5) return "just now";
    if (absSeconds < 60) return rtf.format(deltaSeconds, "second");

    const deltaMinutes = Math.round(deltaSeconds / 60);
    if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, "minute");

    const deltaHours = Math.round(deltaMinutes / 60);
    if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, "hour");

    const deltaDays = Math.round(deltaHours / 24);
    if (Math.abs(deltaDays) < 30) return rtf.format(deltaDays, "day");

    const deltaMonths = Math.round(deltaDays / 30);
    if (Math.abs(deltaMonths) < 12) return rtf.format(deltaMonths, "month");

    return rtf.format(Math.round(deltaMonths / 12), "year");
}

function stringifyJson(value: unknown, fallback = ""): string {
    if (value == null) return fallback;
    if (typeof value === "string") return value;
    if (typeof value === "object") {
        if (!Object.keys(value).length) return fallback;
        return JSON.stringify(value, null, 2);
    }
    return String(value);
}

function formatFriendlyDateTime(
    input: string | number | Date | null | undefined,
): string {
    if (!input) return "Unknown time";
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return "Unknown time";

    return new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

// Human-readable byte size (binary units). Returns an em-dash for nullish input.
function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || Number.isNaN(bytes)) return "—";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const exponent = Math.min(
        Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
        units.length - 1,
    );
    const value = bytes / 1024 ** exponent;
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[exponent]}`;
}

function formatBytesRate(bytesPerSec: number | null | undefined): string {
    if (bytesPerSec == null || Number.isNaN(bytesPerSec)) return "—";
    return `${formatBytes(bytesPerSec)}/s`;
}

// CPU is reported with 100 == one full core (docker-stats semantics). Present it
// as a cores-equivalent number for totals that can exceed a single core.
function formatCores(cpuPct: number | null | undefined): string {
    if (cpuPct == null || Number.isNaN(cpuPct)) return "—";
    const cores = cpuPct / 100;
    if (cores === 0) return "0 cores";
    // Adaptive precision so tiny-but-nonzero usage never reads as "0 cores".
    if (cores >= 10) return `${Math.round(cores)} cores`;
    if (cores >= 0.01) return `${Math.round(cores * 100) / 100} cores`;
    return `${Math.max(1, Math.round(cores * 1000))} mcores`;
}

function formatPct(pct: number | null | undefined): string {
    if (pct == null || Number.isNaN(pct)) return "—";
    return `${Math.round(pct * 10) / 10}%`;
}

function renderCronRunBadge(status: string | null | undefined): string {
    if (status === "success") return "bg-emerald-100/85 text-emerald-700";
    if (status === "failed" || status === "missed")
        return "bg-rose-100/85 text-rose-700";
    return "bg-amber-100/85 text-amber-700";
}

function cronRunStripColor(status: string | null | undefined): string {
    if (status === "success") return "bg-emerald-500 hover:bg-emerald-400";
    if (status === "failed" || status === "missed")
        return "bg-rose-500 hover:bg-rose-400";
    return "bg-amber-400 hover:bg-amber-300";
}

interface HoveredCronRun {
    run: CronRunSummary;
    x: number;
    y: number;
}

function CronRunGrid({ runs }: { runs: CronRunSummary[] }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [hoveredRun, setHoveredRun] = useState<HoveredCronRun | null>(null);

    // Latest run first, down to the oldest we have recorded.
    const orderedRuns = useMemo(() => {
        return [...(runs ?? [])].sort(
            (left, right) =>
                toTimeMs(right.triggered_at) - toTimeMs(left.triggered_at),
        );
    }, [runs]);

    if (!orderedRuns.length) {
        return <p className="text-xs text-slate-500">No runs recorded yet.</p>;
    }

    const handleHover = (
        event: ReactMouseEvent<HTMLSpanElement>,
        run: CronRunSummary,
    ) => {
        if (!containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const targetRect = event.currentTarget.getBoundingClientRect();

        setHoveredRun({
            run,
            x: targetRect.left - containerRect.left + targetRect.width / 2,
            y: targetRect.top - containerRect.top,
        });
    };

    return (
        <div ref={containerRef} className="relative">
            <div className="flex flex-wrap gap-1">
                {orderedRuns.map((run, index) => (
                    <span
                        key={run.run_id ?? index}
                        onMouseEnter={(event) => handleHover(event, run)}
                        onMouseLeave={() => setHoveredRun(null)}
                        className={`h-3.5 w-3.5 cursor-pointer rounded-sm transition ${cronRunStripColor(run.status)}`}
                    />
                ))}
            </div>
            {hoveredRun && (
                <div
                    className="pointer-events-none absolute z-20 min-w-56 max-w-72 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur"
                    style={{
                        left: `${hoveredRun.x}px`,
                        top: `${hoveredRun.y - 8}px`,
                        transform: "translate(-50%, -100%)",
                    }}
                >
                    <p className="font-semibold uppercase text-slate-900">
                        {hoveredRun.run.status}
                    </p>
                    <p className="mt-0.5 text-slate-600">
                        Triggered:{" "}
                        {formatFriendlyDateTime(hoveredRun.run.triggered_at)}
                    </p>
                    {hoveredRun.run.completed_at ? (
                        <p className="mt-0.5 text-slate-600">
                            Completed:{" "}
                            {formatFriendlyDateTime(
                                hoveredRun.run.completed_at,
                            )}
                        </p>
                    ) : null}
                    <p className="mt-0.5 break-all font-mono text-[10px] text-slate-500">
                        {hoveredRun.run.run_id}
                    </p>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-slate-600">
                        {hoveredRun.run.duration_ms != null ? (
                            <span>
                                Duration:{" "}
                                {(
                                    Number(hoveredRun.run.duration_ms) / 1000
                                ).toFixed(2)}
                                s
                            </span>
                        ) : null}
                        <span>Pings: {hoveredRun.run.pings ?? 0}</span>
                        {hoveredRun.run.response_code != null ? (
                            <span>HTTP: {hoveredRun.run.response_code}</span>
                        ) : null}
                    </div>
                    {hoveredRun.run.error_message ? (
                        <p className="mt-1 break-words rounded border border-rose-200/80 bg-rose-50/80 px-1.5 py-1 text-[11px] text-rose-700">
                            {hoveredRun.run.error_message}
                        </p>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function getGroupStatus(endpoints: MonitorEndpoint[]): MonitorStatus {
    if (!endpoints.length) return "pending";
    if (endpoints.some((endpoint) => endpoint.status === "down")) return "down";
    if (endpoints.every((endpoint) => endpoint.status === "up")) return "up";
    return "pending";
}

function getBucketStart(
    input: string | number | Date | null | undefined,
    granularity: StatsGranularity,
): string | null {
    if (input == null) return null;
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return null;

    if (granularity === "day") {
        date.setUTCHours(0, 0, 0, 0);
        return date.toISOString();
    }

    if (granularity === "hour") {
        date.setUTCMinutes(0, 0, 0);
        return date.toISOString();
    }

    date.setUTCSeconds(0, 0);
    return date.toISOString();
}

function clampRunsToRange(runs: RunPoint[], rangeDays: number): RunPoint[] {
    const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    return runs.filter((run) => {
        const timestamp = toTimeMs(
            run.bucket_start ?? run.checked_at ?? run.latest_checked_at,
        );
        return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
}

function mergeRealtimeRun(
    existingRuns: RunPoint[] | undefined,
    payload: Partial<EndpointCheckResult>,
    statusViewMode: StatsMode,
    statusGranularity: StatsGranularity,
    statusRangeDays: number,
): RunPoint[] {
    if (statusViewMode === "raw") {
        const nextRun = {
            response_time_ms: payload.responseTimeMs ?? 0,
            checked_at: payload.lastCheckedAt ?? new Date().toISOString(),
            response_code: payload.responseCode ?? null,
            status: payload.status ?? null,
            error_message: payload.lastError ?? null,
        };

        return [nextRun, ...(existingRuns ?? [])].slice(0, 50);
    }

    const bucketStart = getBucketStart(payload.lastCheckedAt, statusGranularity);
    if (!bucketStart) return existingRuns ?? [];

    const nextRuns = [...(existingRuns ?? [])];
    const bucketIndex = nextRuns.findIndex(
        (run) => run.bucket_start === bucketStart,
    );

    if (bucketIndex >= 0) {
        const currentBucket = nextRuns[bucketIndex];
        const currentCount = Number(currentBucket.check_count ?? 0);
        const nextCount = currentCount + 1;
        const currentAverage = Number(currentBucket.avg_response_time_ms ?? 0);
        const nextAverage = Math.round(
            (currentAverage * currentCount +
                Number(payload.responseTimeMs ?? 0)) /
                nextCount,
        );

        nextRuns[bucketIndex] = {
            ...currentBucket,
            avg_response_time_ms: nextAverage,
            check_count: nextCount,
            up_count:
                Number(currentBucket.up_count ?? 0) +
                (payload.status === "up" ? 1 : 0),
            down_count:
                Number(currentBucket.down_count ?? 0) +
                (payload.status === "down" ? 1 : 0),
            latest_checked_at: payload.lastCheckedAt ?? bucketStart,
        };
    } else {
        nextRuns.push({
            bucket_start: bucketStart,
            avg_response_time_ms: Number(payload.responseTimeMs ?? 0),
            check_count: 1,
            up_count: payload.status === "up" ? 1 : 0,
            down_count: payload.status === "down" ? 1 : 0,
            latest_checked_at: payload.lastCheckedAt ?? bucketStart,
        });
    }

    return clampRunsToRange(
        nextRuns.sort(
            (left, right) =>
                toTimeMs(left.bucket_start) - toTimeMs(right.bucket_start),
        ),
        statusRangeDays,
    );
}

interface SparklinePoint {
    latency: number;
    checkedAt: string | null | undefined;
    checkCount: number;
    upCount: number;
    downCount: number;
}

type HoveredSparklinePoint = SparklinePoint & { x: number; y: number };

interface LatencySparklineProps {
    runs: RunPoint[];
    granularity: StatsGranularity;
    statusViewMode: StatsMode;
}

function LatencySparkline({
    runs,
    granularity,
    statusViewMode,
}: LatencySparklineProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [hoveredPoint, setHoveredPoint] =
        useState<HoveredSparklinePoint | null>(null);

    const points = useMemo((): SparklinePoint[] => {
        return (runs ?? [])
            .map((run) => ({
                latency:
                    Number(
                        run.avg_response_time_ms ?? run.response_time_ms,
                    ) || 0,
                checkedAt:
                    run.bucket_start ??
                    run.checked_at ??
                    run.latest_checked_at,
                checkCount: Number(run.check_count ?? 1) || 1,
                upCount: Number(run.up_count ?? 0) || 0,
                downCount: Number(run.down_count ?? 0) || 0,
            }))
            .sort(
                (left, right) =>
                    toTimeMs(left.checkedAt) - toTimeMs(right.checkedAt),
            )
            .map((run) => ({
                ...run,
            }));
    }, [runs]);

    if (!points.length)
        return (
            <p className="text-xs text-slate-500">No latency samples yet.</p>
        );

    const width = 320;
    const height = 72;
    const padding = 6;
    const yAxisWidth = 34;
    const chartLeft = yAxisWidth + padding;
    const chartRight = width - padding;

    const latencies = points.map((point) => point.latency);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const range = Math.max(max - min, 1);
    const xStep =
        points.length > 1 ? (chartRight - chartLeft) / (points.length - 1) : 0;

    const tickCount = 4;
    const yTicks = Array.from({ length: tickCount }, (_, index) => {
        const ratio = index / (tickCount - 1);
        const value = Math.round(max - ratio * (max - min));
        const y = padding + ratio * (height - padding * 2);
        return { value, y };
    });

    const plottedPoints = points.map((point, index) => {
        const x = chartLeft + xStep * index;
        const y =
            height -
            padding -
            ((point.latency - min) / range) * (height - padding * 2);
        return { ...point, x, y };
    });

    const line = plottedPoints
        .map((point) => `${point.x},${point.y}`)
        .join(" ");
    const area = `${line} ${chartRight},${height - padding} ${chartLeft},${height - padding}`;

    const handlePointHover = (
        event: ReactMouseEvent<SVGCircleElement>,
        point: SparklinePoint & { x: number; y: number },
    ) => {
        if (!containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const targetRect = event.currentTarget.getBoundingClientRect();

        setHoveredPoint({
            ...point,
            x: targetRect.left - containerRect.left + targetRect.width / 2,
            y: targetRect.top - containerRect.top,
        });
    };

    return (
        <div ref={containerRef} className="relative">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="h-20 w-full overflow-visible"
            >
                <defs>
                    <linearGradient
                        id="latencyFill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0%"
                            stopColor="#0f766e"
                            stopOpacity="0.35"
                        />
                        <stop
                            offset="100%"
                            stopColor="#0f766e"
                            stopOpacity="0.02"
                        />
                    </linearGradient>
                </defs>
                {yTicks.map((tick) => (
                    <g key={tick.y}>
                        <line
                            x1={chartLeft}
                            y1={tick.y}
                            x2={chartRight}
                            y2={tick.y}
                            stroke="#cbd5e1"
                            strokeOpacity="0.65"
                            strokeWidth="1"
                        />
                        <text
                            x={yAxisWidth - 2}
                            y={tick.y + 3}
                            textAnchor="end"
                            fontSize="9"
                            fill="#64748b"
                        >
                            {tick.value}
                        </text>
                    </g>
                ))}
                <line
                    x1={chartLeft}
                    y1={padding}
                    x2={chartLeft}
                    y2={height - padding}
                    stroke="#94a3b8"
                    strokeWidth="1"
                />
                <polygon points={area} fill="url(#latencyFill)" />
                <polyline
                    points={line}
                    fill="none"
                    stroke="#0f766e"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {plottedPoints.map((point, index) => (
                    <circle
                        key={`${point.checkedAt ?? "unknown"}-${index}`}
                        cx={point.x}
                        cy={point.y}
                        r="3.2"
                        fill="#0f766e"
                        className="cursor-pointer transition hover:r-5"
                        onMouseEnter={(event) => handlePointHover(event, point)}
                        onMouseLeave={() => setHoveredPoint(null)}
                    />
                ))}
            </svg>
            {hoveredPoint && (
                <div
                    className="pointer-events-none absolute z-20 min-w-44 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur"
                    style={{
                        left: `${hoveredPoint.x}px`,
                        top: `${hoveredPoint.y - 10}px`,
                        transform: "translate(-50%, -100%)",
                    }}
                >
                    <p className="font-semibold text-slate-900">
                        {hoveredPoint.latency} ms
                    </p>
                    <p className="mt-0.5 text-slate-600">
                        {statusViewMode === "raw"
                            ? "Triggered"
                            : granularity === "minute"
                              ? "Minute bucket"
                              : granularity === "hour"
                                ? "Hour bucket"
                                : "Day bucket"}
                        :{" "}
                        {formatFriendlyDateTime(hoveredPoint.checkedAt)}
                    </p>
                    {statusViewMode === "raw" ? null : (
                        <p className="mt-0.5 text-slate-600">
                            Checks: {hoveredPoint.checkCount}
                        </p>
                    )}
                </div>
            )}
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                <span>{min}ms min</span>
                <span>{max}ms max</span>
            </div>
        </div>
    );
}

// ===========================================================================
// Infrastructure metrics page (Part C). Self-contained: MetricsPage owns its
// own data loading and 30s polling; child charts refetch when the range or the
// poll tick changes.
// ===========================================================================

interface MetricRangeOption {
    key: string;
    label: string;
    granularity: MetricGranularity;
    // range_days may be fractional for sub-day windows (server computes a
    // now - range_days*86400s cutoff).
    rangeDays: number;
    // Custom absolute window (YYYY-MM-DD). When set these override rangeDays and
    // are forwarded to the server as from/to; `custom` flags the active state so
    // charts can show a range-specific empty message.
    from?: string;
    to?: string;
    custom?: boolean;
    // Aggregation ("group by") applied server-side; threaded to every chart.
    agg?: MetricAgg;
}

const METRIC_GRANULARITY_OPTIONS: Array<{
    value: MetricGranularity;
    label: string;
    // Max window span (days) this granularity is allowed to cover (server caps).
    maxDays: number;
}> = [
    { value: "minute", label: "Minute", maxDays: 7 },
    { value: "hour", label: "Hourly", maxDays: 30 },
    { value: "day", label: "Daily", maxDays: 90 },
];

const METRIC_AGG_OPTIONS: Array<{ value: MetricAgg; label: string }> = [
    { value: "avg", label: "Avg" },
    { value: "sum", label: "Sum" },
    { value: "count", label: "Count" },
    { value: "max", label: "Max" },
    { value: "p95", label: "p95" },
    { value: "p99", label: "p99" },
];

// Count returns plain sample counts, so charts drop % / byte units and
// reference lines for that aggregate.
function isCountAgg(agg: MetricAgg | undefined): boolean {
    return agg === "count";
}

function aggLabel(agg: MetricAgg | undefined): string {
    return (
        METRIC_AGG_OPTIONS.find((option) => option.value === (agg ?? "avg"))
            ?.label ?? "Avg"
    );
}

const METRIC_RANGE_OPTIONS: MetricRangeOption[] = [
    { key: "1h", label: "1h", granularity: "minute", rangeDays: 1 / 24 },
    { key: "6h", label: "6h", granularity: "minute", rangeDays: 6 / 24 },
    { key: "24h", label: "24h", granularity: "minute", rangeDays: 1 },
    { key: "7d", label: "7d", granularity: "hour", rangeDays: 7 },
    { key: "30d", label: "30d", granularity: "day", rangeDays: 30 },
    { key: "90d", label: "90d", granularity: "day", rangeDays: 90 },
];

const METRIC_CUSTOM_MAX_DAYS = 90;

// Parse a YYYY-MM-DD control value as a UTC instant (start-of-day).
function customDateMs(value: string, endOfDay = false): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    return new Date(
        `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
    ).getTime();
}

// Span in days between two YYYY-MM-DD values (to is treated as end-of-day so a
// single-day selection spans ~1 day).
function customSpanDays(from: string, to: string): number {
    const fromMs = customDateMs(from);
    const toMs = customDateMs(to, true);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return NaN;
    return (toMs - fromMs) / (24 * 60 * 60 * 1000);
}

// Auto-select granularity from the span, staying within the server caps
// (minute ≤ 7d, hour ≤ 30d, day ≤ 90d): minute up to 2 days, hour up to
// 30 days, day beyond.
function customGranularityFor(span: number): MetricGranularity {
    if (!Number.isFinite(span) || span <= 2) return "minute";
    if (span <= 30) return "hour";
    return "day";
}

// Compact label for a custom range pill, e.g. "Jul 1 – Jul 7".
function formatCustomRangeLabel(from: string, to: string): string {
    const fmt = (value: string) => {
        const ms = customDateMs(value);
        if (Number.isNaN(ms)) return value;
        return new Date(ms).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
        });
    };
    return `${fmt(from)} – ${fmt(to)}`;
}

// Today (UTC) as YYYY-MM-DD; used for future-date guards and the max attr.
function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

const ALERT_SCOPE_OPTIONS: Array<{ value: AlertScope; label: string }> = [
    { value: "node", label: "Node" },
    { value: "service", label: "Service" },
    { value: "container", label: "Container" },
];

const ALERT_METRIC_OPTIONS: Array<{ value: MetricKind; label: string }> = [
    { value: "cpu", label: "CPU %" },
    { value: "memory", label: "Memory %" },
];

const ALERT_OPERATOR_OPTIONS: Array<{ value: AlertOperator; label: string }> = [
    { value: ">", label: ">" },
    { value: ">=", label: "≥" },
    { value: "<", label: "<" },
    { value: "<=", label: "≤" },
];

interface MetricChartHover {
    x: number;
    y: number;
    valueLabel: string;
    value2Label?: string;
    timeLabel: string;
}

// Reusable inline-SVG chart generalized from LatencySparkline: line + area
// fill, an optional dashed horizontal reference line (allotted quota/limit),
// an optional second series (e.g. net rx/tx), and a hover tooltip. No chart
// library. Accessors keep it agnostic to the point shape.
function MetricChart<P>({
    points,
    getValue,
    getTime,
    getValue2,
    color = "#0f766e",
    color2 = "#0284c7",
    seriesLabel,
    series2Label,
    referenceValue = null,
    referenceLabel,
    valueFormatter = (value: number) => `${Math.round(value)}`,
    height = 96,
    compact = false,
    emptyLabel = "No samples yet.",
}: {
    points: P[];
    getValue: (point: P) => number;
    getTime: (point: P) => string | null | undefined;
    getValue2?: (point: P) => number;
    color?: string;
    color2?: string;
    seriesLabel?: string;
    series2Label?: string;
    referenceValue?: number | null;
    referenceLabel?: string;
    valueFormatter?: (value: number) => string;
    height?: number;
    compact?: boolean;
    emptyLabel?: string;
}) {
    const gradientId = useId();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [hovered, setHovered] = useState<MetricChartHover | null>(null);

    const series = useMemo(() => {
        return (points ?? [])
            .map((point) => ({
                value: Number(getValue(point)) || 0,
                value2: getValue2 ? Number(getValue2(point)) || 0 : null,
                time: getTime(point),
            }))
            .sort((left, right) => toTimeMs(left.time) - toTimeMs(right.time));
    }, [points, getValue, getValue2, getTime]);

    if (!series.length) {
        return <p className="text-xs text-slate-500">{emptyLabel}</p>;
    }

    const width = 320;
    const padding = 6;
    const yAxisWidth = compact ? 0 : 46;
    const chartLeft = yAxisWidth + padding;
    const chartRight = width - padding;

    const hasRef =
        referenceValue != null &&
        Number.isFinite(referenceValue) &&
        (referenceValue as number) > 0;
    const allValues = series.flatMap((point) =>
        point.value2 != null ? [point.value, point.value2] : [point.value],
    );
    const maxCandidate = Math.max(
        ...allValues,
        hasRef ? (referenceValue as number) : 0,
    );
    const max = maxCandidate > 0 ? maxCandidate * 1.08 : 1;
    const min = 0;
    const range = Math.max(max - min, 1e-9);
    const xStep =
        series.length > 1 ? (chartRight - chartLeft) / (series.length - 1) : 0;

    const yFor = (value: number) =>
        height - padding - ((value - min) / range) * (height - padding * 2);

    const tickCount = 4;
    const yTicks = compact
        ? []
        : Array.from({ length: tickCount }, (_, index) => {
              const ratio = index / (tickCount - 1);
              const value = max - ratio * (max - min);
              return { value, y: padding + ratio * (height - padding * 2) };
          });

    const plotted = series.map((point, index) => ({
        ...point,
        x: chartLeft + xStep * index,
        y: yFor(point.value),
        y2: point.value2 != null ? yFor(point.value2) : null,
    }));

    const line = plotted.map((point) => `${point.x},${point.y}`).join(" ");
    const line2 =
        getValue2 != null
            ? plotted
                  .map((point) => `${point.x},${point.y2 ?? point.y}`)
                  .join(" ")
            : "";
    const area = `${line} ${chartRight},${height - padding} ${chartLeft},${height - padding}`;
    const refY = hasRef ? yFor(referenceValue as number) : 0;

    const handleHover = (
        event: ReactMouseEvent<SVGCircleElement>,
        point: (typeof plotted)[number],
    ) => {
        if (!containerRef.current) return;
        const containerRect = containerRef.current.getBoundingClientRect();
        const targetRect = event.currentTarget.getBoundingClientRect();
        setHovered({
            x: targetRect.left - containerRect.left + targetRect.width / 2,
            y: targetRect.top - containerRect.top,
            valueLabel: `${seriesLabel ? `${seriesLabel}: ` : ""}${valueFormatter(point.value)}`,
            value2Label:
                point.value2 != null
                    ? `${series2Label ? `${series2Label}: ` : ""}${valueFormatter(point.value2)}`
                    : undefined,
            timeLabel: formatFriendlyDateTime(point.time),
        });
    };

    return (
        <div ref={containerRef} className="relative">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="w-full overflow-visible"
                style={{ height }}
            >
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                        <stop
                            offset="100%"
                            stopColor={color}
                            stopOpacity="0.02"
                        />
                    </linearGradient>
                </defs>
                {yTicks.map((tick) => (
                    <g key={tick.y}>
                        <line
                            x1={chartLeft}
                            y1={tick.y}
                            x2={chartRight}
                            y2={tick.y}
                            stroke="#cbd5e1"
                            strokeOpacity="0.6"
                            strokeWidth="1"
                        />
                        <text
                            x={yAxisWidth - 3}
                            y={tick.y + 3}
                            textAnchor="end"
                            fontSize="9"
                            fill="#64748b"
                        >
                            {valueFormatter(tick.value)}
                        </text>
                    </g>
                ))}
                {!compact && (
                    <line
                        x1={chartLeft}
                        y1={padding}
                        x2={chartLeft}
                        y2={height - padding}
                        stroke="#94a3b8"
                        strokeWidth="1"
                    />
                )}
                <polygon points={area} fill={`url(#${gradientId})`} />
                <polyline
                    points={line}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {line2 && (
                    <polyline
                        points={line2}
                        fill="none"
                        stroke={color2}
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                )}
                {hasRef && (
                    <>
                        <line
                            x1={chartLeft}
                            y1={refY}
                            x2={chartRight}
                            y2={refY}
                            stroke="#f43f5e"
                            strokeWidth="1.25"
                            strokeDasharray="5 4"
                        />
                        {!compact && referenceLabel && (
                            <text
                                x={chartRight}
                                // Sit clearly above the dashed line; if the line
                                // hugs the top edge, drop the label just below it
                                // instead so the two never overlap.
                                y={
                                    refY - 5 >= padding + 8
                                        ? refY - 5
                                        : refY + 11
                                }
                                textAnchor="end"
                                fontSize="9"
                                fill="#e11d48"
                            >
                                {referenceLabel}
                            </text>
                        )}
                    </>
                )}
                {!compact &&
                    plotted.map((point, index) => (
                        <circle
                            key={`${point.time ?? "t"}-${index}`}
                            cx={point.x}
                            cy={point.y}
                            r="3"
                            fill={color}
                            className="cursor-pointer"
                            onMouseEnter={(event) => handleHover(event, point)}
                            onMouseLeave={() => setHovered(null)}
                        />
                    ))}
            </svg>
            {hovered && (
                <div
                    className="pointer-events-none absolute z-20 min-w-40 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur"
                    style={{
                        left: `${hovered.x}px`,
                        top: `${hovered.y - 10}px`,
                        transform: "translate(-50%, -100%)",
                    }}
                >
                    <p className="font-semibold text-slate-900">
                        {hovered.valueLabel}
                    </p>
                    {hovered.value2Label && (
                        <p className="mt-0.5 font-semibold text-sky-700">
                            {hovered.value2Label}
                        </p>
                    )}
                    <p className="mt-0.5 text-slate-600">{hovered.timeLabel}</p>
                </div>
            )}
        </div>
    );
}

function ChartLabel({ children }: { children: ReactNode }) {
    return (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {children}
        </p>
    );
}

// Per-VM card: current CPU/mem readouts plus CPU% and memory timeseries charts
// (memory carries a dashed mem_total reference line). Clicking filters the
// services table below to this node.
function NodeCard({
    node,
    range,
    refreshKey,
    selected,
    onSelect,
}: {
    node: MetricNode;
    range: MetricRangeOption;
    refreshKey: number;
    selected: boolean;
    onSelect: () => void;
}) {
    const [cpu, setCpu] = useState<MetricTimeseriesResponse | null>(null);
    const [mem, setMem] = useState<MetricTimeseriesResponse | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [cpuRes, memRes] = await Promise.all([
                    monitoringService.getNodeTimeseries(node.node_key, {
                        metric: "cpu",
                        granularity: range.granularity,
                        rangeDays: range.rangeDays,
                        from: range.from,
                        to: range.to,
                        agg: range.agg,
                    }),
                    monitoringService.getNodeTimeseries(node.node_key, {
                        metric: "memory",
                        granularity: range.granularity,
                        rangeDays: range.rangeDays,
                        from: range.from,
                        to: range.to,
                        agg: range.agg,
                    }),
                ]);
                if (cancelled) return;
                setCpu(cpuRes);
                setMem(memRes);
            } catch {
                if (!cancelled) {
                    setCpu(null);
                    setMem(null);
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [
        node.node_key,
        range.granularity,
        range.rangeDays,
        range.from,
        range.to,
        range.agg,
        refreshKey,
    ]);

    const emptyLabel = range.custom ? "No data in this range." : undefined;
    const countAgg = isCountAgg(range.agg);
    const aggHint = aggLabel(range.agg);

    const memTotalRef =
        mem?.node?.mem_total_bytes ?? node.mem_total_bytes ?? 0;

    return (
        <button
            type="button"
            onClick={onSelect}
            className={`glass-card flex flex-col gap-3 rounded-2xl p-5 text-left transition ${
                selected
                    ? "ring-2 ring-sky-400"
                    : "hover:ring-1 hover:ring-slate-300"
            }`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">
                        {node.hostname || node.node_key}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                        {node.cpu_cores} cores ·{" "}
                        {formatBytes(node.mem_total_bytes)} ·{" "}
                        {node.container_count} containers
                    </p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                    {formatRelativeTime(node.last_seen)}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-white/60 bg-white/50 p-2">
                    <p className="text-slate-500">CPU</p>
                    <p className="text-base font-semibold text-slate-800">
                        {formatPct(node.cpu_pct)}
                    </p>
                </div>
                <div className="rounded-lg border border-white/60 bg-white/50 p-2">
                    <p className="text-slate-500">Memory</p>
                    <p className="text-base font-semibold text-slate-800">
                        {formatPct(node.mem_pct)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                        {formatBytes(node.mem_used_bytes)} /{" "}
                        {formatBytes(node.mem_total_bytes)}
                    </p>
                </div>
            </div>

            <div>
                <ChartLabel>{countAgg ? "CPU samples" : "CPU %"} · {aggHint}</ChartLabel>
                <MetricChart
                    points={cpu?.points ?? []}
                    getValue={(point) => Number(point.avg ?? 0)}
                    getTime={(point) => point.bucket_start}
                    color="#0284c7"
                    seriesLabel="CPU"
                    valueFormatter={(value) =>
                        countAgg
                            ? `${Math.round(value)}`
                            : `${Math.round(value)}%`
                    }
                    height={80}
                    emptyLabel={emptyLabel}
                />
            </div>
            <div>
                <ChartLabel>{countAgg ? "Memory samples" : "Memory"} · {aggHint}</ChartLabel>
                <MetricChart
                    points={mem?.points ?? []}
                    getValue={(point) => Number(point.avg_bytes ?? 0)}
                    getTime={(point) => point.bucket_start}
                    color="#0f766e"
                    seriesLabel="Mem"
                    referenceValue={countAgg ? null : memTotalRef}
                    referenceLabel="total"
                    valueFormatter={(value) =>
                        countAgg ? `${Math.round(value)}` : formatBytes(value)
                    }
                    height={80}
                    emptyLabel={emptyLabel}
                />
            </div>
        </button>
    );
}

// A compact CPU or memory sparkline for a services-table row.
function ServiceSparkline({
    serviceName,
    metric = "cpu",
    range,
    refreshKey,
}: {
    serviceName: string;
    metric?: MetricKind;
    range: MetricRangeOption;
    refreshKey: number;
}) {
    const [data, setData] = useState<MetricTimeseriesResponse | null>(null);

    useEffect(() => {
        let cancelled = false;
        monitoringService
            .getServiceTimeseries(serviceName, {
                metric,
                granularity: range.granularity,
                rangeDays: range.rangeDays,
                from: range.from,
                to: range.to,
                agg: range.agg,
            })
            .then((res) => {
                if (!cancelled) setData(res);
            })
            .catch(() => {
                if (!cancelled) setData(null);
            });
        return () => {
            cancelled = true;
        };
    }, [
        serviceName,
        metric,
        range.granularity,
        range.rangeDays,
        range.from,
        range.to,
        range.agg,
        refreshKey,
    ]);

    const countAgg = isCountAgg(range.agg);
    const isMemory = metric === "memory";
    return (
        <div className="w-40">
            <MetricChart
                points={data?.points ?? []}
                getValue={(point) =>
                    isMemory
                        ? Number(point.avg_bytes ?? 0)
                        : Number(point.avg ?? 0)
                }
                getTime={(point) => point.bucket_start}
                color={isMemory ? "#0f766e" : "#0284c7"}
                seriesLabel={isMemory ? "Mem" : "CPU"}
                valueFormatter={(value) =>
                    countAgg
                        ? `${Math.round(value)}`
                        : isMemory
                          ? formatBytes(value)
                          : `${Math.round(value)}%`
                }
                height={36}
                compact
                emptyLabel="—"
            />
        </div>
    );
}

// Single-container drill-down: minute-level CPU (dashed quota line), memory
// (dashed limit line), and net rx/tx rate charts.
function ContainerDetail({
    container,
    range,
    refreshKey,
}: {
    container: MetricContainer;
    range: MetricRangeOption;
    refreshKey: number;
}) {
    const [cpu, setCpu] = useState<MetricTimeseriesResponse | null>(null);
    const [mem, setMem] = useState<MetricTimeseriesResponse | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [cpuRes, memRes] = await Promise.all([
                    monitoringService.getContainerTimeseries(
                        container.container_key,
                        {
                            metric: "cpu",
                            granularity: range.granularity,
                            rangeDays: range.rangeDays,
                            from: range.from,
                            to: range.to,
                            agg: range.agg,
                        },
                    ),
                    monitoringService.getContainerTimeseries(
                        container.container_key,
                        {
                            metric: "memory",
                            granularity: range.granularity,
                            rangeDays: range.rangeDays,
                            from: range.from,
                            to: range.to,
                            agg: range.agg,
                        },
                    ),
                ]);
                if (cancelled) return;
                setCpu(cpuRes);
                setMem(memRes);
            } catch {
                if (!cancelled) {
                    setCpu(null);
                    setMem(null);
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [
        container.container_key,
        range.granularity,
        range.rangeDays,
        range.from,
        range.to,
        range.agg,
        refreshKey,
    ]);

    const emptyLabel = range.custom ? "No data in this range." : undefined;
    const countAgg = isCountAgg(range.agg);
    const aggHint = aggLabel(range.agg);

    const cpuQuotaCores =
        cpu?.container?.cpu_quota_cores ?? container.cpu_quota_cores ?? null;
    // CPU values use docker-stats units (100 == one core); the quota reference
    // line is therefore cores * 100.
    const cpuQuotaRef =
        cpuQuotaCores != null && cpuQuotaCores > 0 ? cpuQuotaCores * 100 : null;
    const memLimit =
        mem?.container?.mem_limit_bytes ?? container.mem_limit_bytes ?? null;

    const latestCpu = cpu?.points?.[cpu.points.length - 1]?.avg ?? null;
    const latestMem =
        mem?.points?.[mem.points.length - 1]?.avg_bytes ??
        container.mem_used_bytes;

    const cpuUsedPct =
        cpuQuotaRef && latestCpu != null
            ? (Number(latestCpu) / cpuQuotaRef) * 100
            : null;
    const memUsedPct =
        memLimit && memLimit > 0 && latestMem != null
            ? (Number(latestMem) / memLimit) * 100
            : null;

    return (
        <div className="mt-3 grid gap-4 rounded-xl border border-white/60 bg-white/40 p-4 md:grid-cols-3">
            <div>
                <ChartLabel>
                    {countAgg ? "CPU (samples)" : "CPU (cores)"} · {aggHint}{" "}
                    {!countAgg && cpuQuotaCores != null && (
                        <span className="text-rose-500">
                            quota {cpuQuotaCores}
                        </span>
                    )}
                </ChartLabel>
                <MetricChart
                    points={cpu?.points ?? []}
                    getValue={(point) =>
                        countAgg
                            ? Number(point.avg ?? 0)
                            : Number(point.avg ?? 0) / 100
                    }
                    getTime={(point) => point.bucket_start}
                    color="#0284c7"
                    seriesLabel="CPU"
                    referenceValue={countAgg ? null : (cpuQuotaCores ?? null)}
                    referenceLabel="quota"
                    valueFormatter={(value) =>
                        countAgg
                            ? `${Math.round(value)}`
                            : `${Math.round(value * 100) / 100}`
                    }
                    height={96}
                    emptyLabel={emptyLabel}
                />
                {!countAgg && cpuUsedPct != null && (
                    <p className="mt-1 text-[11px] text-slate-500">
                        {formatPct(cpuUsedPct)} of quota
                    </p>
                )}
            </div>
            <div>
                <ChartLabel>
                    {countAgg ? "Memory (samples)" : "Memory"} · {aggHint}{" "}
                    {!countAgg && memLimit != null && (
                        <span className="text-rose-500">
                            limit {formatBytes(memLimit)}
                        </span>
                    )}
                </ChartLabel>
                <MetricChart
                    points={mem?.points ?? []}
                    getValue={(point) => Number(point.avg_bytes ?? 0)}
                    getTime={(point) => point.bucket_start}
                    color="#0f766e"
                    seriesLabel="Mem"
                    referenceValue={countAgg ? null : memLimit}
                    referenceLabel="limit"
                    valueFormatter={(value) =>
                        countAgg ? `${Math.round(value)}` : formatBytes(value)
                    }
                    height={96}
                    emptyLabel={emptyLabel}
                />
                {!countAgg && memUsedPct != null && (
                    <p className="mt-1 text-[11px] text-slate-500">
                        {formatPct(memUsedPct)} of limit
                    </p>
                )}
            </div>
            <div>
                <ChartLabel>
                    Network{" "}
                    <span className="text-teal-600">rx</span>
                    {" / "}
                    <span className="text-sky-600">tx</span>
                </ChartLabel>
                <NetRateChart points={cpu?.points ?? []} />
            </div>
        </div>
    );
}

// Net rx/tx rates share the container's timeseries points (net_rx_bps /
// net_tx_bps). Rendered via the same MetricChart with a second series.
function NetRateChart({ points }: { points: MetricTimeseriesPoint[] }) {
    const hasNet = (points ?? []).some(
        (point) => point.net_rx_bps != null || point.net_tx_bps != null,
    );
    if (!hasNet) {
        return <p className="text-xs text-slate-500">No network samples.</p>;
    }
    return (
        <MetricChart
            points={points}
            getValue={(point) => Number(point.net_rx_bps ?? 0)}
            getValue2={(point) => Number(point.net_tx_bps ?? 0)}
            getTime={(point) => point.bucket_start}
            color="#14b8a6"
            color2="#0284c7"
            seriesLabel="rx"
            series2Label="tx"
            valueFormatter={(value) => formatBytesRate(value)}
            height={96}
        />
    );
}

// Service-level drill-down shown at the top of an expanded services-table row.
// Mirrors ContainerDetail (same range/agg threading, same chart styling) but
// aggregated across replicas: CPU in cores with a dashed total-quota line and
// memory with a dashed total-limit line. No net chart — net counters are
// per-container only.
function ServiceDetail({
    service,
    range,
    refreshKey,
}: {
    service: MetricService;
    range: MetricRangeOption;
    refreshKey: number;
}) {
    const [cpu, setCpu] = useState<MetricTimeseriesResponse | null>(null);
    const [mem, setMem] = useState<MetricTimeseriesResponse | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [cpuRes, memRes] = await Promise.all([
                    monitoringService.getServiceTimeseries(
                        service.service_name,
                        {
                            metric: "cpu",
                            granularity: range.granularity,
                            rangeDays: range.rangeDays,
                            from: range.from,
                            to: range.to,
                            agg: range.agg,
                        },
                    ),
                    monitoringService.getServiceTimeseries(
                        service.service_name,
                        {
                            metric: "memory",
                            granularity: range.granularity,
                            rangeDays: range.rangeDays,
                            from: range.from,
                            to: range.to,
                            agg: range.agg,
                        },
                    ),
                ]);
                if (cancelled) return;
                setCpu(cpuRes);
                setMem(memRes);
            } catch {
                if (!cancelled) {
                    setCpu(null);
                    setMem(null);
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [
        service.service_name,
        range.granularity,
        range.rangeDays,
        range.from,
        range.to,
        range.agg,
        refreshKey,
    ]);

    const emptyLabel = range.custom ? "No data in this range." : undefined;
    const countAgg = isCountAgg(range.agg);
    const aggHint = aggLabel(range.agg);

    const quotaCores =
        cpu?.service?.total_quota_cores ?? service.total_quota_cores ?? null;
    // CPU values use docker-stats units (100 == one core); the quota reference
    // line is therefore cores * 100 in raw units.
    const quotaRaw = quotaCores != null && quotaCores > 0 ? quotaCores * 100 : null;
    const memLimit =
        mem?.service?.total_mem_limit_bytes ??
        service.total_mem_limit_bytes ??
        null;

    const latestCpu = cpu?.points?.[cpu.points.length - 1]?.avg ?? null;
    const latestMem =
        mem?.points?.[mem.points.length - 1]?.avg_bytes ??
        service.mem_used_bytes ??
        null;

    const cpuUsedPct =
        quotaRaw && latestCpu != null
            ? (Number(latestCpu) / quotaRaw) * 100
            : null;
    const memUsedPct =
        memLimit && memLimit > 0 && latestMem != null
            ? (Number(latestMem) / memLimit) * 100
            : null;

    return (
        <div className="glass-card mb-3 grid gap-4 rounded-xl border border-white/60 bg-white/40 p-4 md:grid-cols-2">
            <div>
                <ChartLabel>
                    {countAgg ? "Service CPU (samples)" : "Service CPU (cores)"}{" "}
                    · {aggHint}{" "}
                    {!countAgg && quotaCores != null && (
                        <span className="text-rose-500">quota {quotaCores}</span>
                    )}
                </ChartLabel>
                <MetricChart
                    points={cpu?.points ?? []}
                    getValue={(point) =>
                        countAgg
                            ? Number(point.avg ?? 0)
                            : Number(point.avg ?? 0) / 100
                    }
                    getTime={(point) => point.bucket_start}
                    color="#0284c7"
                    seriesLabel="CPU"
                    referenceValue={countAgg ? null : (quotaCores ?? null)}
                    referenceLabel="quota"
                    valueFormatter={(value) =>
                        countAgg
                            ? `${Math.round(value)}`
                            : `${Math.round(value * 100) / 100}`
                    }
                    height={96}
                    emptyLabel={emptyLabel}
                />
                {!countAgg && cpuUsedPct != null && (
                    <p className="mt-1 text-[11px] text-slate-500">
                        {formatPct(cpuUsedPct)} of quota
                    </p>
                )}
            </div>
            <div>
                <ChartLabel>
                    {countAgg ? "Service memory (samples)" : "Service memory"} ·{" "}
                    {aggHint}{" "}
                    {!countAgg && memLimit != null && (
                        <span className="text-rose-500">
                            limit {formatBytes(memLimit)}
                        </span>
                    )}
                </ChartLabel>
                <MetricChart
                    points={mem?.points ?? []}
                    getValue={(point) => Number(point.avg_bytes ?? 0)}
                    getTime={(point) => point.bucket_start}
                    color="#0f766e"
                    seriesLabel="Mem"
                    referenceValue={countAgg ? null : memLimit}
                    referenceLabel="limit"
                    valueFormatter={(value) =>
                        countAgg ? `${Math.round(value)}` : formatBytes(value)
                    }
                    height={96}
                    emptyLabel={emptyLabel}
                />
                {!countAgg && memUsedPct != null && (
                    <p className="mt-1 text-[11px] text-slate-500">
                        {formatPct(memUsedPct)} of limit
                    </p>
                )}
            </div>
        </div>
    );
}

// Expandable services table used by both tabs. Row → service detail charts +
// per-replica rows; replica → ContainerDetail.
function ServicesTable({
    services,
    range,
    refreshKey,
    emptyLabel,
}: {
    services: MetricService[];
    range: MetricRangeOption;
    refreshKey: number;
    emptyLabel: string;
}) {
    const [expanded, setExpanded] = useState<string | null>(null);
    const [containers, setContainers] = useState<
        Record<string, MetricContainer[]>
    >({});
    const [selectedContainer, setSelectedContainer] = useState<string | null>(
        null,
    );

    const toggleService = useCallback(
        async (serviceName: string) => {
            setSelectedContainer(null);
            if (expanded === serviceName) {
                setExpanded(null);
                return;
            }
            setExpanded(serviceName);
            if (!containers[serviceName]) {
                try {
                    const rows =
                        await monitoringService.getServiceContainers(
                            serviceName,
                        );
                    setContainers((prev) => ({
                        ...prev,
                        [serviceName]: Array.isArray(rows) ? rows : [],
                    }));
                } catch {
                    setContainers((prev) => ({ ...prev, [serviceName]: [] }));
                }
            }
        },
        [expanded, containers],
    );

    if (!services.length) {
        return (
            <p className="rounded-xl border border-white/60 bg-white/40 px-4 py-6 text-center text-sm text-slate-500">
                {emptyLabel}
            </p>
        );
    }

    return (
        <div className="overflow-x-auto rounded-xl border border-white/60 bg-white/40">
            <table className="min-w-full text-left text-sm">
                <thead>
                    <tr className="border-b border-white/60 text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3">Service</th>
                        <th className="px-4 py-3">Replicas</th>
                        <th className="px-4 py-3">Nodes</th>
                        <th className="px-4 py-3">CPU</th>
                        <th className="px-4 py-3">Memory</th>
                        <th className="hidden px-4 py-3 lg:table-cell">
                            CPU trend
                        </th>
                        <th className="hidden px-4 py-3 lg:table-cell">
                            Memory trend
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {services.map((service) => {
                        const isOpen = expanded === service.service_name;
                        const quotaPct =
                            service.total_quota_cores &&
                            service.total_quota_cores > 0
                                ? (service.cpu_pct_total ?? 0) /
                                  service.total_quota_cores
                                : null;
                        const memPct =
                            service.mem_used_bytes != null &&
                            service.total_mem_limit_bytes &&
                            service.total_mem_limit_bytes > 0
                                ? (service.mem_used_bytes /
                                      service.total_mem_limit_bytes) *
                                  100
                                : null;
                        const rows = containers[service.service_name] ?? [];
                        return (
                            <Fragment key={service.service_name}>
                                <tr
                                    onClick={() =>
                                        void toggleService(
                                            service.service_name,
                                        )
                                    }
                                    className="cursor-pointer border-b border-white/40 transition hover:bg-white/50"
                                >
                                    <td className="px-4 py-3 font-medium text-slate-800">
                                        <span className="inline-flex items-center gap-2">
                                            {isOpen ? (
                                                <FaChevronDown className="text-xs text-slate-400" />
                                            ) : (
                                                <FaChevronRight className="text-xs text-slate-400" />
                                            )}
                                            {service.service_name}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {service.container_count}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {service.node_count}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {formatCores(service.cpu_pct_total ?? 0)}
                                        {quotaPct != null && (
                                            <span className="ml-1 text-xs text-slate-400">
                                                ({formatPct(quotaPct)})
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {formatBytes(
                                            service.mem_used_bytes ?? 0,
                                        )}
                                        {memPct != null && (
                                            <span className="ml-1 text-xs text-slate-400">
                                                ({formatPct(memPct)})
                                            </span>
                                        )}
                                    </td>
                                    <td className="hidden px-4 py-3 lg:table-cell">
                                        <ServiceSparkline
                                            serviceName={service.service_name}
                                            metric="cpu"
                                            range={range}
                                            refreshKey={refreshKey}
                                        />
                                    </td>
                                    <td className="hidden px-4 py-3 lg:table-cell">
                                        <ServiceSparkline
                                            serviceName={service.service_name}
                                            metric="memory"
                                            range={range}
                                            refreshKey={refreshKey}
                                        />
                                    </td>
                                </tr>
                                {isOpen && (
                                    <tr className="border-b border-white/40 bg-white/30">
                                        <td colSpan={7} className="px-4 py-3">
                                            <ServiceDetail
                                                service={service}
                                                range={range}
                                                refreshKey={refreshKey}
                                            />
                                            {rows.length === 0 ? (
                                                <p className="text-xs text-slate-500">
                                                    No replicas reporting.
                                                </p>
                                            ) : (
                                                <div className="flex flex-col gap-1">
                                                    {rows.map((replica) => {
                                                        const active =
                                                            selectedContainer ===
                                                            replica.container_key;
                                                        return (
                                                            <div
                                                                key={
                                                                    replica.container_key
                                                                }
                                                            >
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setSelectedContainer(
                                                                            active
                                                                                ? null
                                                                                : replica.container_key,
                                                                        )
                                                                    }
                                                                    className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-left text-xs transition ${
                                                                        active
                                                                            ? "bg-sky-50 ring-1 ring-sky-200"
                                                                            : "hover:bg-white/60"
                                                                    }`}
                                                                >
                                                                    <span className="font-medium text-slate-700">
                                                                        {replica.task_name ||
                                                                            replica.container_key}
                                                                    </span>
                                                                    <span className="text-slate-500">
                                                                        {replica.hostname ||
                                                                            replica.node_key}
                                                                    </span>
                                                                    <span className="text-slate-500">
                                                                        CPU{" "}
                                                                        {formatCores(
                                                                            replica.cpu_pct,
                                                                        )}
                                                                    </span>
                                                                    <span className="text-slate-500">
                                                                        Mem{" "}
                                                                        {formatBytes(
                                                                            replica.mem_used_bytes,
                                                                        )}
                                                                    </span>
                                                                </button>
                                                                {active && (
                                                                    <ContainerDetail
                                                                        container={
                                                                            replica
                                                                        }
                                                                        range={
                                                                            range
                                                                        }
                                                                        refreshKey={
                                                                            refreshKey
                                                                        }
                                                                    />
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

interface AlertRuleFormState {
    scope: AlertScope;
    target_key: string;
    metric: MetricKind;
    operator: AlertOperator;
    threshold_pct: string;
    sustained_minutes: string;
    cooldown_minutes: string;
    enabled: boolean;
}

const INITIAL_ALERT_FORM: AlertRuleFormState = {
    scope: "node",
    target_key: "",
    metric: "cpu",
    operator: ">",
    threshold_pct: "80",
    sustained_minutes: "5",
    cooldown_minutes: "30",
    enabled: true,
};

function AlertRulesPanel({
    canEdit,
    overview,
}: {
    canEdit: boolean;
    overview: MetricsOverview | null;
}) {
    const [rules, setRules] = useState<MetricAlertRule[]>([]);
    const [form, setForm] = useState<AlertRuleFormState>(INITIAL_ALERT_FORM);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [error, setError] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    const loadRules = useCallback(async () => {
        try {
            const rows = await monitoringService.getAlertRules();
            setRules(Array.isArray(rows) ? rows : []);
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadRules();
    }, [loadRules]);

    const targetSuggestions = useMemo(() => {
        if (form.scope === "node") {
            return (overview?.nodes ?? []).map((node) => node.node_key);
        }
        if (form.scope === "service") {
            return (overview?.services ?? []).map(
                (service) => service.service_name,
            );
        }
        return [];
    }, [form.scope, overview]);

    const resetForm = () => {
        setForm(INITIAL_ALERT_FORM);
        setEditingId(null);
    };

    const startEdit = (rule: MetricAlertRule) => {
        setEditingId(rule.id);
        setForm({
            scope: rule.scope,
            target_key: rule.target_key ?? "",
            metric: rule.metric,
            operator: rule.operator,
            threshold_pct: String(rule.threshold_pct),
            sustained_minutes: String(rule.sustained_minutes),
            cooldown_minutes: String(rule.cooldown_minutes),
            enabled: rule.enabled,
        });
    };

    const handleSubmit = async (event: SubmitEvent) => {
        event.preventDefault();
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit alert rules");
            return;
        }
        const payload: MetricAlertRuleInput = {
            scope: form.scope,
            target_key: form.target_key.trim() ? form.target_key.trim() : null,
            metric: form.metric,
            operator: form.operator,
            threshold_pct: Number(form.threshold_pct),
            sustained_minutes: Number(form.sustained_minutes),
            cooldown_minutes: Number(form.cooldown_minutes),
            enabled: form.enabled,
        };
        setIsSaving(true);
        try {
            if (editingId != null) {
                const updated = await monitoringService.updateAlertRule(
                    editingId,
                    payload,
                );
                setRules((prev) =>
                    prev.map((rule) =>
                        rule.id === editingId ? updated : rule,
                    ),
                );
            } else {
                const created =
                    await monitoringService.createAlertRule(payload);
                setRules((prev) => [created, ...prev]);
            }
            resetForm();
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: number) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit alert rules");
            return;
        }
        if (!window.confirm("Delete this alert rule?")) return;
        try {
            await monitoringService.deleteAlertRule(id);
            setRules((prev) => prev.filter((rule) => rule.id !== id));
            if (editingId === id) resetForm();
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const operatorLabel = (operator: AlertOperator) =>
        ALERT_OPERATOR_OPTIONS.find((option) => option.value === operator)
            ?.label ?? operator;

    return (
        <section className="glass-card rounded-2xl p-5">
            <div className="flex items-center gap-2">
                <FaBell className="text-slate-500" />
                <h2 className="text-lg font-semibold text-slate-800">
                    Alert rules
                </h2>
            </div>

            {error && (
                <p className="mt-3 rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-2 text-sm text-rose-700">
                    {error}
                </p>
            )}

            <div className="mt-4 flex flex-col gap-2">
                {isLoading ? (
                    <p className="text-sm text-slate-500">Loading rules…</p>
                ) : rules.length === 0 ? (
                    <p className="text-sm text-slate-500">
                        No alert rules yet.
                    </p>
                ) : (
                    rules.map((rule) => (
                        <div
                            key={rule.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/60 bg-white/50 px-3 py-2 text-sm"
                        >
                            <div className="min-w-0">
                                <p className="font-medium text-slate-700">
                                    <span className="capitalize">
                                        {rule.scope}
                                    </span>{" "}
                                    {rule.target_key ? (
                                        <span className="text-slate-500">
                                            {rule.target_key}
                                        </span>
                                    ) : (
                                        <span className="text-slate-400">
                                            (all)
                                        </span>
                                    )}{" "}
                                    · {rule.metric}{" "}
                                    {operatorLabel(rule.operator)}{" "}
                                    {rule.threshold_pct}% for{" "}
                                    {rule.sustained_minutes}m
                                </p>
                                <p className="text-xs text-slate-500">
                                    cooldown {rule.cooldown_minutes}m ·{" "}
                                    {rule.enabled ? (
                                        <span className="text-emerald-600">
                                            enabled
                                        </span>
                                    ) : (
                                        <span className="text-slate-400">
                                            disabled
                                        </span>
                                    )}
                                </p>
                            </div>
                            {canEdit && (
                                <div className="flex shrink-0 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => startEdit(rule)}
                                        className="rounded-lg border border-white/60 bg-white/60 px-2 py-1 text-xs text-slate-600 hover:bg-white/80"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void handleDelete(rule.id)
                                        }
                                        className="rounded-lg border border-rose-200/70 bg-rose-50/70 px-2 py-1 text-xs text-rose-600 hover:bg-rose-100/80"
                                    >
                                        Delete
                                    </button>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {canEdit ? (
                <form
                    onSubmit={handleSubmit}
                    className="mt-4 grid gap-3 border-t border-white/50 pt-4 sm:grid-cols-2"
                >
                    <label className="text-xs font-medium text-slate-600">
                        Scope
                        <select
                            value={form.scope}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    scope: event.target.value as AlertScope,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        >
                            {ALERT_SCOPE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Target (blank = all in scope)
                        <input
                            list="metric-alert-targets"
                            value={form.target_key}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    target_key: event.target.value,
                                }))
                            }
                            placeholder="all in scope"
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        />
                        <datalist id="metric-alert-targets">
                            {targetSuggestions.map((suggestion) => (
                                <option key={suggestion} value={suggestion} />
                            ))}
                        </datalist>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Metric
                        <select
                            value={form.metric}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    metric: event.target.value as MetricKind,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        >
                            {ALERT_METRIC_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Operator
                        <select
                            value={form.operator}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    operator: event.target
                                        .value as AlertOperator,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        >
                            {ALERT_OPERATOR_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Threshold %
                        <input
                            type="number"
                            value={form.threshold_pct}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    threshold_pct: event.target.value,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Sustained minutes
                        <input
                            type="number"
                            value={form.sustained_minutes}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    sustained_minutes: event.target.value,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                        Cooldown minutes
                        <input
                            type="number"
                            value={form.cooldown_minutes}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    cooldown_minutes: event.target.value,
                                }))
                            }
                            className="mt-1 w-full rounded-lg border border-white/60 bg-white/70 px-2 py-1.5 text-sm text-slate-700"
                        />
                    </label>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600 sm:mt-6">
                        <input
                            type="checkbox"
                            checked={form.enabled}
                            onChange={(event) =>
                                setForm((prev) => ({
                                    ...prev,
                                    enabled: event.target.checked,
                                }))
                            }
                        />
                        Enabled
                    </label>
                    <div className="flex gap-2 sm:col-span-2">
                        <button
                            type="submit"
                            disabled={isSaving}
                            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
                        >
                            {editingId != null ? "Update rule" : "Create rule"}
                        </button>
                        {editingId != null && (
                            <button
                                type="button"
                                onClick={resetForm}
                                className="rounded-lg border border-white/60 bg-white/60 px-4 py-2 text-sm text-slate-600 hover:bg-white/80"
                            >
                                Cancel
                            </button>
                        )}
                    </div>
                </form>
            ) : (
                <p className="mt-4 border-t border-white/50 pt-4 text-xs text-slate-500">
                    You have read-only access to alert rules.
                </p>
            )}
        </section>
    );
}

function MetricsPage({ canEdit }: { canEdit: boolean }) {
    const [overview, setOverview] = useState<MetricsOverview | null>(null);
    const [nodeServices, setNodeServices] = useState<MetricService[]>([]);
    const [tab, setTab] = useState<"node" | "service">("node");
    // Defaults on load: last 7 days, hourly granularity, avg aggregation.
    const [rangeKey, setRangeKey] = useState("7d");
    const [granularity, setGranularity] = useState<MetricGranularity>("hour");
    const [agg, setAgg] = useState<MetricAgg>("avg");
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [showAlerts, setShowAlerts] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");

    // Custom date-range state. `customRange` (when set) is the applied window and
    // overrides the preset pills; `customOpen` toggles the picker popover and the
    // two inputs hold the in-progress selection.
    const [customOpen, setCustomOpen] = useState(false);
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");
    const [customRange, setCustomRange] = useState<{
        from: string;
        to: string;
    } | null>(null);

    const presetRange =
        METRIC_RANGE_OPTIONS.find((option) => option.key === rangeKey) ??
        METRIC_RANGE_OPTIONS[2];

    // Span (days) of the active window; drives which granularities are allowed.
    const activeSpanDays = customRange
        ? customSpanDays(customRange.from, customRange.to)
        : presetRange.rangeDays;

    // Active range threaded to the charts: the applied custom window when set,
    // otherwise the selected preset. Granularity/agg come from the user's
    // explicit selection rather than the preset mapping.
    const range: MetricRangeOption = useMemo(() => {
        if (!customRange) {
            return { ...presetRange, granularity, agg };
        }
        return {
            key: "custom",
            label: "Custom",
            granularity,
            rangeDays: 0,
            from: customRange.from,
            to: customRange.to,
            custom: true,
            agg,
        };
    }, [customRange, presetRange, granularity, agg]);

    // Live-editing (in-popover) span → derived granularity + validity.
    const draftSpan = customSpanDays(customFrom, customTo);
    const draftGranularity = customGranularityFor(draftSpan);
    const draftValid =
        Boolean(customFrom) &&
        Boolean(customTo) &&
        Number.isFinite(draftSpan) &&
        draftSpan > 0 &&
        draftSpan <= METRIC_CUSTOM_MAX_DAYS &&
        customDateMs(customFrom) <= Date.now();

    // Skip the 30s timeseries refresh when a custom range ending before today is
    // active (the window is historical and fixed). A `to` of today still polls.
    const pauseTimeseriesRefresh =
        customRange != null && customRange.to < todayUtc();

    const applyCustomRange = () => {
        if (!draftValid) return;
        setCustomRange({ from: customFrom, to: customTo });
        // Auto-suggest the granularity for the chosen span (user may override).
        setGranularity(draftGranularity);
        setCustomOpen(false);
    };

    // Clicking a preset clears any custom range and re-suggests that preset's
    // granularity (still user-overridable afterward).
    const selectPreset = (option: MetricRangeOption) => {
        setCustomRange(null);
        setCustomOpen(false);
        setRangeKey(option.key);
        setGranularity(option.granularity);
    };

    const clearCustomRange = () => {
        setCustomRange(null);
        setCustomOpen(false);
        setGranularity(presetRange.granularity);
    };

    const loadOverview = useCallback(async () => {
        try {
            const data = await monitoringService.getMetricsOverview();
            setOverview({
                nodes: Array.isArray(data?.nodes) ? data.nodes : [],
                services: Array.isArray(data?.services) ? data.services : [],
            });
            setError("");
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadOverview();
        const timer = setInterval(() => {
            void loadOverview();
            // Historical custom windows are fixed; don't re-fetch the charts.
            if (!pauseTimeseriesRefresh) {
                setRefreshKey((prev) => prev + 1);
            }
        }, 30000);
        return () => clearInterval(timer);
    }, [loadOverview, pauseTimeseriesRefresh]);

    // Filter the services table to the selected node (By Node tab).
    useEffect(() => {
        if (tab !== "node" || !selectedNode) {
            setNodeServices([]);
            return;
        }
        let cancelled = false;
        monitoringService
            .getNodeServices(selectedNode)
            .then((rows) => {
                if (!cancelled) setNodeServices(Array.isArray(rows) ? rows : []);
            })
            .catch(() => {
                if (!cancelled) setNodeServices([]);
            });
        return () => {
            cancelled = true;
        };
    }, [tab, selectedNode, refreshKey]);

    const nodes = overview?.nodes ?? [];
    const allServices = overview?.services ?? [];
    const tableServices =
        tab === "node" && selectedNode ? nodeServices : allServices;
    const isEmpty =
        !isLoading && nodes.length === 0 && allServices.length === 0;

    return (
        <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
                <header className="glass-card relative z-30 flex flex-wrap items-center justify-between gap-4 rounded-2xl p-6">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">
                            Infrastructure metrics
                        </h1>
                        <p className="mt-1 text-sm text-slate-500">
                            Container &amp; VM CPU, memory and network across the
                            swarm.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex rounded-lg border border-white/60 bg-white/50 p-0.5">
                            {METRIC_RANGE_OPTIONS.map((option) => (
                                <button
                                    key={option.key}
                                    type="button"
                                    onClick={() => selectPreset(option)}
                                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                        !customRange && rangeKey === option.key
                                            ? "bg-slate-900 text-white"
                                            : "text-slate-600 hover:bg-white/70"
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setCustomOpen((prev) => !prev)}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                                    customRange
                                        ? "border-slate-900 bg-slate-900 text-white"
                                        : "border-white/60 bg-white/50 text-slate-600 hover:bg-white/80"
                                }`}
                            >
                                <FaRegCalendarAlt className="text-[11px]" />
                                {customRange
                                    ? formatCustomRangeLabel(
                                          customRange.from,
                                          customRange.to,
                                      )
                                    : "Custom"}
                            </button>
                            {customOpen && (
                                <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-white/60 bg-white/95 p-4 shadow-xl backdrop-blur">
                                    <div className="flex flex-col gap-3">
                                        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                                            From
                                            <input
                                                type="date"
                                                value={customFrom}
                                                max={todayUtc()}
                                                onChange={(event) =>
                                                    setCustomFrom(
                                                        event.target.value,
                                                    )
                                                }
                                                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                                            To
                                            <input
                                                type="date"
                                                value={customTo}
                                                max={todayUtc()}
                                                onChange={(event) =>
                                                    setCustomTo(
                                                        event.target.value,
                                                    )
                                                }
                                                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800"
                                            />
                                        </label>
                                        <p className="text-[11px] text-slate-500">
                                            {draftValid
                                                ? `Granularity: ${draftGranularity}`
                                                : customFrom && customTo
                                                  ? "Invalid range (max 90 days, no future dates)."
                                                  : "Pick a start and end date."}
                                        </p>
                                        <div className="flex justify-end gap-2">
                                            {customRange && (
                                                <button
                                                    type="button"
                                                    onClick={clearCustomRange}
                                                    className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700"
                                                >
                                                    Clear
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={applyCustomRange}
                                                disabled={!draftValid}
                                                className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                Apply
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex rounded-lg border border-white/60 bg-white/50 p-0.5">
                            {METRIC_GRANULARITY_OPTIONS.map((option) => {
                                const disabled =
                                    activeSpanDays > option.maxDays;
                                return (
                                    <button
                                        key={option.value}
                                        type="button"
                                        disabled={disabled}
                                        title={
                                            disabled
                                                ? `Unavailable for spans over ${option.maxDays} days`
                                                : undefined
                                        }
                                        onClick={() =>
                                            setGranularity(option.value)
                                        }
                                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-30 ${
                                            granularity === option.value
                                                ? "bg-slate-900 text-white"
                                                : "text-slate-600 hover:bg-white/70"
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                        <select
                            value={agg}
                            onChange={(event) =>
                                setAgg(event.target.value as MetricAgg)
                            }
                            aria-label="Aggregation"
                            className="rounded-lg border border-white/60 bg-white/50 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-white/80"
                        >
                            {METRIC_AGG_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setShowAlerts((prev) => !prev)}
                            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                                showAlerts
                                    ? "border-sky-300 bg-sky-50 text-sky-700"
                                    : "border-white/60 bg-white/55 text-slate-600 hover:bg-white/80"
                            }`}
                        >
                            <FaBell /> Alerts
                        </button>
                    </div>
                </header>

                {error && (
                    <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
                        {error}
                    </p>
                )}

                {showAlerts && (
                    <AlertRulesPanel canEdit={canEdit} overview={overview} />
                )}

                {isLoading ? (
                    <p className="text-sm text-slate-500">Loading metrics…</p>
                ) : isEmpty ? (
                    <section className="glass-card rounded-2xl p-10 text-center">
                        <FaChartArea className="mx-auto text-3xl text-slate-300" />
                        <h2 className="mt-3 text-lg font-semibold text-slate-700">
                            No metrics received yet
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Deploy the sidecar collector to your swarm and
                            metrics will appear here within a minute.
                        </p>
                    </section>
                ) : (
                    <>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setTab("node");
                                }}
                                className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                                    tab === "node"
                                        ? "bg-slate-900 text-white"
                                        : "border border-white/60 bg-white/55 text-slate-600 hover:bg-white/80"
                                }`}
                            >
                                By Node
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setTab("service");
                                    setSelectedNode(null);
                                }}
                                className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                                    tab === "service"
                                        ? "bg-slate-900 text-white"
                                        : "border border-white/60 bg-white/55 text-slate-600 hover:bg-white/80"
                                }`}
                            >
                                By Service
                            </button>
                        </div>

                        {tab === "node" && (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {nodes.map((node) => (
                                    <NodeCard
                                        key={node.node_key}
                                        node={node}
                                        range={range}
                                        refreshKey={refreshKey}
                                        selected={
                                            selectedNode === node.node_key
                                        }
                                        onSelect={() =>
                                            setSelectedNode((prev) =>
                                                prev === node.node_key
                                                    ? null
                                                    : node.node_key,
                                            )
                                        }
                                    />
                                ))}
                            </div>
                        )}

                        <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-semibold text-slate-800">
                                    Services
                                    <span className="ml-2 rounded-full bg-slate-200/70 px-2 py-0.5 text-xs font-medium text-slate-600 align-middle">
                                        {tableServices.length}
                                    </span>
                                    {tab === "node" && selectedNode && (
                                        <span className="ml-2 text-sm font-normal text-slate-500">
                                            on{" "}
                                            {nodes.find(
                                                (node) =>
                                                    node.node_key ===
                                                    selectedNode,
                                            )?.hostname ?? selectedNode}
                                        </span>
                                    )}
                                </h2>
                                {tab === "node" && selectedNode && (
                                    <button
                                        type="button"
                                        onClick={() => setSelectedNode(null)}
                                        className="text-xs text-sky-600 hover:underline"
                                    >
                                        Clear filter
                                    </button>
                                )}
                            </div>
                            <ServicesTable
                                services={tableServices}
                                range={range}
                                refreshKey={refreshKey}
                                emptyLabel={
                                    tab === "node" && selectedNode
                                        ? "No services on this node."
                                        : "No services reporting yet."
                                }
                            />
                        </div>
                    </>
                )}
            </div>
        </main>
    );
}

interface StatusPageProps {
    groups: MonitorGroup[];
    endpoints: MonitorEndpoint[];
    runsByEndpoint: RunsByEndpoint;
    health: HealthSummary;
    isLoading: boolean;
    statusViewMode: StatsMode;
    statusGranularity: StatsGranularity;
    statusRangeDays: number;
    onViewModeChange: (mode: StatsMode) => void;
    onGranularityChange: (granularity: StatsGranularity) => void;
    onRangeChange: (days: number) => void;
    statusTab: StatusTab;
    onStatusTabChange: (tab: StatusTab) => void;
    crons: CronJob[];
    cronRunsByName: CronRunsByName;
    cronRunsMode: CronRunsMode;
    onCronRunsModeChange: (mode: CronRunsMode) => void;
    cronWindowDays: number;
    onCronWindowDaysChange: (days: number) => void;
    currentTimeMs: number;
}

function StatusPage({
    groups,
    endpoints,
    runsByEndpoint,
    health,
    isLoading,
    statusViewMode,
    statusGranularity,
    statusRangeDays,
    onViewModeChange,
    onGranularityChange,
    onRangeChange,
    statusTab,
    onStatusTabChange,
    crons,
    cronRunsByName,
    cronRunsMode,
    onCronRunsModeChange,
    cronWindowDays,
    onCronWindowDaysChange,
    currentTimeMs,
}: StatusPageProps) {
    const groupedEndpoints = useMemo((): GroupWithEndpoints[] => {
        return groups.map((group) => ({
            ...group,
            endpoints: endpoints.filter(
                (endpoint) => endpoint.group_id === group.id,
            ),
            group_status: getGroupStatus(
                endpoints.filter((endpoint) => endpoint.group_id === group.id),
            ),
        }));
    }, [groups, endpoints]);

    const upCount = endpoints.filter(
        (endpoint) => endpoint.status === "up",
    ).length;
    const downCount = endpoints.filter(
        (endpoint) => endpoint.status === "down",
    ).length;
    const cronHealthyCount = crons.filter(
        (cronJob) => cronJob.last_run_status === "success",
    ).length;
    const cronFailingCount = crons.filter(
        (cronJob) =>
            cronJob.last_run_status === "failed" ||
            cronJob.last_run_status === "missed",
    ).length;

    const renderStatus = (endpoint: MonitorEndpoint): string => {
        if (endpoint.is_paused) return "bg-slate-400";
        if (endpoint.status === "up") return "bg-emerald-500";
        if (endpoint.status === "down") return "bg-rose-500";
        return "bg-amber-500";
    };

    const renderGroupStatus = (status: MonitorStatus): string => {
        if (status === "up")
            return "bg-emerald-100 text-emerald-700 border-emerald-200/80";
        if (status === "down")
            return "bg-rose-100 text-rose-700 border-rose-200/80";
        return "bg-amber-100 text-amber-700 border-amber-200/80";
    };

    return (
        <main className="min-h-screen px-4 py-10 text-slate-900 md:px-8">
            <div className="mx-auto max-w-7xl space-y-8">
                <header className="glass-card rounded-2xl p-6">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                            <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">
                                Live Status
                            </p>
                            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                                Service Status Page
                            </h1>
                            <p className="mt-2 text-sm text-slate-600">
                                Real-time health and latency of monitored
                                services and endpoints.
                            </p>
                        </div>
                        <a
                            href="/monitors"
                            className="rounded-lg border border-white/60 bg-white/60 px-4 py-2 text-sm font-medium text-slate-700 backdrop-blur"
                        >
                            Open Admin
                        </a>
                    </div>
                    <div className="mt-5 flex rounded-full border border-white/60 bg-white/55 p-1 backdrop-blur md:max-w-fit">
                        {STATUS_TAB_OPTIONS.map((tab) => (
                            <button
                                key={tab.value}
                                type="button"
                                onClick={() => onStatusTabChange(tab.value)}
                                className={`cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition ${
                                    statusTab === tab.value
                                        ? "bg-slate-900 text-white shadow"
                                        : "text-slate-600 hover:bg-white/75"
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                    {statusTab === "crons" ? (
                        <div className="mt-5 grid gap-3 sm:grid-cols-4">
                            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
                                <p className="text-xs text-slate-500">
                                    System
                                </p>
                                <p className="text-lg font-semibold">
                                    {health.status}
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
                                <p className="text-xs text-slate-500">Crons</p>
                                <p className="text-lg font-semibold">
                                    {crons.length}
                                </p>
                            </div>
                            <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/70 p-3 backdrop-blur">
                                <p className="text-xs text-emerald-700">
                                    Healthy
                                </p>
                                <p className="text-lg font-semibold text-emerald-800">
                                    {cronHealthyCount}
                                </p>
                            </div>
                            <div className="rounded-xl border border-rose-200/60 bg-rose-50/70 p-3 backdrop-blur">
                                <p className="text-xs text-rose-700">
                                    Failing
                                </p>
                                <p className="text-lg font-semibold text-rose-800">
                                    {cronFailingCount}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="mt-5 grid gap-3 sm:grid-cols-4">
                            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
                                <p className="text-xs text-slate-500">
                                    System
                                </p>
                                <p className="text-lg font-semibold">
                                    {health.status}
                                </p>
                            </div>
                            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
                                <p className="text-xs text-slate-500">
                                    Monitors
                                </p>
                                <p className="text-lg font-semibold">
                                    {endpoints.length}
                                </p>
                            </div>
                            <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/70 p-3 backdrop-blur">
                                <p className="text-xs text-emerald-700">Up</p>
                                <p className="text-lg font-semibold text-emerald-800">
                                    {upCount}
                                </p>
                            </div>
                            <div className="rounded-xl border border-rose-200/60 bg-rose-50/70 p-3 backdrop-blur">
                                <p className="text-xs text-rose-700">Down</p>
                                <p className="text-lg font-semibold text-rose-800">
                                    {downCount}
                                </p>
                            </div>
                        </div>
                    )}
                    {statusTab === "crons" ? (
                        <div className="mt-5 flex flex-wrap items-center gap-3">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
                                    View
                                </span>
                                <div className="flex rounded-full border border-white/60 bg-white/55 p-1 backdrop-blur">
                                    {CRON_RUNS_MODE_OPTIONS.map((option) => (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() =>
                                                onCronRunsModeChange(
                                                    option.value,
                                                )
                                            }
                                            className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition ${
                                                cronRunsMode === option.value
                                                    ? "bg-slate-900 text-white shadow"
                                                    : "text-slate-600 hover:bg-white/75"
                                            }`}
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {cronRunsMode === "window" ? (
                                <div className="flex items-center gap-2">
                                    <label
                                        htmlFor="cron-status-window"
                                        className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500"
                                    >
                                        Window
                                    </label>
                                    <select
                                        id="cron-status-window"
                                        value={cronWindowDays}
                                        onChange={(event) =>
                                            onCronWindowDaysChange(
                                                Number(event.target.value),
                                            )
                                        }
                                        className="cursor-pointer rounded-full border border-white/70 bg-white/65 px-4 py-2 text-sm text-slate-700 backdrop-blur focus:outline-none focus:ring-2 focus:ring-cyan-300/70"
                                    >
                                        {CRON_STATUS_WINDOW_OPTIONS.map(
                                            (option) => (
                                                <option
                                                    key={option.value}
                                                    value={option.value}
                                                >
                                                    {option.label}
                                                </option>
                                            ),
                                        )}
                                    </select>
                                </div>
                            ) : null}
                            <p className="text-xs text-slate-500">
                                {cronRunsMode === "recent"
                                    ? "Showing the latest 50 runs per cron."
                                    : "Run history retained for the last 90 days."}
                            </p>
                        </div>
                    ) : (
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
                                View
                            </span>
                            <div className="flex rounded-full border border-white/60 bg-white/55 p-1 backdrop-blur">
                                {STATUS_VIEW_MODE_OPTIONS.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() =>
                                            onViewModeChange(option.value)
                                        }
                                        className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition ${
                                            statusViewMode === option.value
                                                ? "bg-slate-900 text-white shadow"
                                                : "text-slate-600 hover:bg-white/75"
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div
                            className={`flex items-center gap-2 ${
                                statusViewMode === "raw" ? "opacity-50" : ""
                            }`}
                        >
                            <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
                                Resolution
                            </span>
                            <div className="flex rounded-full border border-white/60 bg-white/55 p-1 backdrop-blur">
                                {STATUS_GRANULARITY_OPTIONS.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() =>
                                            onGranularityChange(option.value)
                                        }
                                        disabled={statusViewMode === "raw"}
                                        className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition ${
                                            statusGranularity === option.value
                                                ? "bg-slate-900 text-white shadow"
                                                : "text-slate-600 hover:bg-white/75"
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div
                            className={`flex items-center gap-2 ${
                                statusViewMode === "raw" ? "opacity-50" : ""
                            }`}
                        >
                            <label
                                htmlFor="status-range"
                                className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500"
                            >
                                Window
                            </label>
                            <select
                                id="status-range"
                                value={statusRangeDays}
                                onChange={(event) =>
                                    onRangeChange(Number(event.target.value))
                                }
                                disabled={statusViewMode === "raw"}
                                className="cursor-pointer rounded-full border border-white/70 bg-white/65 px-4 py-2 text-sm text-slate-700 backdrop-blur focus:outline-none focus:ring-2 focus:ring-cyan-300/70"
                            >
                                {STATUS_RANGE_OPTIONS[statusGranularity].map(
                                    (option) => (
                                        <option
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </option>
                                    ),
                                )}
                            </select>
                        </div>
                        <p className="text-xs text-slate-500">
                            {statusViewMode === "raw"
                                ? "Showing the latest 50 raw checks."
                                : "History retained for the last 90 days."}
                        </p>
                    </div>
                    )}
                </header>

                {isLoading ? (
                    <div className="glass-card rounded-xl p-6 text-sm text-slate-600">
                        Loading status...
                    </div>
                ) : statusTab === "crons" ? (
                    <section className="space-y-4">
                        {!crons.length && (
                            <div className="glass-card rounded-xl p-6 text-sm text-slate-600">
                                No crons configured yet.
                            </div>
                        )}
                        <div className="grid gap-4 lg:grid-cols-2">
                            {crons.map((cronJob) => {
                                const runs =
                                    cronRunsByName[cronJob.cron] ?? [];
                                const successCount = runs.filter(
                                    (run) => run.status === "success",
                                ).length;
                                const failureCount = runs.filter(
                                    (run) =>
                                        run.status === "failed" ||
                                        run.status === "missed",
                                ).length;

                                return (
                                    <article
                                        key={cronJob.cron}
                                        className="glass-card rounded-2xl p-5"
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className={`h-2.5 w-2.5 rounded-full ${
                                                        cronJob.status
                                                            ? "bg-emerald-500"
                                                            : "bg-slate-400"
                                                    }`}
                                                />
                                                <h3 className="font-semibold">
                                                    {cronJob.cron}
                                                </h3>
                                                <span className="rounded bg-white/70 px-2 py-0.5 text-[10px] uppercase text-slate-600 backdrop-blur">
                                                    {cronJob.trigger_type}
                                                </span>
                                                {!cronJob.status ? (
                                                    <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                                        disabled
                                                    </span>
                                                ) : null}
                                            </div>
                                            {cronJob.last_run_status ? (
                                                <span
                                                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase backdrop-blur ${renderCronRunBadge(cronJob.last_run_status)}`}
                                                >
                                                    {cronJob.last_run_status}
                                                </span>
                                            ) : null}
                                        </div>
                                        <p className="mt-1 font-mono text-xs text-slate-600">
                                            {cronJob.expression}
                                        </p>
                                        <div className="mt-3">
                                            <CronRunGrid runs={runs} />
                                        </div>
                                        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
                                            <span>
                                                {successCount} ok /{" "}
                                                {failureCount} failed of{" "}
                                                {runs.length} runs
                                            </span>
                                            <span>
                                                Last run:{" "}
                                                {formatRelativeTime(
                                                    cronJob.last_run_at,
                                                    currentTimeMs,
                                                )}
                                            </span>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                ) : (
                    <section className="space-y-6">
                        {groupedEndpoints.map((group) => (
                            <div
                                key={group.id}
                                className="glass-card rounded-2xl p-5"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <h2 className="text-xl font-semibold">
                                            {group.name}
                                        </h2>
                                        <p className="text-sm text-slate-500">
                                            {group.description || ""}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${renderGroupStatus(group.group_status)}`}
                                        >
                                            {group.group_status}
                                        </span>
                                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                                            {group.endpoints.length} services
                                        </span>
                                    </div>
                                </div>

                                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                    {group.endpoints.map((endpoint) => (
                                        <article
                                            key={endpoint.id}
                                            className="rounded-xl border border-white/60 bg-white/55 p-4 backdrop-blur"
                                        >
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <span
                                                            className={`h-2.5 w-2.5 rounded-full ${renderStatus(endpoint)}`}
                                                        />
                                                        <h3 className="font-semibold">
                                                            {endpoint.name}
                                                        </h3>
                                                        <span className="rounded bg-white/70 px-2 py-0.5 text-[10px] uppercase text-slate-600 backdrop-blur">
                                                            {
                                                                endpoint.monitor_type
                                                            }
                                                        </span>
                                                        {endpoint.is_paused ? (
                                                            <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                                                paused
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    {/* <p className="mt-1 break-all font-mono text-[11px] text-slate-600">{endpoint.url}</p> */}
                                                </div>
                                                <div className="text-right text-[11px] text-slate-500">
                                                    <p>
                                                        Last code:{" "}
                                                        {endpoint.last_response_code ??
                                                            "n/a"}
                                                    </p>
                                                    <p>
                                                        Every{" "}
                                                        {
                                                            endpoint.interval_seconds
                                                        }
                                                        s
                                                    </p>
                                                </div>
                                            </div>

                                            <LatencySparkline
                                                runs={
                                                    runsByEndpoint[
                                                        endpoint.id
                                                    ] ?? []
                                                }
                                                granularity={
                                                    statusGranularity
                                                }
                                                statusViewMode={
                                                    statusViewMode
                                                }
                                            />
                                        </article>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </section>
                )}
            </div>
        </main>
    );
}

function LandingPage() {
    return (
        <main className="min-h-screen px-4 py-12 text-slate-900 md:px-8">
            <div className="mx-auto max-w-6xl space-y-8">
                <section className="glass-card rounded-2xl p-8 md:p-10">
                    <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">
                        Uptime Monitor
                    </p>
                    <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
                        Monitor APIs, data stores, messaging, and ports in one
                        place
                    </h1>
                    <p className="mt-4 max-w-3xl text-base text-slate-600">
                        Track HTTP APIs, MySQL, Redis, NATS JetStream, and TCP
                        services with retry-aware health transitions, real-time
                        updates, and latency history. Control plane access is
                        protected with Google login.
                    </p>

                    <div className="mt-7 flex flex-wrap gap-3">
                        <a
                            href="/monitors"
                            className="rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)]"
                        >
                            Open Control Plane
                        </a>
                        <a
                            href="/status"
                            className="rounded-lg border border-white/60 bg-white/70 px-5 py-2.5 text-sm font-medium text-slate-700 backdrop-blur"
                        >
                            Open Status Page
                        </a>
                    </div>
                </section>

                <section className="grid gap-4 md:grid-cols-3">
                    <article className="glass-card rounded-xl p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                            Control Plane
                        </h2>
                        <p className="mt-2 text-sm text-slate-600">
                            Configure monitors, group services, pause/resume
                            endpoints or entire groups, edit checks, and manage
                            historical run data.
                        </p>
                    </article>
                    <article className="glass-card rounded-xl p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                            Public Status
                        </h2>
                        <p className="mt-2 text-sm text-slate-600">
                            Share a public status page with grouped health,
                            realtime state updates, and latency trend graphs
                            with hover tooltips.
                        </p>
                    </article>
                    <article className="glass-card rounded-xl p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                            Secure Alerts
                        </h2>
                        <p className="mt-2 text-sm text-slate-600">
                            Google-authenticated control plane, in-memory
                            sessions, and rich Slack/webhook notifications for
                            up/down events.
                        </p>
                    </article>
                </section>
            </div>
        </main>
    );
}

interface LoginPageProps {
    apiBase: string;
    isChecking: boolean;
    error: string;
}

function LoginPage({ apiBase, isChecking, error }: LoginPageProps) {
    const search =
        typeof window !== "undefined"
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
    const requestedReturnTo = search.get("returnTo") || "/monitors";
    const safeReturnTo =
        requestedReturnTo.startsWith("/") && !requestedReturnTo.startsWith("//")
            ? requestedReturnTo
            : "/monitors";
    const googleAuthUrl = `${apiBase || ""}/api/auth/google?returnTo=${encodeURIComponent(safeReturnTo)}`;
    const errorCode = search.get("error");
    const errorMessage =
        error ||
        (errorCode === "account_not_provisioned"
            ? "Your account hasn't been granted access. Ask an administrator to add you first."
            : errorCode === "banned"
              ? "Your account has been suspended. Contact an administrator."
              : "");

    return (
        <main className="min-h-screen px-4 py-12 text-slate-900 md:px-8">
            <div className="mx-auto max-w-xl">
                <section className="glass-card rounded-2xl p-8 md:p-10">
                    <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">
                        Authentication
                    </p>
                    <h1 className="mt-3 text-3xl font-semibold tracking-tight">
                        Sign in to Control Plane
                    </h1>
                    <p className="mt-3 text-sm text-slate-600">
                        Control plane access requires Google sign-in. Status
                        page remains public.
                    </p>

                    <a
                        href={googleAuthUrl}
                        className="mt-6 inline-flex cursor-pointer items-center rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 active:scale-[0.98]"
                    >
                        Continue with Google
                    </a>
                    {isChecking ? (
                        <p className="mt-3 text-xs text-slate-500">
                            Checking session...
                        </p>
                    ) : null}
                    {errorMessage ? (
                        <p className="mt-3 text-xs text-rose-600">
                            {errorMessage}
                        </p>
                    ) : null}
                </section>
            </div>
        </main>
    );
}

interface AdminPageProps {
    health: HealthSummary;
    groups: MonitorGroup[];
    groupedEndpoints: GroupWithEndpoints[];
    endpointForm: EndpointFormState;
    editingEndpointId: number | null;
    canEdit: boolean;
    isLoading: boolean;
    isSavingEndpoint: boolean;
    setEndpointForm: Dispatch<SetStateAction<EndpointFormState>>;
    handleCancelEdit: () => void;
    handleDeleteHistory: (endpointId: number) => Promise<void>;
    handleEndpointSubmit: (
        event: SubmitEvent<HTMLFormElement>,
    ) => Promise<void>;
    handleDeleteEndpoint: (endpointId: number) => Promise<void>;
    handleCheckNow: (endpointId: number) => Promise<void>;
    handleTogglePause: (endpoint: MonitorEndpoint) => Promise<void>;
    handleToggleGroupPause: (group: GroupWithEndpoints) => Promise<void>;
    handleStartEdit: (endpoint: MonitorEndpoint) => void;
    crons: CronJob[];
    cronForm: CronFormState;
    setCronForm: Dispatch<SetStateAction<CronFormState>>;
    editingCronName: string | null;
    isSavingCron: boolean;
    handleCronSubmit: (event: SubmitEvent<HTMLFormElement>) => Promise<void>;
    handleCancelCronEdit: () => void;
    handleStartEditCron: (cronJob: CronJob) => void;
    handleDeleteCron: (cronName: string) => Promise<void>;
    cronMonitorEnabled: boolean;
    cronMonitorMeta: CronMonitorMeta;
    handleToggleCronMonitor: () => Promise<void>;
    currentTimeMs: number;
    error: string;
}

function AdminPage({
    health,
    groups,
    groupedEndpoints,
    endpointForm,
    editingEndpointId,
    canEdit,
    isLoading,
    isSavingEndpoint,
    setEndpointForm,
    handleCancelEdit,
    handleDeleteHistory,
    handleEndpointSubmit,
    handleDeleteEndpoint,
    handleCheckNow,
    handleTogglePause,
    handleToggleGroupPause,
    handleStartEdit,
    crons,
    cronForm,
    setCronForm,
    editingCronName,
    isSavingCron,
    handleCronSubmit,
    handleCancelCronEdit,
    handleStartEditCron,
    handleDeleteCron,
    cronMonitorEnabled,
    cronMonitorMeta,
    handleToggleCronMonitor,
    currentTimeMs,
    error,
}: AdminPageProps) {
    const isHttpType = endpointForm.monitor_type === "http";
    const [activeTab, setActiveTab] = useState<AdminTab>("routes");
    const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
    const [collapsedGroups, setCollapsedGroups] = useState<
        Record<number, boolean>
    >({});

    const filteredGroupOptions = useMemo(() => {
        const query = endpointForm.group_name.trim().toLowerCase();
        if (!query) return groups;
        return groups.filter((group) =>
            group.name.toLowerCase().includes(query),
        );
    }, [groups, endpointForm.group_name]);

    const renderStatusColor = (endpoint: MonitorEndpoint): string => {
        if (endpoint.is_paused) return "bg-slate-400";
        if (endpoint.status === "up") return "bg-emerald-500";
        if (endpoint.status === "down") return "bg-rose-500";
        return "bg-amber-500";
    };

    const renderGroupStatus = (status: MonitorStatus): string => {
        if (status === "up")
            return "bg-emerald-100 text-emerald-700 border-emerald-200/80";
        if (status === "down")
            return "bg-rose-100 text-rose-700 border-rose-200/80";
        return "bg-amber-100 text-amber-700 border-amber-200/80";
    };

    return (
        <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
            <div className="mx-auto max-w-7xl space-y-6">
                <section className="glass-card rounded-xl p-6">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                                Monitor Service
                            </p>
                            <h1 className="mt-2 text-2xl font-semibold">
                                Uptime Control Panel
                            </h1>
                            <p className="mt-2 text-sm text-slate-600">
                                Configure HTTP, MySQL, and Redis monitors with
                                retries and interval polling.
                            </p>
                        </div>
                        <a
                            href="/status"
                            className="rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-xs font-medium backdrop-blur"
                        >
                            Open Status Page
                        </a>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:max-w-3xl md:grid-cols-3">
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">Service Status</p>
                            <p className="font-semibold">{health.status}</p>
                        </div>
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">
                                Configured Services
                            </p>
                            <p className="font-semibold">
                                {health.endpointCount ?? 0}
                            </p>
                        </div>
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">Configured Crons</p>
                            <p className="font-semibold">{crons.length}</p>
                        </div>
                    </div>
                    <div className="mt-5 flex rounded-full border border-white/60 bg-white/55 p-1 backdrop-blur md:max-w-fit">
                        {ADMIN_TAB_OPTIONS.map((tab) => (
                            <button
                                key={tab.value}
                                type="button"
                                onClick={() => setActiveTab(tab.value)}
                                className={`cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition ${
                                    activeTab === tab.value
                                        ? "bg-slate-900 text-white shadow"
                                        : "text-slate-600 hover:bg-white/75"
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </section>

                {activeTab === "routes" ? (
                <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
                    <section className="glass-card rounded-xl p-5">
                        <h2 className="text-lg font-semibold">
                            Monitored Routes
                        </h2>
                        {!canEdit ? (
                            <p className="mt-2 rounded-md border border-amber-200/80 bg-amber-50/75 px-3 py-2 text-xs text-amber-700">
                                You have read-only access. Editing actions are
                                restricted to allowed editor emails.
                            </p>
                        ) : null}
                        {isLoading ? (
                            <p className="mt-3 text-sm text-slate-500">
                                Loading...
                            </p>
                        ) : (
                            <div className="mt-4 space-y-5">
                                {!groupedEndpoints.length && (
                                    <p className="text-sm text-slate-500">
                                        No groups configured yet.
                                    </p>
                                )}
                                {groupedEndpoints.map((group) => (
                                    <div
                                        key={group.id}
                                        className="rounded-lg border border-white/60 bg-white/40 p-4 backdrop-blur"
                                    >
                                        {(() => {
                                            const hasMonitors =
                                                group.endpoints.length > 0;
                                            const allPaused =
                                                hasMonitors &&
                                                group.endpoints.every(
                                                    (endpoint) =>
                                                        endpoint.is_paused,
                                                );
                                            return (
                                                <div className="flex items-center justify-between gap-4">
                                                    <div>
                                                        <h3 className="text-base font-semibold">
                                                            {group.name}
                                                        </h3>
                                                        <p className="text-xs text-slate-500">
                                                            {group.description ||
                                                                ""}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                handleToggleGroupPause(
                                                                    group,
                                                                )
                                                            }
                                                            disabled={
                                                                !hasMonitors ||
                                                                !canEdit
                                                            }
                                                            className={`cursor-pointer rounded border px-3 py-1.5 text-xs text-white transition duration-150 ease-out active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 ${
                                                                allPaused
                                                                    ? "border-emerald-300/70 bg-gradient-to-r from-emerald-600 to-teal-600 shadow-[0_6px_16px_rgba(5,150,105,0.26)] hover:from-emerald-500 hover:to-teal-500 focus-visible:ring-emerald-300/80"
                                                                    : "border-slate-300/70 bg-gradient-to-r from-slate-600 to-slate-700 shadow-[0_6px_16px_rgba(51,65,85,0.25)] hover:from-slate-500 hover:to-slate-600 focus-visible:ring-slate-300/80"
                                                            } disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100`}
                                                        >
                                                            {allPaused
                                                                ? "Resume Group"
                                                                : "Pause Group"}
                                                        </button>
                                                        <span
                                                            className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${renderGroupStatus(group.group_status)}`}
                                                        >
                                                            {group.group_status}
                                                        </span>
                                                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                                                            {
                                                                group.endpoints
                                                                    .length
                                                            }{" "}
                                                            monitors
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                setCollapsedGroups(
                                                                    (
                                                                        current,
                                                                    ) => ({
                                                                        ...current,
                                                                        [group.id]:
                                                                            !(
                                                                                current[
                                                                                    group
                                                                                        .id
                                                                                ] ??
                                                                                true
                                                                            ),
                                                                    }),
                                                                )
                                                            }
                                                            aria-label={
                                                                (collapsedGroups[
                                                                    group.id
                                                                ] ?? true)
                                                                    ? "Expand group"
                                                                    : "Collapse group"
                                                            }
                                                            className="cursor-pointer rounded border border-slate-300/70 bg-white/70 p-2 text-slate-700 transition hover:bg-white"
                                                        >
                                                            {(collapsedGroups[
                                                                group.id
                                                            ] ?? true) ? (
                                                                <FaChevronRight className="h-3 w-3" />
                                                            ) : (
                                                                <FaChevronDown className="h-3 w-3" />
                                                            )}
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        {!(
                                            collapsedGroups[group.id] ?? true
                                        ) && (
                                            <div className="mt-4 space-y-3">
                                                {!group.endpoints.length && (
                                                    <p className="text-sm text-slate-500">
                                                        No monitors in this
                                                        group.
                                                    </p>
                                                )}
                                                {group.endpoints.map(
                                                    (endpoint) => (
                                                        <article
                                                            key={endpoint.id}
                                                            className="rounded-lg border border-white/60 bg-white/50 p-3 backdrop-blur"
                                                        >
                                                            <div className="flex flex-wrap items-center justify-between gap-3">
                                                                <div>
                                                                    <div className="flex items-center gap-2">
                                                                        <span
                                                                            className={`h-2.5 w-2.5 rounded-full ${renderStatusColor(endpoint)}`}
                                                                        />
                                                                        <p className="font-medium">
                                                                            {
                                                                                endpoint.name
                                                                            }
                                                                        </p>
                                                                        <span className="rounded bg-white/65 px-2 py-0.5 font-mono text-xs uppercase backdrop-blur">
                                                                            {
                                                                                endpoint.monitor_type
                                                                            }
                                                                        </span>
                                                                        {endpoint.is_paused ? (
                                                                            <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                                                                paused
                                                                            </span>
                                                                        ) : null}
                                                                    </div>
                                                                    <p className="mt-1 break-all font-mono text-xs text-slate-600">
                                                                        {
                                                                            endpoint.url
                                                                        }
                                                                    </p>
                                                                </div>
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            handleStartEdit(
                                                                                endpoint,
                                                                            )
                                                                        }
                                                                        className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/80"
                                                                    >
                                                                        Edit
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            handleTogglePause(
                                                                                endpoint,
                                                                            )
                                                                        }
                                                                        disabled={
                                                                            !canEdit
                                                                        }
                                                                        className={`cursor-pointer rounded border px-3 py-1.5 text-xs text-white transition duration-150 ease-out active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 ${
                                                                            endpoint.is_paused
                                                                                ? "border-emerald-300/70 bg-gradient-to-r from-emerald-600 to-teal-600 shadow-[0_6px_16px_rgba(5,150,105,0.26)] hover:from-emerald-500 hover:to-teal-500 focus-visible:ring-emerald-300/80"
                                                                                : "border-slate-300/70 bg-gradient-to-r from-slate-600 to-slate-700 shadow-[0_6px_16px_rgba(51,65,85,0.25)] hover:from-slate-500 hover:to-slate-600 focus-visible:ring-slate-300/80"
                                                                        } disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100`}
                                                                    >
                                                                        {endpoint.is_paused
                                                                            ? "Resume"
                                                                            : "Pause"}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            handleCheckNow(
                                                                                endpoint.id,
                                                                            )
                                                                        }
                                                                        disabled={
                                                                            endpoint.is_paused ||
                                                                            !canEdit
                                                                        }
                                                                        className="cursor-pointer rounded border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(37,99,235,0.25)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/80 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-500 disabled:opacity-60 disabled:active:scale-100"
                                                                    >
                                                                        Check
                                                                        now
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={
                                                                            !canEdit
                                                                        }
                                                                        onClick={() =>
                                                                            handleDeleteHistory(
                                                                                endpoint.id,
                                                                            )
                                                                        }
                                                                        className="cursor-pointer rounded border border-amber-300/70 bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(245,158,11,0.22)] transition duration-150 ease-out hover:from-amber-400 hover:to-orange-400 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                                                    >
                                                                        Delete
                                                                        history
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={
                                                                            !canEdit
                                                                        }
                                                                        onClick={() =>
                                                                            handleDeleteEndpoint(
                                                                                endpoint.id,
                                                                            )
                                                                        }
                                                                        className="cursor-pointer rounded border border-rose-300/70 bg-gradient-to-r from-rose-500 to-pink-500 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(244,63,94,0.24)] transition duration-150 ease-out hover:from-rose-400 hover:to-pink-400 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                                                    >
                                                                        Delete
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                                                                <p>
                                                                    Interval:{" "}
                                                                    {
                                                                        endpoint.interval_seconds
                                                                    }
                                                                    s
                                                                </p>
                                                                <p>
                                                                    Retries
                                                                    down/up:{" "}
                                                                    {
                                                                        endpoint.down_retries
                                                                    }
                                                                    /
                                                                    {
                                                                        endpoint.up_retries
                                                                    }
                                                                </p>
                                                                <p>
                                                                    Last code:{" "}
                                                                    {endpoint.last_response_code ??
                                                                        "n/a"}
                                                                </p>
                                                                <p>
                                                                    Last
                                                                    checked:{" "}
                                                                    {formatRelativeTime(
                                                                        endpoint.last_checked_at,
                                                                        currentTimeMs,
                                                                    )}
                                                                </p>
                                                            </div>
                                                            {endpoint.last_error && (
                                                                <p className="mt-2 rounded border border-rose-200/80 bg-rose-50/80 px-2 py-1 text-xs text-rose-700 backdrop-blur">
                                                                    {
                                                                        endpoint.last_error
                                                                    }
                                                                </p>
                                                            )}
                                                        </article>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <section className="space-y-4">
                        <form
                            onSubmit={handleEndpointSubmit}
                            className="glass-card rounded-xl p-5"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-lg font-semibold">
                                    {editingEndpointId
                                        ? "Edit Monitor"
                                        : "Add Monitor"}
                                </h2>
                                {editingEndpointId ? (
                                    <button
                                        type="button"
                                        onClick={handleCancelEdit}
                                        disabled={!canEdit}
                                        className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                    >
                                        Cancel Edit
                                    </button>
                                ) : null}
                            </div>
                            <fieldset
                                disabled={!canEdit || isSavingEndpoint}
                                className="contents"
                            >
                                <label className="mt-3 block text-sm font-medium text-slate-700">
                                    Group (type new or choose existing)
                                    <div className="relative mt-1">
                                        <input
                                            required
                                            value={endpointForm.group_name}
                                            onFocus={() =>
                                                setIsGroupMenuOpen(true)
                                            }
                                            onBlur={() => {
                                                setTimeout(
                                                    () =>
                                                        setIsGroupMenuOpen(
                                                            false,
                                                        ),
                                                    120,
                                                );
                                            }}
                                            onChange={(event) => {
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    group_name:
                                                        event.target.value,
                                                }));
                                                setIsGroupMenuOpen(true);
                                            }}
                                            className="w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:border-slate-500 focus:outline-none"
                                            placeholder="Payments"
                                        />
                                        <button
                                            type="button"
                                            aria-label="Toggle group options"
                                            onMouseDown={(event) =>
                                                event.preventDefault()
                                            }
                                            onClick={() =>
                                                setIsGroupMenuOpen(
                                                    (open) => !open,
                                                )
                                            }
                                            className="absolute inset-y-0 right-2 my-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                                        >
                                            <svg
                                                viewBox="0 0 20 20"
                                                fill="none"
                                                className={`h-4 w-4 transition-transform ${isGroupMenuOpen ? "rotate-180" : ""}`}
                                                aria-hidden="true"
                                            >
                                                <path
                                                    d="M5 7.5L10 12.5L15 7.5"
                                                    stroke="currentColor"
                                                    strokeWidth="1.8"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                        </button>
                                        {isGroupMenuOpen &&
                                            filteredGroupOptions.length > 0 && (
                                                <div className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-300/80 bg-white/95 p-1 shadow-lg backdrop-blur">
                                                    {filteredGroupOptions.map(
                                                        (group) => (
                                                            <button
                                                                key={group.id}
                                                                type="button"
                                                                onMouseDown={(
                                                                    event,
                                                                ) =>
                                                                    event.preventDefault()
                                                                }
                                                                onClick={() => {
                                                                    setEndpointForm(
                                                                        (
                                                                            current,
                                                                        ) => ({
                                                                            ...current,
                                                                            group_name:
                                                                                group.name,
                                                                        }),
                                                                    );
                                                                    setIsGroupMenuOpen(
                                                                        false,
                                                                    );
                                                                }}
                                                                className="block w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                                                            >
                                                                {group.name}
                                                            </button>
                                                        ),
                                                    )}
                                                </div>
                                            )}
                                    </div>
                                </label>

                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="text-sm font-medium text-slate-700">
                                        Name
                                        <input
                                            required
                                            value={endpointForm.name}
                                            onChange={(event) =>
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    name: event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Monitor Type
                                        <select
                                            value={endpointForm.monitor_type}
                                            onChange={(event) =>
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    monitor_type:
                                                        event.target.value,
                                                    connection_json:
                                                        DEFAULT_CONNECTION_JSON[
                                                            event.target.value
                                                        ],
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        >
                                            {MONITOR_TYPE_OPTIONS.map(
                                                (option) => (
                                                    <option
                                                        key={option.value}
                                                        value={option.value}
                                                    >
                                                        {option.label}
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    </label>
                                </div>

                                {isHttpType ? (
                                    <>
                                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                                            <label className="text-sm font-medium text-slate-700">
                                                Method
                                                <select
                                                    value={endpointForm.method}
                                                    onChange={(event) =>
                                                        setEndpointForm(
                                                            (current) => ({
                                                                ...current,
                                                                method: event
                                                                    .target
                                                                    .value,
                                                            }),
                                                        )
                                                    }
                                                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                                >
                                                    {METHOD_OPTIONS.map(
                                                        (method) => (
                                                            <option
                                                                key={method}
                                                                value={method}
                                                            >
                                                                {method}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                            </label>
                                            <label className="text-sm font-medium text-slate-700">
                                                Expected Response Code
                                                <input
                                                    type="number"
                                                    min="100"
                                                    max="599"
                                                    value={
                                                        endpointForm.expected_status
                                                    }
                                                    onChange={(event) =>
                                                        setEndpointForm(
                                                            (current) => ({
                                                                ...current,
                                                                expected_status:
                                                                    event.target
                                                                        .value,
                                                            }),
                                                        )
                                                    }
                                                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                                />
                                            </label>
                                        </div>

                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Full URL Endpoint
                                            <input
                                                required
                                                value={endpointForm.url}
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            url: event.target
                                                                .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                            />
                                        </label>

                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Headers (JSON, optional)
                                            <textarea
                                                value={
                                                    endpointForm.headers_json
                                                }
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            headers_json:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 min-h-20 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                placeholder='{"Authorization":"Bearer <token>"}'
                                            />
                                        </label>

                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Body (Optional)
                                            <textarea
                                                value={endpointForm.body_text}
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            body_text:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 min-h-24 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                            />
                                        </label>

                                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                                            <label className="text-sm font-medium text-slate-700">
                                                JSON Path (optional)
                                                <input
                                                    value={
                                                        endpointForm.expected_json_path
                                                    }
                                                    onChange={(event) =>
                                                        setEndpointForm(
                                                            (current) => ({
                                                                ...current,
                                                                expected_json_path:
                                                                    event.target
                                                                        .value,
                                                            }),
                                                        )
                                                    }
                                                    className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                />
                                            </label>
                                            <label className="text-sm font-medium text-slate-700">
                                                JSON Value (optional)
                                                <input
                                                    value={
                                                        endpointForm.expected_json_value
                                                    }
                                                    onChange={(event) =>
                                                        setEndpointForm(
                                                            (current) => ({
                                                                ...current,
                                                                expected_json_value:
                                                                    event.target
                                                                        .value,
                                                            }),
                                                        )
                                                    }
                                                    className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                    placeholder={
                                                        '"ok" or true or 123'
                                                    }
                                                />
                                            </label>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Connection Config (JSON)
                                            <textarea
                                                value={
                                                    endpointForm.connection_json
                                                }
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            connection_json:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 min-h-28 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                            />
                                        </label>
                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Probe Command (optional)
                                            <input
                                                value={
                                                    endpointForm.probe_command
                                                }
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            probe_command:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                placeholder={
                                                    endpointForm.monitor_type ===
                                                    "mysql"
                                                        ? "SELECT 1 AS health"
                                                        : endpointForm.monitor_type ===
                                                            "redis"
                                                          ? 'PING or ["GET","health:key"]'
                                                          : endpointForm.monitor_type ===
                                                              "nats"
                                                            ? "jetstream.info, stream.info:ORDERS, consumers.lag:128, consumer.lag:ORDERS:worker:512"
                                                            : endpointForm.monitor_type ===
                                                                "tcp"
                                                              ? "Optional (default checks open port)"
                                                              : ""
                                                }
                                            />
                                        </label>
                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Expected Probe Value (optional)
                                            <input
                                                value={
                                                    endpointForm.expected_probe_value
                                                }
                                                onChange={(event) =>
                                                    setEndpointForm(
                                                        (current) => ({
                                                            ...current,
                                                            expected_probe_value:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                placeholder={
                                                    endpointForm.monitor_type ===
                                                    "mysql"
                                                        ? "1"
                                                        : endpointForm.monitor_type ===
                                                            "redis"
                                                          ? '"PONG"'
                                                          : endpointForm.monitor_type ===
                                                              "nats"
                                                            ? '"ok" or stream name'
                                                            : endpointForm.monitor_type ===
                                                                "tcp"
                                                              ? '"open"'
                                                              : ""
                                                }
                                            />
                                        </label>
                                    </>
                                )}

                                <div className="mt-3 grid gap-3 md:grid-cols-3">
                                    <label className="text-sm font-medium text-slate-700">
                                        Interval (seconds)
                                        <input
                                            type="number"
                                            min="5"
                                            value={
                                                endpointForm.interval_seconds
                                            }
                                            onChange={(event) =>
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    interval_seconds:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Retries Before Down
                                        <input
                                            type="number"
                                            min="1"
                                            value={endpointForm.down_retries}
                                            onChange={(event) =>
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    down_retries:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Retries Before Up
                                        <input
                                            type="number"
                                            min="1"
                                            value={endpointForm.up_retries}
                                            onChange={(event) =>
                                                setEndpointForm((current) => ({
                                                    ...current,
                                                    up_retries:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                </div>

                                <button
                                    type="submit"
                                    disabled={isSavingEndpoint || !canEdit}
                                    className="mt-4 cursor-pointer rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 hover:shadow-[0_10px_28px_rgba(37,99,235,0.35)] active:scale-[0.98] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                >
                                    {isSavingEndpoint
                                        ? "Saving..."
                                        : editingEndpointId
                                          ? "Update Monitor"
                                          : "Create Monitor"}
                                </button>
                            </fieldset>
                        </form>

                        {error && (
                            <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 backdrop-blur">
                                {error}
                            </p>
                        )}
                    </section>
                </section>
                ) : (
                <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
                    <section className="glass-card rounded-xl p-5">
                        <h2 className="text-lg font-semibold">
                            Cron Health
                        </h2>
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-white/60 bg-white/45 px-3 py-2.5 backdrop-blur">
                            <div>
                                <p className="text-sm font-medium text-slate-700">
                                    Cron trigger + health monitoring
                                </p>
                                <p className="text-xs text-slate-500">
                                    {cronMonitorEnabled
                                        ? "Enabled — crons are triggered on schedule and runs are tracked."
                                        : "Disabled — no triggers fire and run health is not tracked."}
                                </p>
                                {cronMonitorMeta?.updatedBy ? (
                                    <p className="mt-0.5 text-[11px] text-slate-400">
                                        Last changed by{" "}
                                        {cronMonitorMeta.updatedBy}{" "}
                                        {formatRelativeTime(
                                            cronMonitorMeta.updatedAt,
                                            currentTimeMs,
                                        )}
                                    </p>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={cronMonitorEnabled}
                                aria-label="Toggle cron trigger and health monitoring"
                                onClick={handleToggleCronMonitor}
                                disabled={!canEdit}
                                className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition ${
                                    cronMonitorEnabled
                                        ? "bg-emerald-500"
                                        : "bg-slate-300"
                                } disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                                <span
                                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                        cronMonitorEnabled
                                            ? "translate-x-5"
                                            : ""
                                    }`}
                                />
                            </button>
                        </div>
                        {!canEdit ? (
                            <p className="mt-2 rounded-md border border-amber-200/80 bg-amber-50/75 px-3 py-2 text-xs text-amber-700">
                                You have read-only access. Editing actions are
                                restricted to allowed editor emails.
                            </p>
                        ) : null}
                        {isLoading ? (
                            <p className="mt-3 text-sm text-slate-500">
                                Loading...
                            </p>
                        ) : (
                            <div className="mt-4 space-y-3">
                                {!crons.length && (
                                    <p className="text-sm text-slate-500">
                                        No crons configured yet.
                                    </p>
                                )}
                                {crons.map((cronJob) => (
                                    <article
                                        key={cronJob.cron}
                                        className="rounded-lg border border-white/60 bg-white/50 p-3 backdrop-blur"
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={`h-2.5 w-2.5 rounded-full ${
                                                            cronJob.status
                                                                ? "bg-emerald-500"
                                                                : "bg-slate-400"
                                                        }`}
                                                    />
                                                    <p className="font-medium">
                                                        {cronJob.cron}
                                                    </p>
                                                    <span className="rounded bg-white/65 px-2 py-0.5 font-mono text-xs uppercase backdrop-blur">
                                                        {cronJob.trigger_type}
                                                    </span>
                                                    {!cronJob.status ? (
                                                        <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                                            disabled
                                                        </span>
                                                    ) : null}
                                                    {cronJob.last_run_status ? (
                                                        <span
                                                            className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase backdrop-blur ${renderCronRunBadge(cronJob.last_run_status)}`}
                                                        >
                                                            run{" "}
                                                            {
                                                                cronJob.last_run_status
                                                            }
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <p className="mt-1 break-all font-mono text-xs text-slate-600">
                                                    {cronJob.expression}
                                                </p>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleStartEditCron(
                                                            cronJob,
                                                        )
                                                    }
                                                    className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/80"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={!canEdit}
                                                    onClick={() =>
                                                        handleDeleteCron(
                                                            cronJob.cron,
                                                        )
                                                    }
                                                    className="cursor-pointer rounded border border-rose-300/70 bg-gradient-to-r from-rose-500 to-pink-500 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(244,63,94,0.24)] transition duration-150 ease-out hover:from-rose-400 hover:to-pink-400 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                        <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                                            <p>
                                                Service:{" "}
                                                {cronJob.service || "n/a"}
                                            </p>
                                            <p>
                                                Start/Ping window:{" "}
                                                {cronJob.start_window_seconds}
                                                s/
                                                {cronJob.ping_window_seconds}
                                                s
                                            </p>
                                            <p>
                                                HTTP method:{" "}
                                                {cronJob.http_method ?? "NONE"}
                                            </p>
                                            <p>
                                                Track run:{" "}
                                                {cronJob.track_run
                                                    ? "yes"
                                                    : "no"}
                                            </p>
                                            {cronJob.trigger_type ===
                                            "nats" ? (
                                                <p className="break-all font-mono md:col-span-2">
                                                    Subject:{" "}
                                                    {cronJob.nats_subject ||
                                                        "crons.uptime_monitor"}
                                                </p>
                                            ) : null}
                                            {cronJob.endpoint ? (
                                                <p className="break-all font-mono md:col-span-2">
                                                    Endpoint:{" "}
                                                    {cronJob.endpoint}
                                                </p>
                                            ) : null}
                                            <p className="md:col-span-2">
                                                Last run:{" "}
                                                {formatRelativeTime(
                                                    cronJob.last_run_at,
                                                    currentTimeMs,
                                                )}
                                            </p>
                                        </div>
                                        {cronJob.last_run_error ? (
                                            <p className="mt-2 rounded border border-rose-200/80 bg-rose-50/80 px-2 py-1 text-xs text-rose-700 backdrop-blur">
                                                {cronJob.last_run_error}
                                            </p>
                                        ) : null}
                                    </article>
                                ))}
                            </div>
                        )}
                    </section>

                    <section className="space-y-4">
                        <form
                            onSubmit={handleCronSubmit}
                            className="glass-card rounded-xl p-5"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-lg font-semibold">
                                    {editingCronName
                                        ? "Edit Cron"
                                        : "Add Cron"}
                                </h2>
                                {editingCronName ? (
                                    <button
                                        type="button"
                                        onClick={handleCancelCronEdit}
                                        disabled={!canEdit}
                                        className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                    >
                                        Cancel Edit
                                    </button>
                                ) : null}
                            </div>
                            <fieldset
                                disabled={!canEdit || isSavingCron}
                                className="contents"
                            >
                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="text-sm font-medium text-slate-700">
                                        Cron Name
                                        <input
                                            required
                                            value={cronForm.cron}
                                            disabled={Boolean(editingCronName)}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    cron: event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
                                            placeholder="update_finish_sessions"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Cron Expression
                                        <input
                                            required
                                            value={cronForm.expression}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    expression:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm focus:border-slate-500 focus:outline-none"
                                            placeholder="*/5 * * * *"
                                        />
                                    </label>
                                </div>

                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="text-sm font-medium text-slate-700">
                                        Service
                                        <input
                                            value={cronForm.service}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    service:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                            placeholder="apis"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Trigger Type
                                        <select
                                            value={cronForm.trigger_type}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    trigger_type:
                                                        event.target.value,
                                                    http_method:
                                                        event.target.value ===
                                                        "http"
                                                            ? current.http_method ===
                                                              "NONE"
                                                                ? "GET"
                                                                : current.http_method
                                                            : "NONE",
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        >
                                            {CRON_TRIGGER_TYPE_OPTIONS.map(
                                                (option) => (
                                                    <option
                                                        key={option.value}
                                                        value={option.value}
                                                    >
                                                        {option.label}
                                                    </option>
                                                ),
                                            )}
                                        </select>
                                    </label>
                                </div>

                                {cronForm.trigger_type === "nats" ? (
                                    <>
                                        <label className="mt-3 block text-sm font-medium text-slate-700">
                                            Publish Subject
                                            <input
                                                required
                                                value={cronForm.nats_subject}
                                                onChange={(event) =>
                                                    setCronForm(
                                                        (current) => ({
                                                            ...current,
                                                            nats_subject:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm focus:border-slate-500 focus:outline-none"
                                                placeholder="crons.uptime_monitor"
                                            />
                                        </label>
                                        <div className="mt-3 rounded-lg border border-cyan-200/80 bg-cyan-50/70 px-3 py-2.5 text-xs text-slate-700 backdrop-blur">
                                            <p>
                                                On each scheduled run, this
                                                payload is published to NATS
                                                subject{" "}
                                                <code className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-cyan-800">
                                                    {cronForm.nats_subject.trim() ||
                                                        "crons.uptime_monitor"}
                                                </code>
                                                :
                                            </p>
                                            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900/90 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">
                                                {JSON.stringify(
                                                    {
                                                        run_id: "6bdc709d-0e2c-4f67-a5cd-a3c5ef5618c1",
                                                        cron:
                                                            cronForm.cron.trim() ||
                                                            "your_cron_name",
                                                    },
                                                    null,
                                                    2,
                                                )}
                                            </pre>
                                            <p className="mt-1.5 text-slate-500">
                                                run_id is a fresh UUIDv4
                                                generated for every trigger.
                                            </p>
                                        </div>
                                    </>
                                ) : null}

                                {cronForm.trigger_type === "http" ? (
                                    <div className="mt-3 grid gap-3 md:grid-cols-[1fr_8rem]">
                                        <label className="text-sm font-medium text-slate-700">
                                            Endpoint
                                            <input
                                                value={cronForm.endpoint}
                                                onChange={(event) =>
                                                    setCronForm(
                                                        (current) => ({
                                                            ...current,
                                                            endpoint:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                                placeholder="https://example.com/cron/run"
                                            />
                                        </label>
                                        <label className="text-sm font-medium text-slate-700">
                                            HTTP Method
                                            <select
                                                value={cronForm.http_method}
                                                onChange={(event) =>
                                                    setCronForm(
                                                        (current) => ({
                                                            ...current,
                                                            http_method:
                                                                event.target
                                                                    .value,
                                                        }),
                                                    )
                                                }
                                                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                            >
                                                {CRON_HTTP_METHOD_OPTIONS.map(
                                                    (method) => (
                                                        <option
                                                            key={method}
                                                            value={method}
                                                        >
                                                            {method}
                                                        </option>
                                                    ),
                                                )}
                                            </select>
                                        </label>
                                    </div>
                                ) : null}

                                {cronForm.trigger_type === "http" ? (
                                    <label className="mt-3 block text-sm font-medium text-slate-700">
                                        Headers (JSON, optional)
                                        <textarea
                                            value={cronForm.headers_json}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    headers_json:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 min-h-20 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                            placeholder='{"Authorization":"Bearer <token>"}'
                                        />
                                    </label>
                                ) : null}

                                {cronForm.trigger_type === "http" &&
                                cronForm.http_method === "POST" ? (
                                    <label className="mt-3 block text-sm font-medium text-slate-700">
                                        Body (Optional)
                                        <textarea
                                            value={cronForm.body_text}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    body_text:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 min-h-24 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                                            placeholder='{"source":"uptime-monitor"}'
                                        />
                                    </label>
                                ) : null}

                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="text-sm font-medium text-slate-700">
                                        Start Window (seconds)
                                        <input
                                            type="number"
                                            min="0"
                                            value={
                                                cronForm.start_window_seconds
                                            }
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    start_window_seconds:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                    <label className="text-sm font-medium text-slate-700">
                                        Ping Window (seconds)
                                        <input
                                            type="number"
                                            min="0"
                                            value={
                                                cronForm.ping_window_seconds
                                            }
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    ping_window_seconds:
                                                        event.target.value,
                                                }))
                                            }
                                            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                                        />
                                    </label>
                                </div>

                                <div className="mt-4 flex flex-wrap gap-5">
                                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                                        <input
                                            type="checkbox"
                                            checked={cronForm.track_run}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    track_run:
                                                        event.target.checked,
                                                }))
                                            }
                                            className="h-4 w-4 cursor-pointer rounded border-slate-300"
                                        />
                                        Track run
                                    </label>
                                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                                        <input
                                            type="checkbox"
                                            checked={cronForm.status}
                                            onChange={(event) =>
                                                setCronForm((current) => ({
                                                    ...current,
                                                    status: event.target
                                                        .checked,
                                                }))
                                            }
                                            className="h-4 w-4 cursor-pointer rounded border-slate-300"
                                        />
                                        Active
                                    </label>
                                </div>

                                <button
                                    type="submit"
                                    disabled={isSavingCron || !canEdit}
                                    className="mt-4 cursor-pointer rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 hover:shadow-[0_10px_28px_rgba(37,99,235,0.35)] active:scale-[0.98] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
                                >
                                    {isSavingCron
                                        ? "Saving..."
                                        : editingCronName
                                          ? "Update Cron"
                                          : "Create Cron"}
                                </button>
                            </fieldset>
                        </form>

                        {error && (
                            <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 backdrop-blur">
                                {error}
                            </p>
                        )}
                    </section>
                </section>
                )}
            </div>
        </main>
    );
}

type AppSection = "monitors" | "metrics" | "users" | "audit";

type NavItem = {
    section: AppSection;
    label: string;
    href: string;
    icon: typeof FaServer;
};

function AppSidebar({
    active,
    collapsed,
    onToggleCollapse,
    canManageUsers,
    user,
    onLogout,
}: {
    active: AppSection;
    collapsed: boolean;
    onToggleCollapse: () => void;
    canManageUsers: boolean;
    user: SessionUser | null;
    onLogout: () => void;
}) {
    const navItems: NavItem[] = [
        { section: "monitors", label: "Monitors", href: "/monitors", icon: FaServer },
        { section: "metrics", label: "Metrics", href: "/metrics", icon: FaChartArea },
        ...(canManageUsers
            ? [
                  {
                      section: "users" as const,
                      label: "Users",
                      href: "/users",
                      icon: FaUsers,
                  },
                  {
                      section: "audit" as const,
                      label: "Audit Log",
                      href: "/audit",
                      icon: FaClipboardList,
                  },
              ]
            : []),
    ];

    const displayName = user?.name || user?.email || "Signed in";
    const initial = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();

    return (
        <aside
            className={`glass-card sticky top-0 z-20 flex h-screen shrink-0 flex-col rounded-none border-y-0 border-l-0 px-3 py-4 transition-[width] duration-200 ${
                collapsed ? "w-16" : "w-60"
            }`}
        >
            <div
                className={`flex items-center ${
                    collapsed ? "justify-center" : "justify-between"
                } px-1`}
            >
                {!collapsed && (
                    <span className="text-sm font-semibold tracking-tight text-slate-800">
                        Uptime
                    </span>
                )}
                <button
                    type="button"
                    onClick={onToggleCollapse}
                    aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                    title={collapsed ? "Expand" : "Collapse"}
                    className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-white/60 bg-white/55 text-slate-600 transition hover:bg-white/80"
                >
                    {collapsed ? <FaAngleDoubleRight /> : <FaAngleDoubleLeft />}
                </button>
            </div>

            <nav className="mt-6 flex flex-1 flex-col gap-1">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.section === active;
                    return (
                        <a
                            key={item.section}
                            href={item.href}
                            title={collapsed ? item.label : undefined}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                                collapsed ? "justify-center" : ""
                            } ${
                                isActive
                                    ? "bg-slate-900 text-white shadow"
                                    : "text-slate-600 hover:bg-white/70"
                            }`}
                        >
                            <Icon className="shrink-0 text-base" />
                            {!collapsed && <span>{item.label}</span>}
                        </a>
                    );
                })}
            </nav>

            <div className="mt-2 border-t border-white/50 pt-3">
                <div
                    className={`flex items-center gap-3 ${
                        collapsed ? "justify-center" : ""
                    }`}
                >
                    {user?.picture ? (
                        <img
                            src={user.picture}
                            alt={displayName}
                            className="h-8 w-8 shrink-0 rounded-full object-cover"
                        />
                    ) : (
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-semibold text-white">
                            {initial}
                        </span>
                    )}
                    {!collapsed && (
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-800">
                                {displayName}
                            </p>
                            {user?.role && (
                                <p className="text-xs capitalize text-slate-500">
                                    {user.role}
                                </p>
                            )}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onLogout}
                    title={collapsed ? "Sign out" : undefined}
                    className={`mt-3 flex w-full items-center gap-2 rounded-lg border border-white/60 bg-white/55 px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white/80 ${
                        collapsed ? "justify-center" : ""
                    }`}
                >
                    <FaSignOutAlt className="shrink-0" />
                    {!collapsed && <span>Sign out</span>}
                </button>
            </div>
        </aside>
    );
}

function AppShell({
    active,
    canManageUsers,
    user,
    children,
}: {
    active: AppSection;
    canManageUsers: boolean;
    user: SessionUser | null;
    children: ReactNode;
}) {
    const [collapsed, setCollapsed] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem("sidebar_collapsed") === "1";
    });

    const toggleCollapse = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev;
            try {
                window.localStorage.setItem(
                    "sidebar_collapsed",
                    next ? "1" : "0",
                );
            } catch {
                // localStorage may be unavailable; collapse still works in-memory.
            }
            return next;
        });
    }, []);

    const handleLogout = useCallback(async () => {
        try {
            await monitoringService.logout();
        } catch {
            // Ignore logout errors and redirect regardless.
        } finally {
            window.location.assign("/login");
        }
    }, []);

    return (
        <div className="flex min-h-screen">
            <AppSidebar
                active={active}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                canManageUsers={canManageUsers}
                user={user}
                onLogout={handleLogout}
            />
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

const USER_ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
    { value: "admin", label: "Admin" },
    { value: "editor", label: "Editor" },
    { value: "viewer", label: "Viewer" },
];

const ROLE_BADGE_CLASS: Record<UserRole, string> = {
    admin: "bg-indigo-100 text-indigo-700 border-indigo-200/80",
    editor: "bg-cyan-100 text-cyan-700 border-cyan-200/80",
    viewer: "bg-slate-100 text-slate-600 border-slate-200/80",
};

function UsersPage() {
    const [users, setUsers] = useState<ManagedUser[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [editingUserId, setEditingUserId] = useState<number | null>(null);
    const [formEmail, setFormEmail] = useState("");
    const [formRole, setFormRole] = useState<UserRole>("viewer");

    const loadUsers = useCallback(async () => {
        setError("");
        try {
            setUsers(await monitoringService.getUsers());
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadUsers();
    }, [loadUsers]);

    const replaceUser = (updated: ManagedUser) =>
        setUsers((prev) =>
            prev.map((existing) =>
                existing.id === updated.id ? updated : existing,
            ),
        );

    const editingUser =
        editingUserId === null
            ? null
            : (users.find((user) => user.id === editingUserId) ?? null);
    const roleLocked = Boolean(
        editingUser && (editingUser.is_self || editingUser.is_allowlisted),
    );
    const roleUnchanged = editingUser ? formRole === editingUser.role : false;

    const handleStartEdit = (user: ManagedUser) => {
        setEditingUserId(user.id);
        setFormRole(user.role);
        setFormEmail("");
        setError("");
    };

    const handleCancelEdit = () => {
        setEditingUserId(null);
        setFormEmail("");
        setFormRole("viewer");
        setError("");
    };

    const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError("");
        setIsSaving(true);
        try {
            if (editingUser) {
                if (!roleLocked && !roleUnchanged) {
                    replaceUser(
                        await monitoringService.setUserRole(
                            editingUser.id,
                            formRole,
                        ),
                    );
                }
            } else {
                const email = formEmail.trim();
                if (!email) return;
                const created = await monitoringService.createUser(
                    email,
                    formRole,
                );
                setUsers((prev) => [...prev, created]);
                setFormEmail("");
                setFormRole("viewer");
            }
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggleBan = async (user: ManagedUser) => {
        setError("");
        setIsSaving(true);
        try {
            replaceUser(
                await monitoringService.setUserBanned(user.id, !user.is_banned),
            );
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsSaving(false);
        }
    };

    const activeCount = users.filter((user) => !user.is_banned).length;

    const renderAvatar = (user: ManagedUser, size: string) =>
        user.picture ? (
            <img
                src={user.picture}
                alt={user.name ?? user.email}
                className={`${size} shrink-0 rounded-full object-cover`}
            />
        ) : (
            <span
                className={`${size} grid shrink-0 place-items-center rounded-full bg-slate-700 text-sm font-semibold text-white`}
            >
                {(user.name || user.email).trim().charAt(0).toUpperCase()}
            </span>
        );

    return (
        <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
            <div className="mx-auto max-w-7xl space-y-6">
                <section className="glass-card rounded-xl p-6">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                                Access Control
                            </p>
                            <h1 className="mt-2 text-2xl font-semibold">
                                Users
                            </h1>
                            <p className="mt-2 text-sm text-slate-600">
                                Manage who can sign in, their permission level,
                                and whether their access is suspended.
                            </p>
                        </div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:max-w-md md:grid-cols-3">
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">Total Users</p>
                            <p className="font-semibold">{users.length}</p>
                        </div>
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">Active</p>
                            <p className="font-semibold">{activeCount}</p>
                        </div>
                        <div className="rounded-lg border border-white/60 bg-white/45 p-3">
                            <p className="text-slate-500">Banned</p>
                            <p className="font-semibold">
                                {users.length - activeCount}
                            </p>
                        </div>
                    </div>
                </section>

                {error && (
                    <div className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
                        {error}
                    </div>
                )}

                <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
                    <section className="glass-card rounded-xl p-5">
                        <h2 className="text-lg font-semibold">All Users</h2>
                        {isLoading ? (
                            <p className="mt-3 text-sm text-slate-500">
                                Loading...
                            </p>
                        ) : users.length === 0 ? (
                            <p className="mt-3 text-sm text-slate-500">
                                No users yet. Add one from the form on the right.
                            </p>
                        ) : (
                            <ul className="mt-4 space-y-3">
                                {users.map((user) => {
                                    const isSelected = user.id === editingUserId;
                                    return (
                                        <li key={user.id}>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleStartEdit(user)
                                                }
                                                className={`flex w-full items-center gap-3 rounded-lg border p-4 text-left transition ${
                                                    isSelected
                                                        ? "border-slate-400 bg-white/70 ring-2 ring-slate-300"
                                                        : "border-white/60 bg-white/40 hover:bg-white/60"
                                                } ${
                                                    user.is_banned
                                                        ? "opacity-70"
                                                        : ""
                                                }`}
                                            >
                                                {renderAvatar(
                                                    user,
                                                    "h-10 w-10",
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="truncate font-medium text-slate-800">
                                                            {user.name ||
                                                                user.email}
                                                        </p>
                                                        <span
                                                            className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${
                                                                ROLE_BADGE_CLASS[
                                                                    user
                                                                        .effective_role
                                                                ]
                                                            }`}
                                                        >
                                                            {user.effective_role}
                                                        </span>
                                                        {user.is_self && (
                                                            <span className="rounded-full border border-slate-200/80 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                                                                You
                                                            </span>
                                                        )}
                                                        {user.is_allowlisted && (
                                                            <span
                                                                className="flex items-center gap-1 rounded-full border border-amber-200/80 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
                                                                title="Admin seeded via CONTROL_PLANE_ADMIN_EMAILS"
                                                            >
                                                                <FaUserShield />
                                                                Seed admin
                                                            </span>
                                                        )}
                                                        {user.is_banned && (
                                                            <span className="rounded-full border border-rose-200/80 bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                                                                Banned
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="truncate text-sm text-slate-500">
                                                        {user.email}
                                                    </p>
                                                </div>
                                                <FaChevronRight className="shrink-0 text-slate-400" />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>

                    <section className="space-y-4">
                        <form
                            onSubmit={handleSubmit}
                            className="glass-card sticky top-4 rounded-xl p-5"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-lg font-semibold">
                                    {editingUser ? "Edit User" : "Add User"}
                                </h2>
                                {editingUser ? (
                                    <button
                                        type="button"
                                        onClick={handleCancelEdit}
                                        className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-white"
                                    >
                                        Cancel Edit
                                    </button>
                                ) : null}
                            </div>

                            {editingUser ? (
                                <div className="mt-4 flex items-center gap-3 rounded-lg border border-white/60 bg-white/45 p-3">
                                    {renderAvatar(editingUser, "h-10 w-10")}
                                    <div className="min-w-0">
                                        <p className="truncate font-medium text-slate-800">
                                            {editingUser.name ||
                                                editingUser.email}
                                        </p>
                                        <p className="truncate text-sm text-slate-500">
                                            {editingUser.email}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-4">
                                    <label className="block text-sm font-medium text-slate-700">
                                        Email
                                    </label>
                                    <input
                                        type="email"
                                        required
                                        value={formEmail}
                                        onChange={(event) =>
                                            setFormEmail(event.target.value)
                                        }
                                        placeholder="name@company.com"
                                        className="mt-1 w-full rounded-lg border border-slate-300/80 px-3 py-2 text-sm text-slate-700"
                                    />
                                    <p className="mt-1 text-xs text-slate-500">
                                        Name and profile photo are filled in when
                                        they first sign in with Google.
                                    </p>
                                </div>
                            )}

                            <div className="mt-4">
                                <label className="block text-sm font-medium text-slate-700">
                                    Role
                                </label>
                                <select
                                    value={formRole}
                                    disabled={roleLocked || isSaving}
                                    onChange={(event) =>
                                        setFormRole(
                                            event.target.value as UserRole,
                                        )
                                    }
                                    className="mt-1 w-full rounded-lg border border-slate-300/80 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {USER_ROLE_OPTIONS.map((option) => (
                                        <option
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                                {roleLocked && (
                                    <p className="mt-1 text-xs text-amber-700">
                                        {editingUser?.is_self
                                            ? "You can't change your own role."
                                            : "Role is managed by CONTROL_PLANE_ADMIN_EMAILS."}
                                    </p>
                                )}
                            </div>

                            <button
                                type="submit"
                                disabled={
                                    isSaving ||
                                    (editingUser
                                        ? roleLocked || roleUnchanged
                                        : !formEmail.trim())
                                }
                                className="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSaving
                                    ? "Saving…"
                                    : editingUser
                                      ? "Save changes"
                                      : "Add user"}
                            </button>

                            {editingUser && (
                                <div className="mt-4 border-t border-white/50 pt-4">
                                    <button
                                        type="button"
                                        disabled={
                                            editingUser.is_self ||
                                            editingUser.is_allowlisted ||
                                            isSaving
                                        }
                                        onClick={() =>
                                            void handleToggleBan(editingUser)
                                        }
                                        className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                            editingUser.is_banned
                                                ? "border-emerald-200/80 bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100"
                                                : "border-rose-200/80 bg-rose-50/80 text-rose-700 hover:bg-rose-100"
                                        }`}
                                    >
                                        {editingUser.is_banned ? (
                                            <>
                                                <FaUndo />
                                                Unban user
                                            </>
                                        ) : (
                                            <>
                                                <FaBan />
                                                Ban user
                                            </>
                                        )}
                                    </button>
                                    {(editingUser.is_self ||
                                        editingUser.is_allowlisted) && (
                                        <p className="mt-1 text-center text-xs text-slate-500">
                                            {editingUser.is_self
                                                ? "You can't ban yourself."
                                                : "Seeded admins can't be banned."}
                                        </p>
                                    )}
                                </div>
                            )}
                        </form>
                    </section>
                </section>
            </div>
        </main>
    );
}

const AUDIT_ACTION_BADGE: Record<string, string> = {
    create: "bg-emerald-100 text-emerald-700 border-emerald-200/80",
    update: "bg-cyan-100 text-cyan-700 border-cyan-200/80",
    delete: "bg-rose-100 text-rose-700 border-rose-200/80",
    pause: "bg-amber-100 text-amber-700 border-amber-200/80",
    resume: "bg-emerald-100 text-emerald-700 border-emerald-200/80",
    ban: "bg-rose-100 text-rose-700 border-rose-200/80",
    unban: "bg-emerald-100 text-emerald-700 border-emerald-200/80",
    role_change: "bg-indigo-100 text-indigo-700 border-indigo-200/80",
    settings: "bg-slate-100 text-slate-600 border-slate-200/80",
    clear_history: "bg-amber-100 text-amber-700 border-amber-200/80",
};

const formatAuditTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
};

const AUDIT_TRUNCATE_OPTIONS: Array<{
    value: string;
    label: string;
    confirm: string;
}> = [
    {
        value: "3m",
        label: "Keep last 3 months",
        confirm: "Delete all audit entries older than 3 months?",
    },
    {
        value: "1m",
        label: "Keep last 1 month",
        confirm: "Delete all audit entries older than 1 month?",
    },
    {
        value: "1w",
        label: "Keep last 1 week",
        confirm: "Delete all audit entries older than 1 week?",
    },
    {
        value: "1d",
        label: "Keep last 1 day",
        confirm: "Delete all audit entries older than 1 day?",
    },
    {
        value: "all",
        label: "Clear all",
        confirm: "Permanently delete ALL audit log entries?",
    },
];

function AuditLogPage() {
    const [entries, setEntries] = useState<AuditLogEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const [truncatePeriod, setTruncatePeriod] = useState("3m");
    const [isTruncating, setIsTruncating] = useState(false);

    const loadEntries = useCallback(async () => {
        setError("");
        try {
            setEntries(await monitoringService.getAuditLogs(200));
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadEntries();
    }, [loadEntries]);

    const handleTruncate = async () => {
        const option = AUDIT_TRUNCATE_OPTIONS.find(
            (item) => item.value === truncatePeriod,
        );
        if (!option) return;
        if (
            typeof window !== "undefined" &&
            !window.confirm(option.confirm)
        ) {
            return;
        }
        setIsTruncating(true);
        setError("");
        try {
            await monitoringService.truncateAuditLogs(truncatePeriod);
            await loadEntries();
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsTruncating(false);
        }
    };

    return (
        <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
            <div className="mx-auto max-w-5xl space-y-6">
                <section className="glass-card rounded-xl p-6">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                                Activity
                            </p>
                            <h1 className="mt-2 text-2xl font-semibold">
                                Audit Log
                            </h1>
                            <p className="mt-2 text-sm text-slate-600">
                                Recent changes to monitors, crons, and users —
                                most recent first.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void loadEntries()}
                            className="rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-xs font-medium text-slate-700 backdrop-blur transition hover:bg-white/80"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="mt-5 flex flex-col gap-2 border-t border-white/50 pt-4 sm:flex-row sm:items-center">
                        <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
                            Retention
                        </span>
                        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                            <select
                                value={truncatePeriod}
                                onChange={(event) =>
                                    setTruncatePeriod(event.target.value)
                                }
                                disabled={isTruncating}
                                className="rounded-lg border border-slate-300/80 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60"
                            >
                                {AUDIT_TRUNCATE_OPTIONS.map((option) => (
                                    <option
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={() => void handleTruncate()}
                                disabled={isTruncating}
                                className="flex items-center justify-center gap-1.5 rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <FaBan />
                                {isTruncating ? "Truncating…" : "Truncate"}
                            </button>
                        </div>
                    </div>
                </section>

                {error && (
                    <div className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
                        {error}
                    </div>
                )}

                <section className="glass-card rounded-xl p-4 md:p-6">
                    {isLoading ? (
                        <p className="px-2 py-6 text-sm text-slate-500">
                            Loading activity…
                        </p>
                    ) : entries.length === 0 ? (
                        <p className="px-2 py-6 text-sm text-slate-500">
                            No activity recorded yet.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {entries.map((entry) => (
                                <li
                                    key={entry.id}
                                    className="flex flex-col gap-2 rounded-lg border border-white/60 bg-white/45 p-3 sm:flex-row sm:items-center sm:justify-between"
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <span
                                            className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${
                                                AUDIT_ACTION_BADGE[
                                                    entry.action
                                                ] ??
                                                "bg-slate-100 text-slate-600 border-slate-200/80"
                                            }`}
                                        >
                                            {entry.action.replace("_", " ")}
                                        </span>
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-slate-800">
                                                {entry.summary}
                                            </p>
                                            <p className="truncate text-xs text-slate-500">
                                                {entry.entity_type}
                                                {entry.actor_email
                                                    ? ` · by ${entry.actor_name || entry.actor_email}`
                                                    : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-xs text-slate-500 sm:text-right">
                                        {formatAuditTime(entry.created_at)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </main>
    );
}

function App() {
    const pathname =
        typeof window !== "undefined" ? window.location.pathname : "/";
    const isHomePage = pathname === "/";
    const isStatusPage = pathname.startsWith("/status");
    const isLoginPage = pathname.startsWith("/login");
    const isUsersPage = pathname.startsWith("/users");
    const isAuditPage = pathname.startsWith("/audit");
    const isMetricsPage = pathname.startsWith("/metrics");
    // Catch-all for authenticated pages; metrics is one of them (kept inside the
    // umbrella so the existing session-check / redirect / loading gates apply).
    const isMonitorsPage =
        pathname.startsWith("/monitors") ||
        (!isHomePage && !isStatusPage && !isLoginPage);

    const [health, setHealth] = useState<HealthSummary>({
        status: "checking",
        endpointCount: 0,
    });
    const [groups, setGroups] = useState<MonitorGroup[]>([]);
    const [endpoints, setEndpoints] = useState<MonitorEndpoint[]>([]);
    const [runsByEndpoint, setRunsByEndpoint] = useState<RunsByEndpoint>({});
    const [statusViewMode, setStatusViewMode] =
        useState<StatsMode>("aggregate");
    const [statusGranularity, setStatusGranularity] =
        useState<StatsGranularity>("hour");
    const [statusRangeDays, setStatusRangeDays] = useState(7);
    const [endpointForm, setEndpointForm] = useState(INITIAL_ENDPOINT_FORM);
    const [editingEndpointId, setEditingEndpointId] = useState<number | null>(
        null,
    );
    const [crons, setCrons] = useState<CronJob[]>([]);
    const [cronForm, setCronForm] = useState(INITIAL_CRON_FORM);
    const [editingCronName, setEditingCronName] = useState<string | null>(
        null,
    );
    const [isSavingCron, setIsSavingCron] = useState(false);
    const [statusTab, setStatusTab] = useState<StatusTab>("services");
    const [cronMonitorEnabled, setCronMonitorEnabled] = useState(false);
    const [cronMonitorMeta, setCronMonitorMeta] = useState<CronMonitorMeta>({
        updatedBy: null,
        updatedAt: null,
    });
    const [cronRunsByName, setCronRunsByName] = useState<CronRunsByName>({});
    const [cronRunsMode, setCronRunsMode] = useState<CronRunsMode>("recent");
    const [cronWindowDays, setCronWindowDays] = useState(7);
    const [isLoading, setIsLoading] = useState(true);
    const [isSavingEndpoint, setIsSavingEndpoint] = useState(false);
    const [error, setError] = useState("");
    const [currentTimeMs, setCurrentTimeMs] = useState(Date.now());
    const [authChecked, setAuthChecked] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [canEdit, setCanEdit] = useState(false);
    const [canManageUsers, setCanManageUsers] = useState(false);
    const [user, setUser] = useState<SessionUser | null>(null);
    const [authError, setAuthError] = useState("");
    const apiBase = import.meta.env.VITE_API_BASE_URL || "";

    const groupedEndpoints = useMemo((): GroupWithEndpoints[] => {
        return groups.map((group) => ({
            ...group,
            endpoints: endpoints.filter(
                (endpoint) => endpoint.group_id === group.id,
            ),
            group_status: getGroupStatus(
                endpoints.filter((endpoint) => endpoint.group_id === group.id),
            ),
        }));
    }, [groups, endpoints]);

    useEffect(() => {
        if (!isMonitorsPage && !isLoginPage) {
            setAuthChecked(true);
            return;
        }

        const verifySession = async () => {
            setAuthError("");
            try {
                const sessionState = await monitoringService.getSession();
                const authenticated = Boolean(sessionState?.authenticated);
                setIsAuthenticated(authenticated);
                setCanEdit(Boolean(sessionState?.canEdit));
                setCanManageUsers(Boolean(sessionState?.canManageUsers));
                setUser(sessionState?.user ?? null);
            } catch (requestError) {
                setIsAuthenticated(false);
                setCanEdit(false);
                setCanManageUsers(false);
                setUser(null);
                setAuthError(getErrorMessage(requestError));
            } finally {
                setAuthChecked(true);
            }
        };

        void verifySession();
    }, [isLoginPage, isMonitorsPage]);

    useEffect(() => {
        if (!isMonitorsPage) return;
        if (!authChecked) return;
        if (isAuthenticated) return;
        const returnTo = encodeURIComponent(pathname || "/monitors");
        window.location.replace(`/login?returnTo=${returnTo}`);
    }, [authChecked, isAuthenticated, isMonitorsPage, pathname]);

    const loadRuns = useCallback(
        async (
            endpointList: MonitorEndpoint[],
            options: {
                mode?: StatsMode;
                granularity?: StatsGranularity;
                rangeDays?: number;
            } = {},
        ) => {
            const runEntries = await Promise.all(
                endpointList.map(
                    async (endpoint): Promise<[number, RunPoint[]]> => {
                        try {
                            const response =
                                await monitoringService.getEndpointRuns(
                                    endpoint.id,
                                    options,
                                );
                            return [endpoint.id, response?.points ?? []];
                        } catch {
                            return [endpoint.id, []];
                        }
                    },
                ),
            );

            setRunsByEndpoint(Object.fromEntries(runEntries));
        },
        [],
    );

    const loadCronRuns = useCallback(
        async (cronList: CronJob[]) => {
            const options =
                cronRunsMode === "window"
                    ? { rangeDays: cronWindowDays, limit: 500 }
                    : { limit: 50 };

            const entries = await Promise.all(
                cronList.map(
                    async (cronJob): Promise<[string, CronRunSummary[]]> => {
                        try {
                            const rows = await monitoringService.getCronRuns(
                                cronJob.cron,
                                options,
                            );
                            return [
                                cronJob.cron,
                                Array.isArray(rows) ? rows : [],
                            ];
                        } catch {
                            return [cronJob.cron, []];
                        }
                    },
                ),
            );

            setCronRunsByName(Object.fromEntries(entries));
        },
        [cronRunsMode, cronWindowDays],
    );

    const loadData = useCallback(async () => {
        if (isHomePage || isLoginPage) {
            setIsLoading(false);
            return;
        }
        if (isMonitorsPage && !isAuthenticated) {
            setIsLoading(false);
            return;
        }

        setError("");
        try {
            const [healthRes, groupsRes, endpointsRes] = await Promise.all([
                monitoringService.getHealth(),
                monitoringService.getGroups(),
                monitoringService.getEndpoints(),
            ]);

            setHealth(healthRes);
            setGroups(groupsRes);
            setEndpoints(endpointsRes);

            setEndpointForm((current) =>
                !current.group_name && groupsRes.length
                    ? { ...current, group_name: groupsRes[0].name }
                    : current,
            );

            if (isMonitorsPage) {
                try {
                    const settings = await monitoringService.getCronSettings();
                    setCronMonitorEnabled(Boolean(settings?.enabled));
                    setCronMonitorMeta({
                        updatedBy: settings?.updatedBy ?? null,
                        updatedAt: settings?.updatedAt ?? null,
                    });
                } catch {
                    setCronMonitorEnabled(false);
                }
            }

            if (isMonitorsPage || isStatusPage) {
                try {
                    const cronsRes = await monitoringService.getCrons();
                    const sortedCrons = Array.isArray(cronsRes)
                        ? [...cronsRes].sort((left, right) =>
                              String(left.cron).localeCompare(
                                  String(right.cron),
                              ),
                          )
                        : [];
                    setCrons(sortedCrons);

                    if (isStatusPage) {
                        await loadCronRuns(sortedCrons);
                    }
                } catch {
                    setCrons([]);
                }
            }

            if (isStatusPage) {
                await loadRuns(endpointsRes, {
                    mode: statusViewMode,
                    granularity: statusGranularity,
                    rangeDays: statusRangeDays,
                });
            }
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsLoading(false);
        }
    }, [
        isStatusPage,
        loadRuns,
        loadCronRuns,
        statusGranularity,
        statusRangeDays,
        statusViewMode,
        isHomePage,
        isLoginPage,
        isMonitorsPage,
        isAuthenticated,
    ]);

    useEffect(() => {
        const allowedRanges = STATUS_RANGE_OPTIONS[statusGranularity];
        if (
            !allowedRanges.some((option) => option.value === statusRangeDays)
        ) {
            setStatusRangeDays(allowedRanges[0].value);
        }
    }, [statusGranularity, statusRangeDays]);

    useEffect(() => {
        if ((isMonitorsPage || isLoginPage) && !authChecked) return;
        void loadData();
    }, [isStatusPage, isMonitorsPage, isLoginPage, authChecked, loadData]);

    useEffect(() => {
        setHealth((current) => ({
            ...current,
            endpointCount: endpoints.length,
        }));
    }, [endpoints.length]);

    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTimeMs(Date.now());
        }, 30000);

        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (isHomePage || isLoginPage) return;

        const toWebSocketUrl = () => {
            if (apiBase) {
                if (apiBase.startsWith("https://"))
                    return `${apiBase.replace("https://", "wss://")}/ws`;
                if (apiBase.startsWith("http://"))
                    return `${apiBase.replace("http://", "ws://")}/ws`;
            }

            if (typeof window !== "undefined") {
                const protocol =
                    window.location.protocol === "https:" ? "wss" : "ws";
                return `${protocol}://${window.location.host}/ws`;
            }

            return "";
        };

        const wsUrl = toWebSocketUrl();
        if (!wsUrl) return;

        const socket = new WebSocket(wsUrl);

        socket.onmessage = (event: MessageEvent<string>) => {
            try {
                const message = JSON.parse(event.data) as {
                    type?: string;
                    payload?: unknown;
                };

                if (message?.type === "monitor:checked") {
                    const payload = (message.payload ??
                        {}) as Partial<EndpointCheckResult>;
                    setCurrentTimeMs(Date.now());
                    setEndpoints((current) =>
                        current.map((endpoint) =>
                            endpoint.id === payload.endpointId
                                ? {
                                      ...endpoint,
                                      status: payload.status ?? endpoint.status,
                                      last_response_code:
                                          payload.responseCode ??
                                          endpoint.last_response_code,
                                      last_checked_at:
                                          payload.lastCheckedAt ??
                                          endpoint.last_checked_at,
                                      last_error: payload.lastError ?? null,
                                      last_match_value:
                                          payload.lastMatchValue ??
                                          endpoint.last_match_value,
                                      consecutive_failures:
                                          payload.consecutiveFailures ??
                                          endpoint.consecutive_failures,
                                      consecutive_successes:
                                          payload.consecutiveSuccesses ??
                                          endpoint.consecutive_successes,
                                  }
                                : endpoint,
                        ),
                    );

                    setRunsByEndpoint((current) => {
                        const endpointId = payload.endpointId;
                        if (!endpointId) return current;

                        return {
                            ...current,
                            [endpointId]: mergeRealtimeRun(
                                current[endpointId] ?? [],
                                payload,
                                statusViewMode,
                                statusGranularity,
                                statusRangeDays,
                            ),
                        };
                    });
                    return;
                }

                if (
                    message?.type === "group:created" ||
                    message?.type === "group:updated"
                ) {
                    const payload = (message.payload ?? {}) as MonitorGroup;
                    setGroups((current) => {
                        const index = current.findIndex(
                            (group) => group.id === payload.id,
                        );
                        if (index >= 0) {
                            const next = [...current];
                            next[index] = { ...next[index], ...payload };
                            return next;
                        }
                        return [...current, payload];
                    });
                    return;
                }

                if (message?.type === "group:deleted") {
                    const payload = (message.payload ?? {}) as { id: number };
                    setGroups((current) =>
                        current.filter((group) => group.id !== payload.id),
                    );
                    return;
                }

                if (
                    message?.type === "endpoint:created" ||
                    message?.type === "endpoint:updated"
                ) {
                    const payload = (message.payload ?? {}) as MonitorEndpoint;
                    setEndpoints((current) => {
                        const index = current.findIndex(
                            (endpoint) => endpoint.id === payload.id,
                        );
                        if (index >= 0) {
                            const next = [...current];
                            next[index] = { ...next[index], ...payload };
                            return next;
                        }
                        return [payload, ...current];
                    });
                    return;
                }

                if (message?.type === "endpoint:deleted") {
                    const payload = (message.payload ?? {}) as { id: number };
                    setEndpoints((current) =>
                        current.filter(
                            (endpoint) => endpoint.id !== payload.id,
                        ),
                    );
                    setRunsByEndpoint((current) => {
                        const next = { ...current };
                        delete next[payload.id];
                        return next;
                    });
                    return;
                }

                if (message?.type === "cron:run") {
                    const payload = (message.payload ??
                        {}) as CronRunEventPayload;
                    setCrons((current) =>
                        current.map((cronJob) =>
                            cronJob.cron === payload.cron
                                ? {
                                      ...cronJob,
                                      last_run_status:
                                          payload.status ??
                                          cronJob.last_run_status,
                                      last_run_at:
                                          payload.triggeredAt ??
                                          cronJob.last_run_at,
                                      last_run_error:
                                          payload.errorMessage ?? null,
                                  }
                                : cronJob,
                        ),
                    );
                    setCronRunsByName((current) => {
                        const existing = current[payload.cron];
                        if (!existing) return current;

                        const updatedRun = {
                            run_id: payload.runId,
                            status: payload.status,
                            trigger_type: payload.triggerType ?? null,
                            triggered_at: payload.triggeredAt ?? null,
                            completed_at: payload.completedAt ?? null,
                            pings: payload.pings ?? 0,
                            duration_ms: payload.durationMs ?? null,
                            response_code: payload.responseCode ?? null,
                            error_message: payload.errorMessage ?? null,
                        };

                        return {
                            ...current,
                            [payload.cron]: [
                                updatedRun,
                                ...existing.filter(
                                    (run) => run.run_id !== payload.runId,
                                ),
                            ].slice(0, 500),
                        };
                    });
                }
            } catch {
                // Ignore malformed websocket frames.
            }
        };

        return () => {
            socket.close();
        };
    }, [
        apiBase,
        isHomePage,
        isLoginPage,
        statusGranularity,
        statusRangeDays,
        statusViewMode,
    ]);

    const handleEndpointSubmit = async (
        event: SubmitEvent<HTMLFormElement>,
    ) => {
        event.preventDefault();
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        setIsSavingEndpoint(true);

        try {
            const normalizedGroupName = endpointForm.group_name.trim();
            if (!normalizedGroupName) throw new Error("Group name is required");

            let group =
                groups.find(
                    (candidate) =>
                        candidate.name.toLowerCase() ===
                        normalizedGroupName.toLowerCase(),
                ) ?? null;
            if (!group) {
                const createdGroup = await monitoringService.createGroup({
                    name: normalizedGroupName,
                    description: "",
                });
                group = createdGroup;
                setGroups((current) => {
                    const index = current.findIndex(
                        (existing) => existing.id === createdGroup.id,
                    );
                    if (index >= 0) {
                        const next = [...current];
                        next[index] = {
                            ...next[index],
                            ...createdGroup,
                            endpoint_count: next[index].endpoint_count ?? 0,
                        };
                        return next;
                    }
                    return [...current, { ...createdGroup, endpoint_count: 0 }];
                });
            }

            const payload = {
                ...endpointForm,
                group_id: Number(group.id),
                expected_status: Number(endpointForm.expected_status),
                interval_seconds: Number(endpointForm.interval_seconds),
                down_retries: Number(endpointForm.down_retries),
                up_retries: Number(endpointForm.up_retries),
            };

            if (editingEndpointId) {
                const updatedEndpoint = await monitoringService.updateEndpoint(
                    editingEndpointId,
                    payload,
                );
                setEndpoints((current) =>
                    current.map((endpoint) =>
                        endpoint.id === editingEndpointId
                            ? updatedEndpoint
                            : endpoint,
                    ),
                );
            } else {
                const createdEndpoint =
                    await monitoringService.createEndpoint(payload);
                setEndpoints((current) => {
                    const index = current.findIndex(
                        (endpoint) => endpoint.id === createdEndpoint.id,
                    );
                    if (index >= 0) {
                        const next = [...current];
                        next[index] = { ...next[index], ...createdEndpoint };
                        return next;
                    }
                    return [createdEndpoint, ...current];
                });
            }

            setEndpointForm(() => ({
                ...INITIAL_ENDPOINT_FORM,
                group_name: normalizedGroupName,
            }));
            setEditingEndpointId(null);
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsSavingEndpoint(false);
        }
    };

    const handleDeleteEndpoint = async (endpointId: number) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        try {
            await monitoringService.deleteEndpoint(endpointId);
            setEndpoints((current) =>
                current.filter((endpoint) => endpoint.id !== endpointId),
            );
            setRunsByEndpoint((current) => {
                const next = { ...current };
                delete next[endpointId];
                return next;
            });
            if (editingEndpointId === endpointId) {
                setEditingEndpointId(null);
                setEndpointForm(() => ({
                    ...INITIAL_ENDPOINT_FORM,
                    group_name: groups[0]?.name ?? "",
                }));
            }
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleDeleteHistory = async (endpointId: number) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        if (
            !window.confirm(
                "Delete all historical check runs for this monitor?",
            )
        )
            return;

        try {
            await monitoringService.deleteEndpointRuns(endpointId);
            setRunsByEndpoint((current) => ({ ...current, [endpointId]: [] }));
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleStartEdit = (endpoint: MonitorEndpoint) => {
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        const groupName =
            groups.find((group) => group.id === endpoint.group_id)?.name ??
            endpoint.group_name ??
            "";

        setEndpointForm({
            group_name: groupName,
            name: endpoint.name ?? "",
            monitor_type: endpoint.monitor_type ?? "http",
            url: endpoint.url ?? "",
            method: endpoint.method ?? "GET",
            headers_json: stringifyJson(endpoint.headers_json, ""),
            body_text: endpoint.body_text ?? "",
            expected_status: endpoint.expected_status ?? 200,
            expected_json_path: endpoint.expected_json_path ?? "",
            expected_json_value: endpoint.expected_json_value ?? "",
            connection_json: stringifyJson(
                endpoint.connection_json,
                DEFAULT_CONNECTION_JSON[endpoint.monitor_type] ?? "{}",
            ),
            probe_command: endpoint.probe_command ?? "",
            expected_probe_value: endpoint.expected_probe_value ?? "",
            interval_seconds: endpoint.interval_seconds ?? 60,
            down_retries: endpoint.down_retries ?? 3,
            up_retries: endpoint.up_retries ?? 1,
        });
        setEditingEndpointId(endpoint.id);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const handleCancelEdit = () => {
        setEditingEndpointId(null);
        setEndpointForm(() => ({
            ...INITIAL_ENDPOINT_FORM,
            group_name: groups[0]?.name ?? "",
        }));
    };

    const handleCheckNow = async (endpointId: number) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        try {
            await monitoringService.triggerCheck(endpointId);
            const optimisticNow = new Date().toISOString();
            setEndpoints((current) =>
                current.map((endpoint) =>
                    endpoint.id === endpointId
                        ? { ...endpoint, last_checked_at: optimisticNow }
                        : endpoint,
                ),
            );
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleTogglePause = async (endpoint: MonitorEndpoint) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        try {
            const updatedEndpoint = endpoint.is_paused
                ? await monitoringService.resumeEndpoint(endpoint.id)
                : await monitoringService.pauseEndpoint(endpoint.id);

            setEndpoints((current) => {
                const index = current.findIndex(
                    (item) => item.id === updatedEndpoint.id,
                );
                if (index >= 0) {
                    const next = [...current];
                    next[index] = { ...next[index], ...updatedEndpoint };
                    return next;
                }
                return current;
            });
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleToggleGroupPause = async (group: GroupWithEndpoints) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit monitors");
            return;
        }
        try {
            const hasMonitors = group.endpoints.length > 0;
            if (!hasMonitors) return;

            const allPaused = group.endpoints.every(
                (endpoint) => endpoint.is_paused,
            );
            const response = allPaused
                ? await monitoringService.resumeGroup(group.id)
                : await monitoringService.pauseGroup(group.id);

            const updatedById = new Map(
                (response.updatedEndpoints ?? []).map((endpoint) => [
                    endpoint.id,
                    endpoint,
                ]),
            );
            if (!updatedById.size) return;

            setEndpoints((current) =>
                current.map(
                    (endpoint) => updatedById.get(endpoint.id) ?? endpoint,
                ),
            );
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleCronSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit crons");
            return;
        }
        setIsSavingCron(true);

        try {
            const normalizedCronName = cronForm.cron.trim();
            if (!normalizedCronName) throw new Error("Cron name is required");
            if (!cronForm.expression.trim())
                throw new Error("Cron expression is required");

            const payload = {
                ...cronForm,
                cron: normalizedCronName,
                expression: cronForm.expression.trim(),
                service: cronForm.service.trim(),
                endpoint: cronForm.endpoint.trim(),
                start_window_seconds: Number(cronForm.start_window_seconds),
                ping_window_seconds: Number(cronForm.ping_window_seconds),
                track_run: cronForm.track_run ? 1 : 0,
                status: cronForm.status ? 1 : 0,
            };

            if (editingCronName) {
                const updatedCron = await monitoringService.updateCron(
                    editingCronName,
                    payload,
                );
                // Fall back to the submitted payload if the server returned no
                // body; its numeric status/track_run flags are truthy-compatible.
                const merged = (updatedCron ?? payload) as Partial<CronJob>;
                setCrons((current) =>
                    current.map((cronJob) =>
                        cronJob.cron === editingCronName
                            ? { ...cronJob, ...merged }
                            : cronJob,
                    ),
                );
            } else {
                const createdCron =
                    await monitoringService.createCron(payload);
                setCrons((current) =>
                    [
                        (createdCron ?? payload) as CronJob,
                        ...current.filter(
                            (cronJob) => cronJob.cron !== normalizedCronName,
                        ),
                    ].sort((left, right) =>
                        String(left.cron).localeCompare(String(right.cron)),
                    ),
                );
            }

            setCronForm(INITIAL_CRON_FORM);
            setEditingCronName(null);
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        } finally {
            setIsSavingCron(false);
        }
    };

    const handleStartEditCron = (cronJob: CronJob) => {
        if (!canEdit) {
            setError("You do not have permission to edit crons");
            return;
        }
        setCronForm({
            cron: cronJob.cron ?? "",
            expression: cronJob.expression ?? "",
            service: cronJob.service ?? "",
            endpoint: cronJob.endpoint ?? "",
            trigger_type: cronJob.trigger_type ?? "nats",
            http_method:
                cronJob.trigger_type === "http" &&
                cronJob.http_method !== "NONE"
                    ? cronJob.http_method
                    : cronJob.trigger_type === "http"
                      ? "GET"
                      : "NONE",
            headers_json: stringifyJson(cronJob.headers_json, ""),
            body_text: cronJob.body_text ?? "",
            nats_subject: cronJob.nats_subject || "crons.uptime_monitor",
            start_window_seconds: cronJob.start_window_seconds ?? 60,
            ping_window_seconds: cronJob.ping_window_seconds ?? 60,
            track_run: Boolean(cronJob.track_run),
            status: Boolean(cronJob.status),
        });
        setEditingCronName(cronJob.cron);
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const handleToggleCronMonitor = async () => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit crons");
            return;
        }
        try {
            const response = await monitoringService.updateCronSettings({
                enabled: !cronMonitorEnabled,
            });
            setCronMonitorEnabled(Boolean(response?.enabled));
            setCronMonitorMeta({
                updatedBy: response?.updatedBy ?? null,
                updatedAt: response?.updatedAt ?? null,
            });
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    const handleCancelCronEdit = () => {
        setEditingCronName(null);
        setCronForm(INITIAL_CRON_FORM);
    };

    const handleDeleteCron = async (cronName: string) => {
        setError("");
        if (!canEdit) {
            setError("You do not have permission to edit crons");
            return;
        }
        if (!window.confirm(`Delete cron "${cronName}"?`)) return;

        try {
            await monitoringService.deleteCron(cronName);
            setCrons((current) =>
                current.filter((cronJob) => cronJob.cron !== cronName),
            );
            if (editingCronName === cronName) {
                setEditingCronName(null);
                setCronForm(INITIAL_CRON_FORM);
            }
        } catch (requestError) {
            setError(getErrorMessage(requestError));
        }
    };

    if (isHomePage) {
        return <LandingPage />;
    }

    if (isStatusPage) {
        return (
            <StatusPage
                groups={groups}
                endpoints={endpoints}
                runsByEndpoint={runsByEndpoint}
                health={health}
                isLoading={isLoading}
                statusViewMode={statusViewMode}
                statusGranularity={statusGranularity}
                statusRangeDays={statusRangeDays}
                onViewModeChange={setStatusViewMode}
                onGranularityChange={setStatusGranularity}
                onRangeChange={setStatusRangeDays}
                statusTab={statusTab}
                onStatusTabChange={setStatusTab}
                crons={crons}
                cronRunsByName={cronRunsByName}
                cronRunsMode={cronRunsMode}
                onCronRunsModeChange={setCronRunsMode}
                cronWindowDays={cronWindowDays}
                onCronWindowDaysChange={setCronWindowDays}
                currentTimeMs={currentTimeMs}
            />
        );
    }

    if (isLoginPage) {
        return (
            <LoginPage
                apiBase={apiBase}
                isChecking={!authChecked}
                error={authError}
            />
        );
    }

    // While the session check is in flight on a protected page, show a neutral
    // loading state instead of flashing the sign-in page on every navigation.
    if (isMonitorsPage && !authChecked) {
        return (
            <main className="grid min-h-screen place-items-center px-4 text-slate-900">
                <p className="text-sm text-slate-500">Loading…</p>
            </main>
        );
    }

    if (isMonitorsPage && !isAuthenticated) {
        return (
            <LoginPage
                apiBase={apiBase}
                isChecking={!authChecked}
                error={authError}
            />
        );
    }

    return (
        <AppShell
            active={
                isMetricsPage
                    ? "metrics"
                    : isUsersPage
                      ? "users"
                      : isAuditPage
                        ? "audit"
                        : "monitors"
            }
            canManageUsers={canManageUsers}
            user={user}
        >
            {isMetricsPage ? (
                <MetricsPage canEdit={canEdit} />
            ) : isUsersPage || isAuditPage ? (
                !canManageUsers ? (
                    <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
                        <div className="mx-auto max-w-5xl">
                            <section className="glass-card rounded-xl p-6">
                                <h1 className="text-2xl font-semibold">
                                    {isAuditPage ? "Audit Log" : "Users"}
                                </h1>
                                <p className="mt-2 text-sm text-slate-600">
                                    You do not have permission to view this
                                    section.
                                </p>
                            </section>
                        </div>
                    </main>
                ) : isAuditPage ? (
                    <AuditLogPage />
                ) : (
                    <UsersPage />
                )
            ) : (
                <AdminPage
                    health={health}
                    groups={groups}
                    groupedEndpoints={groupedEndpoints}
                    endpointForm={endpointForm}
                    editingEndpointId={editingEndpointId}
                    canEdit={canEdit}
                    isLoading={isLoading}
                    isSavingEndpoint={isSavingEndpoint}
                    setEndpointForm={setEndpointForm}
                    handleCancelEdit={handleCancelEdit}
                    handleDeleteHistory={handleDeleteHistory}
                    handleEndpointSubmit={handleEndpointSubmit}
                    handleDeleteEndpoint={handleDeleteEndpoint}
                    handleCheckNow={handleCheckNow}
                    handleTogglePause={handleTogglePause}
                    handleToggleGroupPause={handleToggleGroupPause}
                    handleStartEdit={handleStartEdit}
                    crons={crons}
                    cronForm={cronForm}
                    setCronForm={setCronForm}
                    editingCronName={editingCronName}
                    isSavingCron={isSavingCron}
                    handleCronSubmit={handleCronSubmit}
                    handleCancelCronEdit={handleCancelCronEdit}
                    handleStartEditCron={handleStartEditCron}
                    handleDeleteCron={handleDeleteCron}
                    cronMonitorEnabled={cronMonitorEnabled}
                    cronMonitorMeta={cronMonitorMeta}
                    handleToggleCronMonitor={handleToggleCronMonitor}
                    currentTimeMs={currentTimeMs}
                    error={error}
                />
            )}
        </AppShell>
    );
}

export default App;
