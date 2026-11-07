import {runOperatorDiagnostic} from '../../../packages/control/operator-cli.mjs';
await runOperatorDiagnostic('watchdog',process.argv.slice(2));
