# Send usage to your observability tool

quota-router can export its totals to any tool that accepts OpenTelemetry (OTLP) over HTTP: an OpenTelemetry Collector, Grafana, Datadog, Honeycomb and others. It is off by default, and nothing leaves your machine until you turn it on.

## Turn it on

Add a `telemetry` block to the plugin's options in `opencode.jsonc`:

```jsonc
"telemetry": {
  "enabled": true,
  "endpoint": "https://otel.example.com:4318",
  "headers": { "authorization": "Bearer <your key>" }
}
```

`endpoint` is the base URL of the collector; quota-router adds `/v1/metrics` and `/v1/logs`. Run `/router doctor` to see whether the export works, where it goes and what identifies you in it.

If the endpoint is already in `opencode.jsonc`, or your company sets the standard `OTEL_*` environment variables, `/router telemetry on` and `/router telemetry off` switch the export without editing the file.

## What is sent

Every minute, as metrics:

| Metric | Type | Attributes |
|---|---|---|
| `quota_router.tokens` | counter | `provider`, `model`, `type` (`input`, `output`, `reasoning`, `cache_read`, `cache_write`) |
| `quota_router.cost.equivalent_usd` | counter | `provider`, `model`. What the usage would cost at pay-per-use prices |
| `quota_router.cost.actual_usd` | counter | `provider`, `model`. What it cost on pay-per-use providers |
| `quota_router.requests` | counter | `provider`, `model`, `kind` |
| `quota_router.requests.failed` | counter | `provider`, `model`, `kind` |
| `quota_router.fallbacks` | counter | `from_provider`, `to_provider`, `reason_kind` |
| `quota_router.overage.avoided_usd` | counter | `provider`, `model`. Pay-per-use value of requests a fallback served, less what they cost |
| `quota_router.limited.duration` | counter, seconds | `provider`, `pool`, `kind` |
| `quota_router.plan.utilization` | gauge, 0–100 | `provider`, `window` (`5h`, `weekly`, `monthly`), `plan` where known |
| `quota_router.plan.allowance.used` / `.total` | gauge | `provider`, `allowance`, `unit`, `plan` where known |

The plan gauges need the usage checks (`claude.usageProbe`, `copilot.usageProbe`) and are only sent while a reading is less than 30 minutes old.

With `"level": "events"`, also one log record per routing event:

| Event | Attributes |
|---|---|
| `quota_router.limit_hit` | `provider`, `kind`, `reset_at`, `session.id` |
| `quota_router.switch` | `from`, `to`, `trigger`, `session.id` |
| `quota_router.recovered` | `from`, `to`, `trigger`, `session.id` |
| `quota_router.exhausted` | `session.id`, `wait_seconds` |

Every request carries the resource attributes `service.name` (`quota-router`) and `service.version`.

## What is never sent

Prompts, responses, code, file names, tool arguments, session titles and error messages are never read by the exporter. By default nothing identifies you, your machine or your projects either:

- **Identity** is opt-in. Set any of `telemetry.identity.email` (an address, or `"git"` to read `git config --global user.email`), `userId`, `organizationId`, or `hostName: true`. They are sent as `user.email`, `user.id`, `organization.id` and `host.name`, the names Claude Code's telemetry uses, so the two can be joined.
- **Projects** are off by default. `"projects": "hashed"` adds a `project` attribute holding a short hash of the project folder's path; `"names"` sends the folder's name.
- **History** stays local. Turning the export on starts from that moment; turning it off discards anything not yet sent, and what happens while it is off is not sent later.

## Settings

| Option | Default | What it does |
|---|---|---|
| `telemetry.enabled` | false | Turn the export on |
| `telemetry.endpoint` | (from `OTEL_EXPORTER_OTLP_ENDPOINT`) | Base URL of the collector |
| `telemetry.headers` | `{}` | Request headers, such as an API key. Never logged or shown |
| `telemetry.level` | `totals` | `totals` sends metrics; `events` also sends the log records above |
| `telemetry.projects` | `off` | `off`, `hashed` or `names` |
| `telemetry.identity` | all empty | `email`, `userId`, `organizationId`, `hostName` |
| `telemetry.attributes` | `{}` | Extra resource attributes, for example `{ "team": "platform" }` |
| `telemetry.intervalMs` | 60000 | Time between exports (10 seconds to 1 hour) |
| `telemetry.temporality` | `delta` | `delta` or `cumulative` counters |
| `telemetry.protocol` | `http/json` | Only `http/json` is supported |

Settings win over the environment, and the environment fills in what the settings leave out: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` and `OTEL_SDK_DISABLED`. The environment never turns the export on by itself; `telemetry.enabled` must be true.

## Safety rules

- The endpoint must use `https`. Plain `http` is accepted only for a collector on the same machine (`localhost`, `127.0.0.1`, `[::1]`).
- The endpoint must not contain a user name or password; put credentials in `headers`.
- Redirects are refused, so headers are never passed to another host.
- `telemetry.endpoint` and `telemetry.headers` can only be set in `opencode.jsonc` or the environment. Nothing that reaches the dashboard or runs a command can change where your data goes.
- Header values are never written to the log, the dashboard or the health check; only their names are shown.

## Delivery

Requests the collector cannot take yet (no connection, or HTTP 429, 502, 503, 504) are kept and retried in order, honouring `Retry-After`. Up to 500 requests or 24 hours are kept; older ones are dropped. A request the collector refuses with any other status is dropped and reported by `/router doctor`.

## Examples

**OpenTelemetry Collector on the same machine**

```jsonc
"telemetry": { "enabled": true, "endpoint": "http://localhost:4318" }
```

```yaml
# collector config
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  debug: {}
service:
  pipelines:
    metrics: { receivers: [otlp], exporters: [debug] }
    logs: { receivers: [otlp], exporters: [debug] }
```

**Grafana Cloud, Prometheus or Mimir**

These store cumulative counters, so set `temporality`. The endpoint and the Basic credentials are on your stack's OpenTelemetry page.

```jsonc
"telemetry": {
  "enabled": true,
  "endpoint": "https://otlp-gateway-<region>.grafana.net/otlp",
  "headers": { "authorization": "Basic <base64 of instance-id:token>" },
  "temporality": "cumulative"
}
```

**A company setup that asks for protobuf or gRPC**

quota-router sends JSON only. A Collector's OTLP/HTTP receiver accepts JSON on the same port as protobuf, so say so explicitly and keep the rest of the managed environment:

```jsonc
"telemetry": { "enabled": true, "protocol": "http/json" }
```

If the backend accepts gRPC only, point quota-router at a local Collector and let that forward.
