# KRJ HIMS integration

Start here when working on KRJ. Its configuration, PACS event rules, request
mapping and HTTP implementation are together in this folder.

```text
krj/
  index.js       Center module and HIMS provider registration
  config.js      Group 27919, shareLink mapping and environment settings
  workflow.js    STUDY_UPLOADED/SIGNOFF actions, deduplicated by envelope ID
  payload.js     Accession-to-order mapping, JSON body and multipart form
  provider.js    HIMS endpoints, PDF download, TLS and acknowledgement handling
```

KRJ uses PACS group **27919**. `STUDY_UPLOADED` calls mark-uploaded with
`payload.originReferenceId` as `OrderId` and the full `payload.shareLink` as
`ZipFilePath`. `SIGNOFF` downloads `payload.reportPdfLink` and uploads PDF bytes
for the same order. These mappings were confirmed by the user on 1 November.
Missing downstream values are retained as review jobs without dropping events.

The independent scanner-side worklist code is in `fetch worklist code/`, using
the supplied MediMind example's structure: `main.py`, `config.txt`,
`requirements.txt`, and `utils/utils.py`. It maps KRJ treatment `Tranid` to the
accession number. Install with `python -m pip install -r requirements.txt`, then
run `python main.py` from that folder. Set scanner ports and AE title in
`config.txt`. This Python process is separate from the add-on server.
The app's HIMS hospital ID (5) and branch ID (1) are separate from PACS group
27919. The Node service does not import or launch any Python worklist code.

For VS Code on Windows, open the worklist folder, install the Python extension,
and run these commands in its PowerShell terminal with Python 3.10 or newer:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

Choose `.venv\Scripts\python.exe` with **Python: Select Interpreter** to use the
VS Code Run/Debug button. Ctrl+C stops the listeners. Settings are in `config.txt`;
runtime logs are written to `krj-worklist.log` beside it. The worklist app is
packaged separately and is excluded from the add-on's server release archive.

## Where to work

| Task | Location |
| --- | --- |
| Inspect the order ID or put a debugger breakpoint on it | `payload.js` → `himsOrderId()` reads `payload.originReferenceId` |
| Change mark-uploaded JSON fields | `payload.js` → `buildMarkUploadedPayload()` |
| Change report multipart fields | `payload.js` → `buildReportForm()` |
| Change which PACS event triggers a HIMS action | `workflow.js` → `planJobs()` |
| Configure a PACS group or the ZIP payload field | Private environment, variable names in [the environment example](../../../.env.example) |
| Change download rules, endpoints, certificate behavior or response handling | `provider.js` |

The center registry uses `createConfig` and `planJobs` from `index.js`, and
registers its `krj_hims` provider. Shared delivery planning delegates to this
center module. The existing receiver, authentication, SQLite repository and
worker handle acceptance and retries for all integrations.

## Test and reference files

- [API contract, mapping and activation details](../../../docs/krj-hims-integration.md)
- [Signed upload/report events](../../../examples/centers/krj/outbox.postman_collection.json)
- [Upload fixture](../../../examples/centers/krj/study-uploaded.json) and [sign-off fixture](../../../examples/centers/krj/signoff.json)
- [Postman write collection](../../../examples/hims-write.postman_collection.json)
- [Postman treatment/worklist check](../../../examples/hims.postman_collection.json)
- [Configuration, workflow and persistence tests](../../../test/centers/krj/unit.test.js)
- [Authenticated HTTP simulation tests](../../../test/centers/krj/simulation.test.js)
- [HIMS and PACS-file simulation](../../../postman/simulations/hims.sim.yaml)

Run `npm test` and `npm run test:hims` from the repository root. The simulation
uses synthetic orders and local files. Enter a test order manually in the
Postman collection, or supply it as `payload.originReferenceId` in a test PACS
event; keep production order IDs out of source code.
