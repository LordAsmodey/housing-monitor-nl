// Initialize error monitoring before NestJS and application modules load.
const { init } = require('../scripts/telemetry.cjs');
init('application');
export {};
