# Solver tracing with VictoriaTraces

The solver records round results, order diagnostics, events, and exceptions as
OpenTelemetry spans and can send them to VictoriaTraces. Docker stdout is not
forwarded to VictoriaLogs, and no alert rules are created.

The host names, ports, network policy, and container layout of each deployment
belong in the infrastructure repository, not here. Replace each `<placeholder>`
below with the value for your deployment.

## Rollout

1. Let the solver host reach the VictoriaTraces OTLP ingest port over a private
   network. Do not expose this port publicly.
2. Build and publish a solver image containing OTLP tracing through the existing
   release process.
3. On the solver host, update the environment used to create the solver
   container:

   ```dotenv
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://<victoriatraces-host>:<port>/insert/opentelemetry/v1/traces
   TRACER_SERVICE_NAME=<service-name>
   ```

   Remove `HYPERDX_API_KEY` from the runtime environment. Keep the signer
   credentials, the `CONFIG` path, and the config bind mount as they are.
4. Recreate the container with the new image and environment through its existing
   deployment process. A restart alone does not update Docker environment values.
5. Check DNS resolution and reachability of the ingest port from inside the
   container, not only from the host. Check the Docker logs for exporter errors
   and for the startup warning described below.
6. In Grafana, open Explore with the VictoriaTraces (Jaeger) datasource and
   search for `<service-name>` over the last 15 minutes. Confirm that fresh round
   and order spans arrive, with their attributes, events, exceptions, and child
   spans.

After verification, remove the obsolete HyperDX secrets from GitHub and the
deployment secret store. GitHub previews print spans in the Actions run logs,
linked from the preview deployment.

## Endpoint configuration

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the full trace ingestion URL and takes
precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`. The generic setting is a base URL;
the SDK appends `/v1/traces`. The exporter sends gzip-compressed OTLP HTTP JSON.
Standard OTLP header settings remain available for other receivers, but only with
an HTTPS endpoint; the solver refuses to send headers over plain HTTP.

If both endpoint settings are absent, spans print to the console and the solver
writes a warning to stderr at startup. The warning also says when
`HYPERDX_API_KEY` is still set, because the solver no longer reads it. For a
temporary fallback, remove both settings and recreate the container, then read
its Docker logs until trace ingestion is restored.
