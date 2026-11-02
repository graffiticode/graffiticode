const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const opentelemetry = require('@opentelemetry/sdk-node');

const { createSpanExporter } = require('./span-exporter');

const exporter = createSpanExporter();

if (exporter) {
  // For troubleshooting, set the log level to DiagLogLevel.DEBUG
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const sdk = new opentelemetry.NodeSDK({
    autoDetectResources: true,
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations({
      // One span per filesystem call, thousands at startup, and none of them
      // explain a request.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    })],
    spanProcessor: new opentelemetry.tracing.BatchSpanProcessor(exporter),
  });
  sdk.start();
  console.log('tracing initialized');
}
