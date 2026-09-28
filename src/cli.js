import { run, reportCliError } from './cli/run.ts';
await run('tags').catch(reportCliError);
