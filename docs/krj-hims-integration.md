# KRJ HIMS upload confirmation and PDF delivery

KRJ code lives in [src/centers/krj](../src/centers/krj/README.md). The source
contract is `healerhelper-pacs-nandico-addon-contract.pdf`, updated 31 October
2026 with `STUDY_UPLOADED`. HIMS JSON fields follow the vendor's supplied
mark-uploaded example; report multipart names follow `HIMS_Integration_APIs.pdf`.

## Flow and order mapping

```text
HIMS TestMastVMs[].Tranid → PACS accession number → payload.originReferenceId
STUDY_UPLOADED → add-on durable job → HIMS mark-uploaded JSON
SIGNOFF → add-on durable job → download reportPdfLink → HIMS PDF multipart
```

Preserve the order reference as a string, including leading zeros. It is not
the parent patient transaction ID, PACS study ID or customer-report ID.

The add-on authenticates Basic Auth and HMAC, saves the original event and its
job in one SQLite transaction, acknowledges PACS, then processes the job in the
background. Incoming events do not wait for a HIMS response. Missing optional
PACS fields are retained; a job missing data required by HIMS becomes
`needs_review` with a safe error code, rather than losing the event to a 400.

## Upload confirmation

Only `STUDY_UPLOADED` triggers confirmation. Both viewing-link event types are
filtered for KRJ. The dedicated event is sufficient; a nested study snapshot or
upload-completion timestamp is not required to select the action.

The PACS contract permits upload without a patient record, `customerReportId`,
share links or recipients. Upload with a patient can contain several recipients.
HIMS is called once for the event, independently of recipient count. A re-upload
of a signed-off study may include a report link; the upload event still performs
only upload confirmation.

Send JSON to
`https://api.krjdiagnostics.com/hmserp/api/Patient/mark-uploaded`:

```json
{
  "OrderId": "1134",
  "ZipFilePath": "/PdfDocuments/1134/1134.pdf"
}
```

`OrderId` is `payload.originReferenceId`. As agreed on 1 November 2026,
HIMS `ZipFilePath` receives the **full `payload.shareLink` URL**, unchanged. It
is the top-level full URL, not `reportStatusDetails.shareLink` (a token). The
parameter name remains `ZipFilePath` because that is HIMS's JSON contract;
no archive is downloaded or generated for upload confirmation.

Deduplicate by envelope `id`. A new upload, merge, later series or re-upload has
a new ID and creates a new HIMS job even for the same order and `uploadCount`.
The count can repeat after rollback or remain at its cap of 100. The old
per-order upload deduplication policy is no longer used.

## Report delivery

Every new `SIGNOFF` creates a report job, including re-sign-off after rework.
Download `payload.reportPdfLink`, validate its `%PDF-` header, then POST to
`https://api.krjdiagnostics.com/hmserp/api/Patient/send-report` as multipart:

| Field | Value |
| --- | --- |
| `orderId` | `payload.originReferenceId` as text |
| `multipartFile` | Downloaded PDF bytes, `Content-Type: application/pdf` |

The URL is the download source, not the multipart file contents. Attachment
`path` IDs and internal report storage paths cannot be used as external links.
Downloads require an explicitly configured HTTPS PACS hostname, reject redirects,
and are limited to 20 MiB by default. A temporarily unavailable PDF retries
because the PACS event can precede the originating transaction's commit.

## Production group and configuration

KRJ's PACS group is **27919**. Group 48991 retains Ramsnehi's WhatsApp route.
The KRJ code defaults to the agreed group and share-link mapping; the production
environment makes these settings explicit:

```dotenv
NODE_ENV=production
HIMS_KRJ_GROUP_ID=27919
HIMS_KRJ_ZIP_FIELD=shareLink
HIMS_KRJ_REPORT_HOSTS=app.nandico.in
```

`app.nandico.in` is the host observed in stored PACS viewing and report links.
Its PDF endpoint was checked with HTTPS, returned `application/pdf`, and the
response began with `%PDF-`. Additional report download hosts require explicit
configuration. Group 0 remains an optional isolated local-test override and
cannot dispatch in production.

Incoming Basic Auth and HMAC credentials must match PACS and are preserved on
deployment. No outbound HIMS authentication was supplied, so the adapter
currently sends no authorization header to HIMS.

TLS validation is enabled. The existing temporary exception
`HIMS_KRJ_ALLOW_INVALID_TLS=true` is restricted to the two fixed KRJ HIMS
endpoints. PACS downloads and other providers retain certificate verification.
No HIMS redirect is followed.

## Testing

```bash
npm test
npm run test:hims
npm run test:msgclub
```

`test:hims` starts local Postman stand-ins, runs the real receiver, SQLite,
worker, JSON and multipart clients, then stops the simulation. It tests group 27919,
patient-less and multi-recipient uploads, repeated/capped upload counts,
duplicate envelope IDs, re-sign-off, missing-field review states, PDF failures,
and signed events from both the CLI and the Postman collection. No live HIMS
write or WhatsApp send is made. Stand-in success does not establish vendor
persistence, deployed sender fields or certificate handling.

For manual end-to-end checks against a running add-on, import
[the signed KRJ outbox collection](../examples/centers/krj/outbox.postman_collection.json).
Set `baseUrl`, incoming `basicPassword` and `hmacSecret`, the controlled `orderId`,
`shareLink` and `reportPdfLink`. Set `allowHimsSend=true` to send. The collection
builds `STUDY_UPLOADED` and `SIGNOFF` envelopes with fresh signatures and uses
group 27919 by default. HTTP 200 establishes durable receiver acceptance;
inspect the job status for the downstream HIMS outcome.

For a breakpoint-style manual order override, edit the relevant synthetic
[upload](../examples/centers/krj/study-uploaded.json) or
[sign-off](../examples/centers/krj/signoff.json) fixture to contain real test links,
then run against the local add-on:

```bash
npm run send-event -- --hims --allow-send \
  --file examples/centers/krj/study-uploaded.json \
  --group 27919 --order-id YOUR_CONTROLLED_TEST_ORDER_ID
```

Use `examples/centers/krj/signoff.json` for a report event. `--order-id` sets
`payload.originReferenceId` as a string. A HIMS-only test does not require
`--to`; standard WhatsApp tests still require a controlled recipient. The helper
rejects group 0 for remote hosts. These manual tests can perform real HIMS
writes if the worker uses the real vendor endpoints.

For direct HIMS testing, import
[the write collection](../examples/hims-write.postman_collection.json). It skips
requests until `allowLiveHimsWrite=true`. Select a local PDF for the multipart
request. The sample vendor order `1134` is not assumed to be a test order.

## Delivery and remaining verification

The worker records HIMS acceptance for documented empty 2xx replies or explicit
JSON success. Known rate limits retry. Timeouts, uncertain acknowledgements,
server errors and interrupted writes require review because HIMS may already
have applied the request. Missing order/ZIP/report values also require review,
without making a HIMS call. Job status and safe error codes are available via
`npm run jobs -- list`; payloads and links stay out of logs.

Events can arrive out of order. The PACS contract also says a message can
survive rollback of the originating upload/sign-off transaction, or be lost if
enqueue fails. Receiver acknowledgement therefore does not prove PACS upload
persistence or HIMS business completion. The user has confirmed group 27919 and shareLink mapping. Deployed PACS events,
report multipart names, HIMS success body and final order/PDF state still need
a controlled live check with the two system owners.
