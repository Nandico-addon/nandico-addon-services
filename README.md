# Nandico add-on backend

Backend-only implementation of [the PACS contract](docs/addon-service-integration.md). JavaScript, Node.js 22.13+, built-in HTTP/crypto/SQLite modules. No UI, login system, frontend dependencies or configuration dashboard.

One endpoint receives every client: **POST https://addon.nandico.in/outbox**. Incoming Basic Auth and HMAC verify PACS. The signed body's `groupId` selects the client-specific logic in code.

## Start and test

```bash
# If .env does not already exist:
cp .env.example .env

npm start
```

The server defaults to `127.0.0.1:3999`. The existing `.env` is preserved; unused variables from the old application can be removed. Configure BASIC_USER, BASIC_PASSWORD and HMAC_SECRET to match PACS. Demo credentials work only outside production.

In another terminal:

```bash
curl http://127.0.0.1:3999/health
npm run demo -- --group 42 --id 9001
npm run demo -- --group 42 --id 9001
npm run demo -- --scenario wrong-basic
npm run demo -- --scenario wrong-hmac
npm run demo -- --scenario tampered-body
npm run demo -- --scenario expired
npm run demo -- --scenario invalid-json
```

Expect health 200, event 200 accepted, repeated event 200 duplicate, invalid authentication 401, and signed malformed JSON 400. Group **42 is a local demo only** and never contacts WhatsApp. It is disabled in production. A browser GET to `/outbox` returns 405. `/` returns 404 because this backend has no homepage.

## Code structure

```text
src/
  server.js                        Startup and graceful shutdown
  app.js                           Dependency wiring and HTTP errors
  config/
    env.js                         Environment configuration
    groups.js                      EDIT HERE: if groupId then client configuration
  routes/router.js                 POST /outbox and GET /health
  controllers/outbox.controller.js  Read raw bytes, authenticate, acknowledge
  middleware/
    auth.middleware.js             Basic Auth + HMAC + five-minute timestamp check
    request.middleware.js          Request IDs, bounded raw-body reading and timing
  services/
    group-router.service.js        Resolve and validate the selected group
    outbox.service.js              Validate, deduplicate and durably accept events
    notification.service.js        Event-specific notification dispatch
    worker.service.js              Background processing and retry decisions
    providers/
      index.js                     Register provider service implementations
      demo.service.js              No external requests
      aisensy.service.js           Example real provider adapter
  repositories/outbox.repository.js Durable event IDs and recipient jobs in SQLite
  utils/                           Errors, JSON responses, validation and safe logging
scripts/
  send-event.js                    Sign and submit a test event
  jobs.js                          Inspect/retry jobs without a UI
```

## Add or change a client

Edit **src/config/groups.js**. It already contains explicit conditions for:

- Group 42: local simulation, gated by ALLOW_DEMO_GROUP.
- Group 2396: Ramsnehi Hospital's iCloudSMS configuration. Credentials are private environment references. Five approved English WhatsApp template names from `Downloads/whatsapp.png` are recorded in `templateNames`: `report_ready_message`, `clinician_signoff_message`, `patient_scan_done_report_created_info`, `new_clinician_message`, and `new_patient_message`. The screenshot truncates template bodies, so complete parameters and event/recipient mappings still need confirmation. Sending is disabled pending those details and the provider's request/response contract; no adapter is registered yet. Requests return 503 `GROUP_DISABLED` before storage or provider calls.
- Group 57: an AiSensy example. Replace 57 with the actual client's PACS group ID, update its name and configure its credentials/campaigns. Incomplete configuration returns 503; it never pretends to send.

Copy an existing condition to add a client. Change its group ID, provider and credential references. The `campaignTemplates` helper lets you set the environment prefix and parameter order once for all three events; individual templates can still be overridden for client-specific needs. Disabled integrations return 503 instead of sending through an example provider.

Each client condition returns a serializable configuration:

```js
if (groupId === 123) {
  return {
    groupId: 123,
    clientName: 'Your client',
    provider: 'aisensy',
    enabled: true,
    events: ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'],
    credentialRefs: { apiKey: 'CLIENT_123_AISENSY_API_KEY' },
    templates: {
      SIGNOFF: {
        name: config.providerEnv.CLIENT_123_SIGNOFF_CAMPAIGN || '',
        fields: ['patientName', 'shareLink', 'otpCode'],
      },
      VIEW_IMAGES_PATIENT: {
        name: config.providerEnv.CLIENT_123_PATIENT_CAMPAIGN || '',
        fields: ['patientName', 'shareLink', 'otpCode'],
      },
      VIEW_IMAGES_DOCTOR: {
        name: config.providerEnv.CLIENT_123_DOCTOR_CAMPAIGN || '',
        fields: ['patientName', 'shareLink', 'otpCode'],
      },
    },
  };
}
```

Store the corresponding API key and campaign names in `.env`. Never put real passwords or API keys in source code. Template fields are ordered exactly as the provider expects. Supported values are patientName, centerName, modality, shareLink, otpCode, reportPdfLink, reportFileName, reportStatusId and customerReportId. Missing patientName becomes `Patient`; missing otpCode becomes `Not required`. Change these rules or mappings for a client's actual template.

Restart after code/environment edits, or use `npm run dev` for local source watching. Environment-file changes require a restart even when watching source. Unknown/disabled groups return **503**, so PACS retries instead of sending through another client's provider. Unselected event types are saved as filtered, acknowledged and produce no jobs.

## Implement another provider

For Pinnacle, Ragavs, Celitix or another service:

1. Create `src/services/providers/<provider>.service.js` using that provider's actual API documentation.
2. Implement `isConfigured(group, eventType)` and `async send(job)` following the AiSensy service's interface.
3. Register an instance in `src/services/providers/index.js`.
4. Add an explicit group condition in `src/config/groups.js` selecting that provider and its own credential environment-variable references.

`send(job)` receives the original event, one recipient's mobile/kind, and the saved group configuration. Return `{ status: 'accepted', providerMessageId: ... }` only after API acknowledgement. Do not call it delivered unless you implement provider delivery receipts. For failures, throw ProviderError with a safe code and appropriate retryable/ambiguous flags. Do not put raw provider response text or credentials into error codes or logs.

The AiSensy example follows [its official API campaign contract](https://faq.aisensy.com/api-reference-docs/): POST campaign/t1/api/v2 with apiKey, campaignName, destination, userName, source and templateParams. Configure approved templates and live API campaigns in the client's account. Campaign names are placeholders until supplied by you. Other provider adapters are not included or guessed.

Notifications include the supplied viewing link and OTP through the configured parameters. A SIGNOFF template can include reportPdfLink as text. The code does not download or attach report PDFs; implement that inside the relevant provider service if the client needs actual attachments. The contract requires downloading the link only when sending the file.

## Request and background flow

```text
PACS → Nginx → route → controller → Basic Auth + HMAC
    → outbox service → group condition → SQLite transaction → HTTP 200
    → background worker → notification service → client's provider service
```

HMAC uses the **original body bytes**, before JSON parsing, with timestamp + '.' + body. Both authentication schemes are required. Timestamps more than 300 seconds in either direction are rejected. The sender generates fresh timestamps; do not disable the replay check for the document's old fixed timestamp.

Events are deduplicated globally by envelope ID. Repeating an ID for another group returns 409. Recipient mobile numbers are deduplicated per event. The event and all recipient jobs are committed together before 200, and provider calls occur outside the request handler.

SQLite lives in **data/backend/outbox.sqlite** by default. It stores original event bodies, recipient numbers and delivery state; it does not store provider secret values. Each event snapshots its group/provider configuration with references to credential variable names. Keep those variable names associated with the same client when rotating secrets. Old jobs keep their original provider/template configuration.

This is a fresh backend datastore; the previous application's source/data are archived separately and are not automatically imported. Preserve any real delivered-event ledger when planning a production migration, to avoid processing old pushes again. Run only **one application process** per backend database.

## Logs and jobs

JSON logs are written to stdout and daily UTC files **logs/app-YYYY-MM-DD.log**:

```bash
tail -f logs/app-$(date -u +%F).log
npm run jobs -- list
npm run jobs -- list --status failed
npm run jobs -- list --status needs_review
npm run jobs -- retry --id 12
```

Log entries include requestId, eventId, groupId, eventType, provider, jobId, attempt, status and errorCode where applicable. Patient details, mobile numbers, viewing/PDF links, OTPs, authentication headers and secrets are excluded. The database still contains patient payloads, so restrict data-directory access and configure your backup/retention policy. Logs have daily files; automatic retention is not implemented.

Known transient provider failures retry after approximately 1, 2, 4, 8 and 16 minutes, up to six attempts. Permanent provider errors become failed. Connection failures, uncertain responses and interrupted sends become needs_review because the provider might already have accepted them. Inspect the provider's records before manually retrying such a job:

```bash
npm run jobs -- retry --id 12 --confirm-possible-duplicate
```

PACS's incoming retries are separate: the contract specifies 1, 2, 4, 8, 16, 32 minutes, then hourly, ending at 24 hours. Most 4xx are permanent; 408, 429, 3xx, 5xx and transport failures are retried.

## Deploy and test one real client

1. Copy src/, scripts/, examples/, package.json and the deploy files to `/opt/nandico-addon`. No runtime dependency installation is needed.
2. Use Node.js 22.13+, a dedicated `nandico` service account, writable data/ and logs/ directories and a private `.env`. Set NODE_ENV=production, ALLOW_DEMO_GROUP=false and the real incoming PACS credentials; configure actual group conditions and provider credentials.
3. Install [the systemd service](deploy/nandico-addon.service), adjusting its Node path if necessary.
4. Add [the Nginx location](deploy/nginx.conf) to the existing HTTPS server block. Preserve certificates and use plain proxy_pass without redirects or body changes. Run `nginx -t` before reloading.
5. On a sender with matching PACS credentials, send to your own test phone:

```bash
npm run demo -- --url https://addon.nandico.in/outbox \
  --group ACTUAL_GROUP_ID --to YOUR_10_DIGIT_MOBILE --allow-send
```

Replace the placeholders. This can send a real WhatsApp notification. Confirm HTTP 200, the correct group/provider logs, accepted job state and the message arriving on your phone.

6. Enable the desired events for a PACS test group, use a study with a patient record and controlled test mobile, and trigger a qualifying event. Allow about a minute for PACS polling.

The backend is deployed at `/opt/nandico-addon` on `addon.nandico.in`, managed by `nandico-addon.service`, with `/outbox` proxied by Nginx. Production disables the simulation group. Group 2396 has a pending iCloudSMS configuration and returns 503 `GROUP_DISABLED` until the API contract is confirmed and its adapter is implemented. A running endpoint does not yet mean WhatsApp sending is configured.

For future server setup, [deploy/install.py](deploy/install.py) installs a checksum-verified Node.js 24 runtime when needed, configures the dedicated service user, backs up Nginx configuration, validates the proxy and starts the service. Upload the application and private production `.env` to `/opt/nandico-addon` first, then run the installer as root. The systemd unit expects Node at `/usr/local/bin/node`.

After editing a client on the server, restart and inspect logs:

```bash
sudo systemctl restart nandico-addon
sudo systemctl status nandico-addon --no-pager
sudo journalctl -u nandico-addon -f
sudo tail -f /var/log/nginx/access.log
```

Local tests use fake data and mocked provider calls. No real WhatsApp message has been sent. A browser GET to the public `/outbox` returns 405 with `Allow: POST`; this is expected for a POST-only API.

## Verification

```bash
npm test
```

Tests cover authentication, timestamps, exact bytes, schema, all event types, group isolation, concurrent duplicates, durable IDs, missing provider setup, fast acknowledgement, provider error handling, retries, safe startup recovery and log redaction.
