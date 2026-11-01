# Maintaining centers and shared code

Open `src/centers/<name>/` for center-specific work. KRJ and Ramsnehi each own
one folder. Shared HTTP handling, authentication, persistence, template helpers,
provider registration and worker/retry infrastructure live under `src/shared/`.
The application entry point remains `src/server.js`.

## Where to make a change

| Change | Location |
| --- | --- |
| Add a center or inspect group lookup | `src/centers/index.js` |
| KRJ configuration and environment validation | `src/centers/krj/config.js` |
| KRJ STUDY_UPLOADED/SIGNOFF rules | `src/centers/krj/workflow.js` |
| KRJ accession mapping and request bodies | `src/centers/krj/payload.js` |
| KRJ HIMS calls, TLS and PDF download | `src/centers/krj/provider.js` |
| Ramsnehi group and credential references | `src/centers/ramsnehi/config.js` |
| Ramsnehi event-to-template routing | `src/centers/ramsnehi/workflow.js` |
| Ramsnehi approved template definitions | `src/centers/ramsnehi/whatsapp-templates.js` |
| Reusable MsgClub HTTP connector | `src/shared/integrations/whatsapp/msgclub/provider.js` |
| Common provider registration | `src/shared/integrations/index.js` |
| Common template values, dates, documents and OTP handling | `src/shared/services/whatsapp-template.service.js` |
| Common recipient planning and center workflow dispatch | `src/shared/services/delivery-plan.service.js` |
| Common PACS environment and authentication | `src/shared/config/`, `src/shared/middleware/` |
| Durable event acceptance and background processing | `src/shared/services/outbox.service.js`, `src/shared/services/worker.service.js` |
| SQLite jobs and saved configurations | `src/shared/repositories/outbox.repository.js` |
| Credentials | Private `.env`; names in `.env.example` |

## Center modules

[The centers guide](../src/centers/README.md) describes how to add a center.
Each module exports a unique `id` and `createConfig(env)`; optional hooks are
`validateEnvironment(env)`, `planJobs(event, group)` and a `providers` map. Register
it once in the `centers` array in `src/centers/index.js`.

The registry checks group uniqueness, returns independent configuration copies,
loads center settings and registers center-specific providers. Unknown groups
return no configuration. New configuration snapshots include `centerId`.
Historical KRJ configurations without it still resolve by provider ID.

A center using MsgClub puts its group and credential references in `config.js`,
event mappings in `workflow.js`, and approved templates in
`whatsapp-templates.js`. It selects `provider: 'icloudsms'` and reuses the common
HTTP connector and template preparation. [Ramsnehi](../src/centers/ramsnehi/README.md)
is the example.

A center with a custom API keeps that transport beside its own configuration,
workflow and payload mapping. [KRJ](../src/centers/krj/README.md) is the example.
Keep center-specific business rules out of the shared services. Keep stored
configuration as plain JSON data and credential references, not functions or
credential values.

## Shared processing

```text
PACS → shared authentication and validation → center selected by group ID
     → center custom workflow or common recipient-job planning
     → SQLite saves event, jobs and configuration snapshot → HTTP 200
     → shared worker → registered provider → outgoing HTTP request
     → shared worker records acceptance, failure, retry or review
```

Each group currently selects one provider. Ramsnehi creates one job per unique
recipient. KRJ creates an upload-confirmation for STUDY_UPLOADED or a report job for
SIGNOFF, independently of notification recipients. Repeated envelope IDs are
deduplicated, while new re-upload IDs create new jobs. KRJ group 27919 maps `originReferenceId` to HIMS `OrderId` and the full
`shareLink` to HIMS `ZipFilePath`. Group 0 is a non-production test override. A center needing both HIMS and WhatsApp still needs
an explicit multi-provider workflow.

Provider adapters implement `isConfigured(group, eventType)` and
`send(job)`, returning `{status: 'accepted', providerMessageId?}`. Use
`ProviderError` for failures: only known retry-safe failures are retryable;
uncertain writes require review. The shared worker owns retry state.

## Tests and compatibility

Center tests are under `test/centers/krj/` and `test/centers/ramsnehi/`; shared
receiver and registry tests are under `test/shared/`. Simulation runners use
these locations. The test command explicitly includes test directories so it
does not discover the simulation launcher scripts as tests.

```bash
npm test
npm run test:msgclub
npm run test:hims
```

Provider IDs, environment variable names, outgoing request shapes and error
codes remain stable. Queued jobs use their saved configuration. This center
reorganization adds no database migration; the existing additive action-column
migration continues to preserve historical notification jobs.

The simulations exercise the real receiver, authentication, database, worker
and HTTP adapters against local stand-ins using synthetic data. They establish
client behavior for the modeled contracts, not live HIMS persistence or real
WhatsApp delivery.
