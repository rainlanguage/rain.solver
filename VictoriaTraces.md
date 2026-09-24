# Base solver tracing

The solver records round results, order diagnostics, events, and exceptions as
OpenTelemetry spans. VictoriaTraces stores these spans. This change does not
forward Docker stdout to VictoriaLogs or create alert rules.

## Rollout

1. Apply the `rain.devops` tailnet policy granting `tag:base-node` access to
   `tag:rain-infra` on TCP 10428. VictoriaTraces already runs on the Rain
   observability node. Keep this port private to the tailnet.
2. Build and publish a solver image containing this change through the existing
   release process.
3. On `base-node`, update the environment used to create `base-solver`:

   ```dotenv
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://rain-management-observability.taile5cf8a.ts.net:10428/insert/opentelemetry/v1/traces
   TRACER_SERVICE_NAME=base-bot
   ```

   Remove the previous telemetry API key from the runtime environment. Preserve
   the signer credentials, `CONFIG=./config.yml`, and the config bind mount from
   `/root/solver/config.yml` to `/rain-solver/config.yml`.
4. Recreate the container with the new image and environment through its existing
   deployment process. A restart alone does not update Docker environment values.
5. Verify DNS resolution and TCP 10428 reachability from inside the container,
   not just from the host. Check Docker logs for exporter errors.
6. Open [Rain Grafana](https://rain-management-observability.taile5cf8a.ts.net),
   choose Explore and the `victoriatraces` Jaeger datasource, then search for
   service `base-bot` over the last 15 minutes. Confirm fresh round and order
   spans arrive, including attributes, events, exceptions, and child spans.

After verification, remove the obsolete telemetry ingestion secrets from GitHub
and the deployment secret store. GitHub previews now print spans in the Actions
run logs, linked from the preview deployment.

## Endpoint configuration

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the full trace ingestion URL and takes
precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`. The generic setting is a base URL;
the SDK appends `/v1/traces`. The exporter sends gzip-compressed OTLP HTTP JSON.
Standard OTLP header environment settings remain available for other receivers.
No API key is needed for the private VictoriaTraces endpoint.

If both endpoint settings are absent, spans print to the console. For a temporary
fallback, remove both settings and recreate the container. Inspect its Docker
logs until trace ingestion is restored.
