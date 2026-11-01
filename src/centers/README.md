# Centers

Each center owns its configuration and business rules in its own folder. Start
with [KRJ](krj/README.md) or [Ramsnehi](ramsnehi/README.md). Shared infrastructure
lives in `src/shared/`.

```text
centers/
  index.js                    Center registration and group lookup
  krj/
    index.js                  Center module and HIMS provider registration
    config.js                 Group, ZIP field, environment and upload policy
    workflow.js               STUDY_UPLOADED/SIGNOFF actions
    payload.js                Accession mapping and HIMS request bodies
    provider.js               KRJ HIMS HTTP and PDF transport
    README.md
  ramsnehi/
    index.js                  Center module and environment validation
    config.js                 Group and credential references
    workflow.js               Event-to-template mappings
    whatsapp-templates.js     Approved template names and fields
    README.md
```

## Add a center

1. Create `src/centers/<name>/` with `index.js`, `config.js`, `workflow.js` and a
   README. Include payloads, templates and center-specific providers as needed.
2. Export a unique `id` and `createConfig(env)` from `index.js`. Return a plain
   configuration containing `centerId`, the actual `groupId`, `provider`, enabled
   `events` and environment-variable references. Return `null` for an inactive
   optional center. Never save credential values in configuration snapshots.
3. Optionally export `validateEnvironment(env)`, `planJobs(event, group)` and a
   `providers` map of stable provider IDs to adapter classes. A center using the
   reusable MsgClub connector uses `provider: 'icloudsms'` and template mappings;
   the shared planner creates recipient jobs for it.
4. Add the module once to the `centers` array in `index.js`. Group lookup,
   environment validation, custom planning and provider registration use it.
   Duplicate group IDs fail at startup, and unknown groups have no default.
   KRJ group 27919 and Ramsnehi group 48991 are registered explicitly.
   Group 0 is available only as a non-production KRJ test override.
5. Put center checks under `test/centers/<name>/`. Add its public configuration
   variable names to `.env.example`, with real values only in the private
   environment. Exercise external calls using a local Postman simulation.

The shared receiver authenticates PACS, commits events/jobs and configuration
snapshots, and runs the worker. Keep common authentication, persistence, retry
and logging code in `src/shared/`. Reusable vendor connectors also live there;
center-specific provider code belongs with its center.

Provider IDs, error codes, environment names and saved job configuration remain
compatible with historical jobs. Legacy KRJ snapshots without `centerId` resolve
their custom workflow by the registered provider ID.
