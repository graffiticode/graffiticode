const { TraceExporter: GoogleCloudExporter } = require("@google-cloud/opentelemetry-cloud-trace-exporter");
const { JaegerExporter } = require("@opentelemetry/exporter-jaeger");
const { ZipkinExporter } = require("@opentelemetry/exporter-zipkin");
const { ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-base");

// The exporter named by OTEL_SPAN_EXPORTER, or null for none.
//
// Until 0.4.0 an unset variable fell through to ConsoleSpanExporter, which prints
// every span to stdout as ~30 lines. With fs auto-instrumentation on, a cold start
// alone printed thousands: about 20 GiB a week of Cloud Logging across the language
// services that never set the variable (2026-11). Console output is now opt-in.
exports.createSpanExporter = () => {
  switch (process.env.OTEL_SPAN_EXPORTER) {
    case "zipkin":
      console.log("Using zipkin exporter");
      return new ZipkinExporter({});
    case "jaeger":
      console.log("Using jaeger exporter");
      return new JaegerExporter({});
    case "google-cloud":
      console.log("Using Google Cloud exporter");
      return new GoogleCloudExporter({});
    case "console":
      console.log("Using console exporter");
      return new ConsoleSpanExporter();
    default:
      return null;
  }
};
