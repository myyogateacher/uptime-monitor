import { config } from "./config.js";

const isValidEvent = (status) => status === "up" || status === "down";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const postJson = async (url, payload, headers = {}) => {
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

const buildSlackPayload = (event) => {
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

const buildWebhookPayload = (event) => {
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

const notifyTarget = async (target, event) => {
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

export async function notifyStatusChange(event) {
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
                !target.events.includes(event.currentStatus)
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

setTimeout(() => {
    console.log("[notify] notifier initialized");
    notifyStatusChange({
        endpointId: 12,
        endpointName: "Payments API",
        groupId: 3,
        groupName: "Payments",
        monitorType: "http",
        url: "https://api.example.com/payments/health",
        previousStatus: "up",
        currentStatus: "down",
        responseCode: 503,
        responseTimeMs: 1842,
        checkedAt: "2026-02-20T15:30:00.000Z",
        errorMessage: "Expected HTTP 200, got 503",
        matchedValue: null,
    });
}, 2000);
