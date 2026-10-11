'use strict';
const $ = id => document.getElementById(id);
const config = window.PRINT_LEDGER_CONFIG || {};
let apiUrl = config.apiUrl || '';
try { apiUrl = localStorage.getItem('print-ledger-api') || apiUrl; } catch {}
if (!apiUrl && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) apiUrl = location.origin;
let token = ''; let period = '7'; let page = 1; let section = 'overview'; let timer; let searchTimer; let requestNumber = 0; let toastTimer;
const statuses = { receiving: 'Receiving', queued: 'Queued', forwarding: 'Forwarding', forwarded: 'Forwarded', failed: 'Failed', interrupted: 'Interrupted' };
function text(id, value) { $(id).textContent = value; }
function el(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; }
function setError(id, message) { text(id, message || ''); $(id).hidden = !message; }
function toast(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function validApi(raw) {
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !local)) throw new Error('Use an HTTPS gateway address, or HTTP on localhost for a local preview.');
  return url.href.replace(/\/$/, '');
}
async function request(route, options = {}) {
  if (!apiUrl) throw new Error('Configure your gateway address before signing in.');
  const base = validApi(apiUrl);
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(options.headers || {}) };
  let response;
  try { response = await fetch(base + route, { ...options, headers, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000), targetAddressSpace: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) ? 'loopback' : undefined }); }
  catch { throw new Error('The gateway could not be reached. Check its address and make sure the server is running. If your browser asks for local network access, allow it for this site.'); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && token) { signedOut(); throw new Error('Your session has ended. Please sign in again.'); }
    throw new Error(data.error || 'The gateway could not complete this request.');
  }
  return options.asText ? response.text() : response.json();
}
function bytes(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function dateTime(value) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function filters() {
  const params = new URLSearchParams();
  if (period !== 'all') {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    if (period !== 'today') from.setDate(from.getDate() - Number(period) + 1);
    params.set('from', from.toISOString());
  }
  const query = $('search').value.trim(); if (query) params.set('q', query);
  return params;
}
function signedOut() { token = ''; clearInterval(timer); requestNumber++; $('dashboard').hidden = true; $('signin').hidden = false; $('password').value = ''; }
function showSection(next) {
  section = next;
  for (const button of document.querySelectorAll('[data-section]')) button.classList.toggle('active', button.dataset.section === section);
  $('overview-section').hidden = section !== 'overview'; $('devices-section').hidden = section !== 'devices'; $('jobs-section').hidden = section === 'devices';
  const titles = { overview: ['Overview', 'A clear view of your printer.', 'Jobs received by your gateway, grouped by source IP.'], jobs: ['Print jobs', 'Every print job, accounted for.', 'Search your gateway history and follow delivery status.'], devices: ['Source IPs', 'Know where each job came from.', 'Compare print activity by the source address observed by the gateway.'] };
  text('breadcrumb', titles[section][0]); text('page-title', titles[section][1]); text('page-subtitle', titles[section][2]); text('jobs-heading', section === 'jobs' ? 'Print job history' : 'Recent print jobs');
}
function drawDashboard(data) {
  const sum = data.summary;
  for (const [id, key] of [['stat-total', 'total'], ['stat-forwarded', 'forwarded'], ['stat-devices', 'devices'], ['stat-failed', 'failed']]) text(id, sum[key].toLocaleString());
  text('pending-caption', sum.pending + ' jobs in progress');
  text('printer-name', data.printer.name); text('printer-ip', data.printer.host);
  text('gateway-status', data.gateway.enabled ? 'Gateway active · port ' + data.gateway.listenPort : 'Gateway not deployed');
  text('coverage-note', data.gateway.enabled ? 'Only jobs sent through the gateway are recorded. Configure every device to use it for complete coverage.' : 'Live tracking is not active. Deploy the always-on gateway, then configure devices to print through it.');
  text('last-updated', 'Updated ' + new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  $('top-sources').replaceChildren();
  if (!data.devices.length) { const empty = el('div', 'sources-empty'); empty.append(el('strong', '', 'No source IPs recorded'), el('p', '', 'IP activity will appear when the first job arrives.')); $('top-sources').append(empty); }
  for (const device of data.devices.slice(0, 4)) {
    const row = el('div', 'source-row'); row.append(el('code', '', device.source_ip), el('span', '', device.jobs + (device.jobs === 1 ? ' job' : ' jobs')));
    const track = el('div', 'source-track'); const fill = el('div', 'source-fill'); fill.style.setProperty('--width', (100 * device.jobs / data.devices[0].jobs) + '%'); track.append(fill); row.append(track); $('top-sources').append(row);
  }
  const days = [];
  const today = new Date(); const start = new Date();
  if (period === 'all' && data.daily.length) start.setTime(Date.parse(data.daily[0].day + 'T00:00:00Z'));
  else if (period !== 'all') start.setTime(Date.parse(filters().get('from')));
  else start.setUTCDate(today.getUTCDate() - 6);
  start.setUTCHours(0, 0, 0, 0);
  // Long histories are grouped into at most 30 equally sized chart buckets.
  const span = Math.floor((today - start) / 86400000) + 1; const step = Math.max(1, Math.ceil(span / 30));
  const counts = new Map(data.daily.map(d => [d.day, d.jobs]));
  for (let i = 0; i < span; i += step) {
    const day = new Date(start.getTime() + i * 86400000); let count = 0;
    for (let j = i; j < Math.min(i + step, span); j++) count += counts.get(new Date(start.getTime() + j * 86400000).toISOString().slice(0, 10)) || 0;
    days.push({ day, count });
  }
  $('activity-chart').replaceChildren();
  const max = Math.max(1, ...days.map(d => d.count));
  for (const bucket of days) { const bar = el('div', 'day-bar'); bar.style.setProperty('--height', Math.max(2, bucket.count / max * ($('activity-chart').clientHeight - 12)) + 'px'); bar.title = bucket.day.toLocaleDateString() + ': ' + bucket.count + ' jobs'; $('activity-chart').append(bar); }
  if (!sum.total) $('activity-chart').append(el('span', 'chart-empty', 'No jobs in this period'));
  $('activity-chart').setAttribute('aria-label', sum.total + ' jobs in the selected period');
  const shortDate = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  text('chart-start', days.length ? shortDate(days[0].day) : '—'); text('chart-end', shortDate(today));
  $('devices-body').replaceChildren(); $('devices-empty').hidden = !!data.devices.length;
  for (const device of data.devices) { const row = el('tr'); const ip = el('td'); ip.append(el('code', '', device.source_ip)); row.append(ip, el('td', '', device.jobs), el('td', '', device.forwarded), el('td', '', bytes(device.bytes)), el('td', '', dateTime(device.last_seen))); $('devices-body').append(row); }
}
function drawJobs(data) {
  $('jobs-body').replaceChildren(); $('jobs-empty').hidden = !!data.jobs.length;
  if (!data.jobs.length && $('search').value.trim()) { $('jobs-empty').replaceChildren(el('strong', '', 'No matching jobs'), el('p', '', 'Try another source IP or document name.')); }
  else if (!data.jobs.length) { $('jobs-empty').replaceChildren(el('div', 'empty-icon', '↳'), el('strong', '', 'Your print history starts here'), el('p', '', 'Send a print job through the gateway to see its source IP and delivery status.')); }
  for (const job of data.jobs) {
    const row = el('tr'); const document = el('td', '', job.document); document.title = job.document;
    const ip = el('td'); ip.append(el('code', '', job.source_ip));
    const status = el('td'); const pill = el('span', 'pill ' + (statuses[job.status] ? job.status : ''), statuses[job.status] || 'Unknown'); if (job.error) pill.title = job.error; status.append(pill);
    row.append(document, ip, el('td', '', dateTime(job.received_at)), el('td', '', bytes(job.bytes)), status); $('jobs-body').append(row);
  }
  text('jobs-count', data.total ? data.total.toLocaleString() + ' jobs in the selected period' : 'No jobs recorded in this period');
  text('pagination-label', data.total ? ((data.page - 1) * data.pageSize + 1) + '–' + Math.min(data.page * data.pageSize, data.total) + ' of ' + data.total + ' jobs' : '0 jobs');
  $('previous').disabled = page <= 1; $('next').disabled = page * data.pageSize >= data.total;
}
async function refresh() {
  if (!token) return;
  const n = ++requestNumber; const params = filters(); params.set('page', page);
  try {
    const [data, jobs] = await Promise.all([request('/api/dashboard?' + params), request('/api/jobs?' + params)]);
    if (n !== requestNumber || !token) return;
    if (jobs.total && (page - 1) * jobs.pageSize >= jobs.total) { page = 1; return refresh(); }
    drawDashboard(data); drawJobs(jobs); setError('dashboard-error', '');
  } catch (error) { if (n === requestNumber) { setError(token ? 'dashboard-error' : 'login-error', error.message); text('last-updated', 'Connection interrupted'); } }
}
function connectionLabel() {
  text('connection-label', apiUrl ? 'Gateway address configured' : 'Gateway not connected');
  $('login-dot').style.background = apiUrl ? '#6d92e8' : '#e1aa47';
  $('setup-hint').hidden = !!apiUrl;
}
function openConnection() { $('api-url').value = apiUrl; setError('connection-error', ''); $('connection-dialog').showModal(); }
for (const id of ['connect-open', 'settings-open']) $(id).addEventListener('click', openConnection);
$('connection-close').addEventListener('click', () => $('connection-dialog').close());
$('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  try { const next = validApi($('api-url').value.trim()); signedOut(); apiUrl = next; try { localStorage.setItem('print-ledger-api', apiUrl); } catch {} connectionLabel(); $('connection-dialog').close(); setError('login-error', ''); toast('Gateway address saved. Sign in to connect.'); }
  catch (error) { setError('connection-error', error.message); }
});
$('show-password').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; text('show-password', show ? 'Hide' : 'Show'); $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); setError('login-error', ''); $('login-submit').disabled = true;
  try {
    const response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    token = response.token; $('password').value = ''; text('account-name', response.username); $('signin').hidden = true; $('dashboard').hidden = false; page = 1; showSection('overview'); await refresh(); clearInterval(timer); timer = setInterval(refresh, 15000);
  } catch (error) { setError('login-error', error.message); }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await request('/api/logout', { method: 'POST' }); } catch {} signedOut(); });
for (const button of document.querySelectorAll('[data-period]')) button.addEventListener('click', () => { period = button.dataset.period; page = 1; for (const choice of document.querySelectorAll('[data-period]')) choice.classList.toggle('selected', choice === button); text('range-caption', period === 'all' ? 'All recorded activity' : period === 'today' ? 'Today' : 'Last ' + period + ' days'); void refresh(); });
for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => showSection(button.dataset.section));
$('view-sources').addEventListener('click', () => showSection('devices'));
$('refresh').addEventListener('click', refresh);
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; void refresh(); }, 250); });
$('previous').addEventListener('click', () => { if (page > 1) { page--; void refresh(); } });
$('next').addEventListener('click', () => { page++; void refresh(); });
$('export').addEventListener('click', async () => {
  $('export').disabled = true;
  try { const csv = await request('/api/export?' + filters(), { asText: true }); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = el('a'); link.href = url; link.download = 'print-jobs.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Print history exported. Exports include up to 50,000 matching jobs.'); }
  catch (error) { setError('dashboard-error', error.message); }
  finally { $('export').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) void refresh(); });
connectionLabel();
