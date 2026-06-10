import { config, type NotificationTarget } from './config'

export type MonitorStatusChangeEvent = {
    endpointId: number;
    endpointName: string;
    groupId: number;
    groupName: string | null;
    monitorType: string;
    url: string;
    previousStatus: string | null;
    currentStatus: string;
    responseCode: number | null;
    responseTimeMs: number | null;
    checkedAt: string;
    errorMessage: string | null;
    matchedValue: string | null;
};

export type CronRunNotificationEvent = {
    cron: string;
    runId: string;
    outcome: string;
    expression: string | null;
    service: string | null;
    triggerType: string | null;
    pings: number;
    triggeredAt: string | Date | null;
    firstPingAt: string | Date | null;
    lastPingAt: string | Date | null;
    durationMs: number | null;
    reason: string | null;
};

type JsonPayload = Record<string, unknown>;

const isValidEvent = (status: unknown): boolean =>
    status === "up" || status === "down";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const postJson = async (
    url: string,
    payload: JsonPayload,
    headers: Record<string, string> = {},
): Promise<void> => {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `Notification request failed (${response.status}): ${body || "no response body"}`,
        );
    }
};

const buildSlackPayload = (event: MonitorStatusChangeEvent): JsonPayload => {
    const isUp = event.currentStatus === "up";
    const title = isUp ? "Monitor UP" : "Monitor DOWN";
    const color = isUp ? "#16a34a" : "#dc2626";
    const environment = String(config.nodeEnv ?? "unknown");
    const checkedAt = new Date(event.checkedAt).toISOString();

    return {
        text: `[${environment}] ${title}: ${event.endpointName}`,
        attachments: [
            {
                color,
                title: `[${environment}] ${title}: ${event.endpointName}`,
                fields: [
                    {
                        title: "Status",
                        value: String(
                            event.currentStatus ?? "n/a",
                        ).toUpperCase(),
                        short: true,
                    },
                    {
                        title: "Previous",
                        value: String(
                            event.previousStatus ?? "n/a",
                        ).toUpperCase(),
                        short: true,
                    },
                    {
                        title: "Group",
                        value: event.groupName ?? `#${event.groupId}`,
                        short: true,
                    },
                    {
                        title: "Type",
                        value: String(
                            event.monitorType ?? "http",
                        ).toUpperCase(),
                        short: true,
                    },
                    {
                        title: "Response Code",
                        value: String(event.responseCode ?? "n/a"),
                        short: true,
                    },
                    {
                        title: "Latency",
                        value: `${event.responseTimeMs ?? "n/a"} ms`,
                        short: true,
                    },
                    { title: "Checked At", value: checkedAt, short: false },
                    { title: "URL", value: event.url ?? "n/a", short: false },
                    ...(event.errorMessage
                        ? [
                              {
                                  title: "Error",
                                  value: String(event.errorMessage),
                                  short: false,
                              },
                          ]
                        : []),
                    ...(event.matchedValue != null
                        ? [
                              {
                                  title: "Matched Value",
                                  value: String(event.matchedValue),
                                  short: false,
                              },
                          ]
                        : []),
                ],
            },
        ],
    };
};

const buildWebhookPayload = (event: MonitorStatusChangeEvent): JsonPayload => {
    return {
        source: "uptime-monitor",
        eventType: "monitor.status_changed",
        currentStatus: event.currentStatus,
        previousStatus: event.previousStatus,
        endpoint: {
            id: event.endpointId,
            name: event.endpointName,
            groupId: event.groupId,
            groupName: event.groupName ?? null,
            monitorType: event.monitorType,
            url: event.url,
        },
        check: {
            responseCode: event.responseCode,
            responseTimeMs: event.responseTimeMs,
            checkedAt: event.checkedAt,
            errorMessage: event.errorMessage ?? null,
            matchedValue: event.matchedValue ?? null,
        },
    };
};

const notifyTarget = async (
    target: NotificationTarget,
    event: MonitorStatusChangeEvent,
): Promise<void> => {
    if (target.type === "slack") {
        const response = await fetch(SLACK_POST_MESSAGE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${target.token}`,
            },
            body: JSON.stringify({
                channel: target.channel,
                ...buildSlackPayload(event),
            }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
            const reason = payload?.error ?? "unknown_error";
            throw new Error(
                `Slack chat.postMessage failed (${response.status}): ${reason}`,
            );
        }
        return;
    }

    await postJson(target.url, buildWebhookPayload(event), target.headers);
};

const formatCronTimestamp = (
    value: string | number | Date | null | undefined,
): string => {
    if (!value) return "n/a";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "n/a";
    return date.toISOString();
};

const buildCronSlackPayload = (event: CronRunNotificationEvent): JsonPayload => {
    const title = `Cron ${String(event.outcome ?? "failed").toUpperCase()}`;
    const environment = String(config.nodeEnv ?? "unknown");
    const duration =
        event.durationMs == null
            ? "n/a"
            : `${(Number(event.durationMs) / 1000).toFixed(2)}s`;

    return {
        text: `[${environment}] ${title}: ${event.cron}`,
        attachments: [
            {
                color: "#dc2626",
                title: `[${environment}] ${title}: ${event.cron}`,
                fields: [
                    {
                        title: "Cron",
                        value: String(event.cron ?? "n/a"),
                        short: true,
                    },
                    {
                        title: "Outcome",
                        value: String(event.outcome ?? "n/a").toUpperCase(),
                        short: true,
                    },
                    {
                        title: "Run ID",
                        value: String(event.runId ?? "n/a"),
                        short: false,
                    },
                    {
                        title: "Expression",
                        value: String(event.expression ?? "n/a"),
                        short: true,
                    },
                    {
                        title: "Trigger",
                        value: String(event.triggerType ?? "n/a").toUpperCase(),
                        short: true,
                    },
                    {
                        title: "Duration",
                        value: duration,
                        short: true,
                    },
                    {
                        title: "Pings",
                        value: String(event.pings ?? 0),
                        short: true,
                    },
                    {
                        title: "First Ping",
                        value: formatCronTimestamp(event.firstPingAt),
                        short: true,
                    },
                    {
                        title: "Last Ping",
                        value: formatCronTimestamp(event.lastPingAt),
                        short: true,
                    },
                    ...(event.service
                        ? [
                              {
                                  title: "Service",
                                  value: String(event.service),
                                  short: true,
                              },
                          ]
                        : []),
                    {
                        title: "Reason",
                        value: String(event.reason ?? "unknown"),
                        short: false,
                    },
                ],
            },
        ],
    };
};

const buildCronWebhookPayload = (
    event: CronRunNotificationEvent,
): JsonPayload => {
    return {
        source: "uptime-monitor",
        eventType: "cron.run_failed",
        outcome: event.outcome,
        cron: {
            name: event.cron,
            expression: event.expression ?? null,
            service: event.service ?? null,
            triggerType: event.triggerType ?? null,
        },
        run: {
            runId: event.runId,
            pings: event.pings ?? 0,
            triggeredAt: event.triggeredAt ?? null,
            firstPingAt: event.firstPingAt ?? null,
            lastPingAt: event.lastPingAt ?? null,
            durationMs: event.durationMs ?? null,
            reason: event.reason ?? null,
        },
    };
};

const notifyCronTarget = async (
    target: NotificationTarget,
    event: CronRunNotificationEvent,
): Promise<void> => {
    if (target.type === "slack") {
        const response = await fetch(SLACK_POST_MESSAGE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${target.token}`,
            },
            body: JSON.stringify({
                channel: target.channel,
                ...buildCronSlackPayload(event),
            }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
            const reason = payload?.error ?? "unknown_error";
            throw new Error(
                `Slack chat.postMessage failed (${response.status}): ${reason}`,
            );
        }
        return;
    }

    await postJson(target.url, buildCronWebhookPayload(event), target.headers);
};

export async function notifyCronRun(
    event: CronRunNotificationEvent,
): Promise<void> {
    console.log(
        `[notify] cron run outcome cron=${event.cron} run=${event.runId} outcome=${event.outcome}`,
    );
    if (!config.notifications.enabled) return;
    if (
        !Array.isArray(config.notifications.targets) ||
        !config.notifications.targets.length
    )
        return;

    // Failed/missed runs map to 'down' for the existing per-target event filter.
    const mappedEvent = event.outcome === "success" ? "up" : "down";

    await Promise.all(
        config.notifications.targets.map(async (target) => {
            if (
                Array.isArray(target.events) &&
                !target.events.includes(mappedEvent)
            )
                return;

            try {
                await notifyCronTarget(target, event);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[notify] target=${target.name || target.type} cron=${event.cron} failed: ${message}`,
                );
            }
        }),
    );
}

export async function notifyStatusChange(
    event: MonitorStatusChangeEvent,
): Promise<void> {
    console.log(
        `[notify] status change detected for endpoint=${event.endpointId} status=${event.currentStatus}`,
    );
    if (!config.notifications.enabled) return;
    if (!isValidEvent(event.currentStatus)) return;
    if (
        !Array.isArray(config.notifications.targets) ||
        !config.notifications.targets.length
    )
        return;

    await Promise.all(
        config.notifications.targets.map(async (target) => {
            if (
                Array.isArray(target.events) &&
                !target.events.includes(event.currentStatus as "up" | "down")
            )
                return;

            try {
                await notifyTarget(target, event);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `[notify] target=${target.name || target.type} event=${event.currentStatus} failed: ${message}`,
                );
            }
        }),
    );
}
