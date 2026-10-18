# Group 48991 — Ramsnehi Hospital WhatsApp integration

The account's [API Hub](https://msg.msgclub.net/developerToolAPI.html), approved broadcast templates and Ready JSON were inspected on 18 October 2026. The registered WhatsApp sender is `919828298283`; `RAMSNI` and `RAMSNC` belong to SMS. The integration uses `POST https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate` with `AUTH_KEY` in the query string and `Content-Type: application/json`. No website username, password or session cookie is needed for this request.

## Event routing

| PACS event | Recipient / report state | Approved template |
|---|---|---|
| SIGNOFF | PATIENT | report_ready_message |
| SIGNOFF | REFERRING_DOCTOR | clinician_signoff_message |
| SIGNOFF | SHARED | report_ready_message |
| VIEW_IMAGES_PATIENT | hasReport=false | new_patient_message |
| VIEW_IMAGES_PATIENT | hasReport=true | patient_scan_done_report_created_info |
| VIEW_IMAGES_DOCTOR | hasReport=false | new_clinician_message |
| VIEW_IMAGES_DOCTOR | hasReport=true | clinician_signoff_message |

`SHARED` has no specified clinical role in the PACS contract, so it receives the patient report-ready message by default. Routes live in [groups.js](../src/config/groups.js). Each recipient creates one independent job and one provider request. Ten-digit PACS numbers are prefixed with `91` in both `mobileNumbers` and `component.to`.

## Account template catalog

All ten templates below were approved and use language `en`. Their body counts, numbered parameter order and document headers were matched to the account's Ready JSON. Definitions are in [msgclub-templates.js](../src/config/msgclub-templates.js).

| Template | Body values, in numbered order | Document header | Automatic use |
|---|---|---|---|
| report_ready_message | patientName, centerName, reportDate, reportLink | None | Patient/shared signoff |
| clinician_signoff_message | centerName, patientName, studyDate, shareLink, reportLink | None | Doctor with report |
| patient_scan_done_report_created_info | patientName, centerName, studyDate, shareLink, reportLink | None | Patient with report |
| new_clinician_message | patientName, centerName, studyDate, shareLink | None | Doctor, images only |
| new_patient_message | patientName, centerName, studyDate, shareLink | None | Patient, images only |
| ramsnehi_chatbot | None | None | Not routed: chatbot greeting |
| chating | None | None | Not routed: feedback acknowledgement |
| pathology_report | None | reportPdfLink | Not routed: pathology PDF |
| office | None | reportPdfLink | Not routed: office attachment |
| testing_template | patientName | reportPdfLink | Not routed: account test template |

The adapter supports the five additional catalog entries when explicitly selected in a route. It does not send extra chatbot, office, feedback or pathology messages alongside clinical notifications. Fixed text, fixed headers and footers stay in the approved provider template; only variable values are sent.

`studyDate` comes from `payload.studyCreatedAt`, falling back to `event.createdAt`. `reportDate` comes from `event.createdAt`, falling back to the study timestamp. Dates are displayed as `18 October 2026`, preserving the PACS calendar date in IST regardless of server timezone. If neither timestamp exists, the job fails with `ICLOUDSMS_MISSING_TEMPLATE_DATE` rather than inventing a date.

`reportLink` uses `payload.reportPdfLink` when supplied, otherwise `payload.shareLink`, which the PACS contract says also displays the report once available. Image links use the exact supplied `shareLink`. Missing patient names become `Patient`; missing centre names become `Ramsnehi Hospital`. Missing required links fail the job before a provider call. PDF templates send the provider a document URL and optional filename; the five automatic clinical templates send links in their bodies.

None of the approved clinical templates includes an OTP slot. If PACS supplies a nonempty `otpCode`, the job fails with `ICLOUDSMS_OTP_TEMPLATE_REQUIRED` before contacting MsgClub. For OTP-protected links, first approve a suitable provider template and include `otpCode` in its configured fields; the adapter already supports that field. Do not append arbitrary text to a template or silently omit a required code.

## Configuration and verification

Group 48991 is the only configured group and is enabled in code. Its ignored, private `.env` holds the API key, sender and endpoint. Credentials are referenced by environment variable name in saved group configurations; values are excluded from source, SQLite configuration snapshots and logs. The production service at `/opt/nandico-addon` needs the same three `GROUP_48991_ICLOUDSMS_*` variables and a restart after code or environment updates. Preserve its incoming PACS credentials and existing `data/` and `logs/` directories when deploying; back up the previous code, environment and SQLite database first.

Provider `responseCode: "3001"` plus a request ID marks a job `accepted`, not delivered. `npm run jobs -- list` includes `provider_message_id` for account/API-log correlation. Unclear acknowledgements, timeouts and server errors go to `needs_review`; rate limits retry. Existing event deduplication remains in force. Jobs already saved with an old configuration keep that snapshot and are not silently switched to a new message mode.

Run the local checks:

```bash
npm test
npm run test:msgclub
```

The second command requires Postman CLI 1.70+ and starts a local simulation using [the saved provider collection](../examples/msgclub.postman_collection.json), [mock](../postman/mocks/msgclub/default.js) and [simulation](../postman/simulations/msgclub.sim.yaml). It runs the real HTTP receiver, auth, SQLite, worker and provider adapter with synthetic events and fake credentials, then stops the simulation. It checks all clinical routes, duplicates, provider request IDs, credential isolation, rate limits, explicit rejection, ambiguous responses and OTP handling. No live WhatsApp messages are sent. The mock was built from the inspected vendor contract; an owner-published mock search was unavailable because Postman CLI was signed out.

`ICLOUDSMS_SIMULATION_URL` is restricted to the local `127.0.0.1` simulation route and is rejected during production startup. It is never set in the private local `.env`. The generated example acknowledgement and injected failures establish local integration behavior, not actual MsgClub delivery.

For a controlled live test, the existing `npm run send-event` command requires `--to` and `--allow-send`; use an event without `otpCode`, a current event timestamp and real test viewing/report links. The local Postman group-48991 request similarly requires `testMobile` and `allowLiveSend=true`. Neither test has been sent as part of this implementation.
