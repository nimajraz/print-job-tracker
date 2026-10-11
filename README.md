# Print Ledger

A GitHub Pages dashboard with an authenticated, private print gateway. The browser never contains the administrator password or a password verifier. The backend checks a salted scrypt hash, issues expiring in-memory bearer sessions, and stores job metadata in SQLite. Document bytes are temporarily spooled privately and removed after the forwarding attempt.

## Current deployment boundary

The dashboard can be published immediately. Live collection and sign-in need an always-on server on a network that can reach the printer. No such server has been supplied yet. The published page therefore starts at sign-in with an unconfigured gateway; it does not manufacture print history or verify credentials in browser code.

## Publish on GitHub Pages

Create `nimajraz/print-job-tracker`, upload this source, and in **Settings → Pages** choose **Deploy from a branch**, branch **main**, folder **/docs**. The project URL is `https://nimajraz.github.io/print-job-tracker/`. Only `docs/` is published. No credentials, database, real job history, driver files, or printer installation logs belong in this repository.

## Deploy the always-on gateway

1. Use a server with Node.js 24 or newer and network reachability to the printer's TCP port 9100. Use an unprivileged account for the application. Install the source at `/opt/print-ledger`.
2. Create a private settings object based on `backend/config.example.json`, with the actual printer IP, server address, allowed printing client IPs, and `allowedOrigins` including `https://nimajraz.github.io`. Add a `password` field only to the in-memory setup input, and pass the object through stdin to `node backend/configure.mjs`. Set `PRINT_LEDGER_CONFIG` to the destination private configuration file. The script writes only a salted password hash and refuses to overwrite an existing file. Never put the input password or output configuration in Git.
3. Create `/var/lib/print-ledger` owned by the application user. The provided systemd unit expects user/group `printledger`, private config at `/etc/print-ledger/config.json` readable by that user, and Node at `/usr/bin/node`; adjust these to verified server paths. Install and enable the unit after configuring it.
4. Keep API port 8765 bound to loopback. Use an HTTPS reverse proxy with a valid certificate, for example the provided Caddy configuration, to expose `/api/*` at the server's real HTTPS address. The application intentionally refuses a non-loopback API binding. Set firewall access for gateway TCP port 19100 to the intended printing clients only.
5. Open the GitHub Pages dashboard, select **Configure**, enter the HTTPS gateway address, then sign in as the configured administrator. The requested administrator account can be provisioned privately when the server is available. Credentials are validated only by the backend. Changing the configured gateway signs the browser out. Passwords and session tokens are not saved in localStorage.
6. Add the gateway server's outbound source IP to the printer's enabled single-host IPv4 access list. Preserve the existing entries while testing. Configure **each printing device** with the HP PCL6 driver and a Standard TCP/IP RAW port pointing to the **gateway IP, port 19100**, instead of pointing directly to the printer. Disable SNMP and bidirectional status on these gateway client ports; the gateway supports RAW submission, not printer status protocols.
7. Verify one test job from each client appears with its expected source IP and physically prints. Once every client is migrated, the printer administrator can restrict direct print access to the gateway for enforced coverage. This project does not change existing printer access rules automatically.

For a local preview, use `gatewayEnabled: false`, the private config path in `PRINT_LEDGER_CONFIG`, and run `node backend/server.mjs`. Open `http://127.0.0.1:8765`. The same API serves the static dashboard for testing. A preview does not collect real print jobs.

## What is recorded

- One completed RAW TCP connection is one submission. Source IP is the actual TCP peer address, not a client-supplied header or field. A NAT or VPN may cause multiple devices to share one observed source address.
- Receipt time, source IP, byte count, delivery state, and a PJL job name when available. Job names may contain personal information and remain private behind backend authentication.
- Forwarded means the complete submission was sent over TCP to the printer. It does **not** prove that paper was physically printed. No page count is guessed from raw print bytes.
- Incomplete uploads, failed forwarding, and interrupted sessions are recorded. Automatic retry is deliberately disabled because a failed connection may already have printed some pages.
- Direct RAW, IPP, LPR, AirPrint, USB, and other traffic bypassing this gateway are **not captured**. Historical jobs before gateway deployment cannot be reconstructed from this model's stored-job log.
- The server must remain on. The gateway accepts only configured source addresses, caps uploads at 256 MB, limits concurrent receivers and queued jobs, and serializes forwarding to the printer.
- CSV export requires authentication and exports at most 50,000 matching records. Formula-like job names are neutralized in the export.

## Validation

Run `npm run check` and `npm test`. Integration tests use a fake local printer, not the real device. They verify actual forwarding bytes, source-IP aggregation, persistence, failed/incomplete job handling, access control, rate limiting, CSV escaping, and origin restrictions.

## References

- [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
- [HP M501 user guide](https://h10032.www1.hp.com/ctg/Manual/c04785912.pdf): the device's Job Storage Log covers stored jobs, not a complete source-IP history of ordinary submissions.
- [Node.js cryptographic password derivation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).
