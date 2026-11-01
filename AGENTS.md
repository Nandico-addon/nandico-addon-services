# Integration isolation

User requirement: adding or changing an integration must preserve all previously working integrations.

- Keep center-specific configuration, workflows, templates, payload mapping, and providers in `src/centers/<center>/`. Keep common infrastructure in `src/shared/`.
- Scope changes to the requested center. Preserve other centers' group IDs, routing, templates, endpoints, credentials, and environment values.
- Preserve stable provider IDs, historical job configuration snapshots, deduplication, authentication, and acknowledgement behavior. Keep database migrations backward compatible. Do not rewrite or resend historical jobs as part of an unrelated integration change.
- For shared infrastructure changes, verify every registered center, including existing centers that are outside the requested integration.
- Before deploying changes that affect delivery, run `npm test`, `npm run test:hims`, and `npm run test:msgclub`, plus regression suites for any additional centers. Resolve regressions before deployment. Documentation-only changes do not require test reruns.
- Use synthetic data and simulation targets for regression tests. Use designated test inputs for live business checks; do not send unrelated live HIMS or WhatsApp messages.
- Before deployment, back up the existing code, private environment, and datastore. Preserve other centers' settings, accepted events, and jobs. After restart, verify service health and safe ingress/configuration checks for both the changed center and existing centers. If rollback is needed, preserve newly accepted work.
