import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const configPath = path.resolve(process.env.PRINT_LEDGER_CONFIG ?? 'config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const dataDir = path.resolve(process.env.PRINT_LEDGER_DATA ?? path.join(path.dirname(configPath), 'data'));
const webDir = fileURLToPath(new URL('../docs/', import.meta.url));
const app = await createApp({ config, dataDir, webDir });
console.log(`Print Ledger API: http://${app.apiAddress.address}:${app.apiAddress.port}`);
console.log(app.gatewayAddress ? `Print gateway listening on port ${app.gatewayAddress.port}` : 'Preview mode: print gateway disabled.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
