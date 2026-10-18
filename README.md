# Nandico add-on backend

Backend implementation of [the PACS push contract](docs/addon-service-integration.md), using Node.js 22.13+ and built-in HTTP, crypto and SQLite modules.

**POST https://addon.nandico.in/outbox** receives signed PACS events. Ramsnehi Hospital's actual group is **48991**, and its only configured provider is MsgClub/iCloudSMS. Unconfigured groups return 503; there is no default client or dummy group.

## Configuration

If `.env` does not exist, copy `.env.example` and configure incoming PACS Basic Auth and HMAC credentials. Keep the provider API key in the private `.env`:

```dotenv
GROUP_48991_ICLOUDSMS_URL=https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate
GROUP_48991_ICLOUDSMS_AUTH_KEY=<private-api-key>
GROUP_48991_ICLOUDSMS_SENDER_ID=919828298283
```

Run `npm start` or `npm run dev`. The server defaults to `127.0.0.1:3999`; source and environment changes require a restart in production. `GET /health` returns 200 locally, `GET /outbox` returns 405, and `/` returns 404.

Register clients in [clients/index.js](src/clients/index.js). Ramsnehi's group, provider and event routing live in [its config.js](src/clients/ramsnehi/config.js); approved names and parameter order live in [its whatsapp-templates.js](src/clients/ramsnehi/whatsapp-templates.js). See [the maintenance guide](docs/code-structure.md) and [Ramsnehi's routing and template catalog](docs/msgclub-group-48991.md).

Five clinical templates handle SIGNOFF and both VIEW_IMAGES events. Five other account templates are supported for explicit route selection, including PDF headers. The automatic routes send scan/report links in body parameters. None has an OTP slot: an event with a nonempty `otpCode` fails with `ICLOUDSMS_OTP_TEMPLATE_REQUIRED` until a suitable approved template is configured.

## Code structure

```text
src/
  server.js                        Startup and graceful shutdown
  app.js                           HTTP server and dependency wiring
  config/env.js                    Environment validation
  clients/
    index.js                       Register groups and isolate configurations
    ramsnehi/
      config.js                    Group 48991, provider and event routing
      whatsapp-templates.js        Approved account templates
  integrations/
    index.js                       Reusable provider registry
    whatsapp/msgclub/provider.js   MsgClub API, credentials and acknowledgements
  routes/router.js                 POST /outbox and GET /health
  controllers/outbox.controller.js  Authenticate and acknowledge requests
  middleware/                      Basic Auth, HMAC, timestamps and raw bytes
  services/
    group-router.service.js        Resolve and validate the group
    outbox.service.js              Validate and durably accept events
    notification.service.js        Dispatch supported event types
    whatsapp-template.service.js   Shared PACS values and template preparation
    worker.service.js              Background processing and retries
  repositories/outbox.repository.js SQLite events and recipient jobs
  utils/                           Errors, safe logging and validation
scripts/
  send-event.js                    Sign and submit a controlled test event
  jobs.js                          Inspect or retry jobs
  test-msgclub-simulation.js       Run the local provider simulation
```

## Processing and delivery status

```text
PACS → Nginx → Basic Auth + HMAC → validate group and event
     → SQLite transaction → HTTP 200
     → background worker → MsgClub
```

Both authentication schemes are checked. HMAC covers the original body bytes, prefixed by the Unix timestamp and `.`. Timestamps more than five minutes away from the server clock are rejected.

Envelope IDs are deduplicated globally. Reusing an ID for another group returns 409. Recipient numbers are deduplicated per event. All event/jobs are committed before acknowledging PACS; provider calls happen afterward. Unselected event types are acknowledged as filtered and create no jobs.

SQLite lives in `data/backend/outbox.sqlite` by default. It contains original event payloads, recipient numbers and job states. Each event saves a configuration snapshot containing credential variable names, not secret values. Existing historical events keep their original group ID and configuration; changing the current group does not resend or rewrite them. Run only one application process per database.

Provider `responseCode: 3001` and its request ID mark a job **accepted**, not delivered. `npm run jobs -- list` includes `provider_message_id` for MsgClub correlation. Delivery receipts are not automatically reconciled into the local job state; inspect MsgClub's recipient-level delivery report for final status and WhatsApp error codes.

Known rate-limit failures retry after approximately 1, 2, 4, 8 and 16 minutes, up to six attempts. Permanent provider errors become failed. Timeouts, uncertain acknowledgements, server errors and interrupted sends become `needs_review` to avoid duplicating messages that may have been accepted.

## Logs and jobs

Logs go to stdout and daily UTC files `logs/app-YYYY-MM-DD.log`. They include event/group/job IDs, provider, status, attempt and safe error codes. They exclude patient details, recipient numbers, links, OTPs, auth headers and secrets. Restrict access to the datastore and backups because they contain patient payloads.

```bash
npm run jobs -- list
npm run jobs -- list --status failed
npm run jobs -- list --status needs_review
npm run jobs -- retry --id 12
```

For a job in `needs_review`, first inspect the provider record, then pass `--confirm-possible-duplicate` only when a resend is appropriate. Historical jobs retain their saved credential references; review the snapshot before retrying a job from an earlier client configuration.

## Verification and controlled sending

```bash
npm test
npm run test:msgclub
```

The second command requires Postman CLI 1.70+ and runs the real receiver, authentication, SQLite, worker and adapter against a local MsgClub simulation using fake credentials. It verifies clinical routes, parameter order, duplicate suppression, provider errors, retries, private values and OTP handling. The simulation starts and stops with the command and sends no real WhatsApp messages. Production rejects `ICLOUDSMS_SIMULATION_URL`.

For Postman, import [the local receiver collection](examples/local.postman_collection.json). Configure `basicUser`, `basicPassword` and `hmacSecret` to match `.env`. Its pre-request script signs the exact resolved body with a fresh timestamp. The Ramsnehi request requires `testMobile` and `allowLiveSend=true`; otherwise `pm.execution.skipRequest()` prevents sending. The [provider collection](examples/msgclub.postman_collection.json) defaults to the local simulation with fake credentials.

For an explicitly controlled live test, prepare an event file with current timestamps, real test links and no OTP, then run:

```bash
npm run send-event -- --url https://addon.nandico.in/outbox \
  --file YOUR_TEST_EVENT.json --group 48991 --to YOUR_TEST_MOBILE --allow-send
```

This can send a real message. The helper always requires a controlled ten-digit test number and `--allow-send`. The PACS administrator must enable the required push events for group 48991 on the PACS side.

## Production deployment

The service runs at `/opt/nandico-addon` on `addon.nandico.in`, managed by `nandico-addon.service`, with Nginx proxying `/outbox`. The deployed commit is recorded in `/opt/nandico-addon/REVISION`.

Before updates, back up code, private environment and SQLite. Preserve production incoming credentials, `data/` and `logs/`; update the three group-48991 provider variables, remove obsolete provider/example settings, deploy source files and restart the service. Remove files deleted by the release as well as copying new files. Validate local health and a signed public webhook with no recipients before triggering a real notification.

For initial server setup, [deploy/install.py](deploy/install.py) installs a verified Node.js 24 runtime if needed, configures the dedicated service user, backs up and validates Nginx, and starts the service. Upload the application and private production `.env` first. The service unit expects Node at `/usr/local/bin/node`.

```bash
sudo systemctl restart nandico-addon
sudo systemctl status nandico-addon --no-pager
sudo journalctl -u nandico-addon -f
```
