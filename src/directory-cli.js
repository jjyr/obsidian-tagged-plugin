import { run, reportCliError } from './cli/run.ts';
await run('directories').catch(reportCliError);
