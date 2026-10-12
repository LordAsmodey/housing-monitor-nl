'use strict';
// Explicit diagnostic only; never invoked by the scheduler or startup.
async function main() {
  if (!process.env.SENTRY_DSN) throw Error('SENTRY_DSN_MISSING');
  const sdk = require('@sentry/node');
  let accepted = false;
  const telemetry = require('./telemetry.cjs').createTelemetry({ ...sdk, init(options) {
    sdk.init({ ...options, transport(transportOptions) {
      const transport = sdk.makeNodeTransport(transportOptions);
      return { flush: timeout => transport.flush(timeout), async send(envelope) {
        const response = await transport.send(envelope);
        if (envelope[1].some(item => item[0].type === 'event')) accepted = response?.statusCode >= 200 && response?.statusCode < 300;
        return response;
      } };
    } });
  } });
  const eventId = telemetry.report(new Error('SENTRY_SMOKE_TEST'), 'application', 'SENTRY_SMOKE_TEST');
  if (!eventId || !await telemetry.flush() || !accepted) throw Error('SENTRY_SMOKE_FAILED');
  console.log(JSON.stringify({ category: 'SENTRY_SMOKE_TEST', eventId, accepted: true }));
}
main().catch(() => { console.error('SENTRY_SMOKE_FAILED: check Sentry configuration and connectivity'); process.exitCode = 1; });
