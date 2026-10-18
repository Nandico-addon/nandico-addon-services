# Maintaining integrations

The app separates client choices, reusable vendor connections and shared processing. Ramsnehi's folder contains its settings and approved template definitions. The receiver, authentication, database, worker, retry rules and MsgClub HTTP implementation each have one shared implementation.

## Where to make a change

| Change | File or folder |
|---|---|
| Ramsnehi group ID, provider or event-to-template mappings | `src/clients/ramsnehi/config.js` |
| Ramsnehi approved template name, language or parameter order | `src/clients/ramsnehi/whatsapp-templates.js` |
| Register another hospital/group | `src/clients/index.js` |
| Shared PACS values, date formatting, PDF headers or OTP handling | `src/services/whatsapp-template.service.js` |
| MsgClub URL rules, authentication, request wrapper or response handling | `src/integrations/whatsapp/msgclub/provider.js` |
| Register another notification provider | `src/integrations/index.js` |
| Incoming authentication | `src/middleware/` |
| Durable event acceptance and background processing | `src/services/outbox.service.js`, `src/services/worker.service.js` |
| Database operations | `src/repositories/outbox.repository.js` |
| Credentials and deployment settings | Private `.env`; variable names documented in `.env.example` |

An incoming event follows this path:

```text
PACS → shared auth and validation → client registry selects the group
     → SQLite saves event, recipient jobs and configuration snapshot → HTTP 200
     → shared worker → notification service → MsgClub connector
     → shared template builder prepares values → provider HTTP request
     → shared worker records acceptance, failure, retry or review
```

## Add another client using MsgClub

1. Create `src/clients/<client-name>/config.js` and `whatsapp-templates.js`. Use Ramsnehi's configuration shape as a guide. Put only that client's approved templates, routing choices and credential variable names in these files.
2. Give it the actual PACS `groupId`, `clientName` and independent environment references, such as `GROUP_<ID>_ICLOUDSMS_AUTH_KEY`. Keep `provider: 'icloudsms'` to select the existing MsgClub connector. Keep `messageMode: 'template'`.
3. Define the client's `templates` mappings and derive `events` from those mappings. SIGNOFF routes select by recipient kind; VIEW_IMAGES routes select `withReport` or `withoutReport`.
4. Import its configuration in `src/clients/index.js` and include it in the `createClientRegistry([...])` list. Duplicate group IDs fail at startup. Unknown groups return no configuration.
5. Add the real values to the private environment and document variable names in `.env.example`. Verify that client's approved templates and test its routing with synthetic events and fake credentials before deploying.

No copied HTTP client, worker, authentication, database or retry code is needed. One MsgClub connector instance serves all registered clients, resolving each job's own credential references. Registry lookups return independent configuration snapshots so changes within one request cannot affect another client or request.

## Add another vendor or HIMS integration

Put vendor HTTP code under `src/integrations/<category>/<vendor>/`, for example `src/integrations/whatsapp/<vendor>/provider.js` or `src/integrations/hims/<vendor>/client.js`. Register notification providers once in `src/integrations/index.js`. The current notification interface is:

```js
isConfigured(group, eventType) // boolean: required settings/routes exist
send(job)                     // Promise<{ status: 'accepted', providerMessageId? }>
```

Use `ProviderError` for send failures. Mark only known retry-safe failures as retryable; mark uncertain sends as ambiguous. The shared worker owns retries. Template-based WhatsApp connectors can reuse the shared template builder and wrap its output in their vendor's request format.

If a client needs unique business rules, add `src/clients/<client-name>/workflows.js` when those rules are implemented. Reuse common transformations from services; keep vendor API details in the integration folder. Keep stored configurations as plain data, because SQLite serializes them as JSON.

The current workflow sends one notification per recipient through one configured provider. A HIMS operation, or an event that must trigger both HIMS and WhatsApp, needs its actual API contract and a workflow with independently tracked operations. The folder structure makes room for that work; it does not implement additional integrations or multi-operation dispatch yet.

## Compatibility and local verification

The internal provider ID remains `icloudsms`, environment names remain `GROUP_48991_ICLOUDSMS_*`, and saved group configurations retain the existing JSON shape. The database schema and HTTP contract stay the same. Queued jobs use their saved configuration rather than newly edited client mappings. The shared date formatter is initialized once and reused; enabled event names are derived from mappings to avoid maintaining duplicate lists.

```bash
npm test
npm run test:msgclub
```

The simulation runs the actual HTTP receiver, authentication, SQLite, worker and connector against a local fake MsgClub service. It checks template routing, multiple client configurations, saved job snapshots, duplicate suppression and provider failure handling using fake credentials. It sends no real WhatsApp messages. See the README for setup and production deployment instructions.
