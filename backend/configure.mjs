import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { passwordHash } from './app.mjs';

// Read secrets from stdin; never include passwords in command arguments.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let settings;
try { settings = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
catch { throw new Error('Provide the gateway settings as a JSON object on stdin.'); }
if (typeof settings.password !== 'string' || settings.password.length < 8) throw new Error('A password of at least 8 characters is required.');
const auth = await passwordHash(settings.password);
delete settings.password;
const output = path.resolve(process.env.PRINT_LEDGER_CONFIG ?? 'config.json');
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify({ ...settings, username: settings.username ?? 'admin', auth }, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Private gateway configuration created.');
