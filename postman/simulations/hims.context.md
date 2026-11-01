# KRJ HIMS simulation

Structured assumptions and current verification are in `hims.context.yaml`.
The 2026-10-31 fingerprints were tested with uncommitted changes, including the
KRJ folder refactor and subsequent center layout; their commit identifies the
base revision only. The later study-uploaded-contract fingerprint also includes
uncommitted changes for the new four-event contract and local group 0. Current tests are in `test/centers/krj/` and source is in
`src/centers/krj/` with common infrastructure in `src/shared/`.

Created 2026-10-27 from the vendor's JSON example, HIMS report PDF contract and
PACS consumer guide. No owning-team mock was available through connected tools;
the local mocks encode those supplied documents.

## Purpose

Exercise the real receiver and worker against HIMS writes and PACS PDF downloads.
Request validation lives in `../mocks/krj-hims/default.js`; file fixtures and
failure controls live in `../mocks/pacs-files/default.js`.

## Execution

Run `npm run test:hims`. The runner starts both members on a free local port,
runs signed-event HTTP tests, records simulation request events, and stops the
process group. It does not require cloud login or publish test traffic.

## Assumptions

The 31 October STUDY_UPLOADED contract supersedes the earlier viewing-event
upload policy. Group 0 is now the local placeholder. On 1 November the user confirmed group 24564 and the full shareLink URL as
HIMS ZipFilePath. The earlier zipFilePath assumption is superseded. The historical findings below remain
as evidence of the earlier runs, not current sender configuration.

- The vendor report endpoint uses the PDF's `orderId` and `multipartFile` field
  names, and successful writes return empty 200. Live validation remains pending;
  passing this simulation establishes client behavior against that contract.
  (reasoned 2026-10-27, `docs/krj-hims-integration.md`)
- The synthetic `zipFilePath` field and test group do not establish what the
  deployed sender emits. The real ZIP source and PACS group remain required.
  (observed 2026-10-27, `test/hims-simulation.test.js`)
- Certificate failures, real HIMS persistence and actual PACS event generation
  are outside this local HTTP simulation. (observed 2026-10-27)

## Observations

<!-- begin:observations -->
2026-11-01 (deployment): release krj-20261101T072856Z is live for group 24564
with shareLink mapping. Public signed/duplicate checks returned 200 and produced
no outbound jobs. Real HIMS success writes await a designated test order.
2026-11-01 (group 24564/shareLink): 12 checks passed with 37 HTTP events; both
members served traffic, including signed Postman and CLI inputs and report bytes.
The production PACS PDF host was verified separately without a HIMS write.
2026-10-31 (upload contract): all 12 HIMS checks passed with 37 HTTP events.
Both members served traffic. Signed CLI and Postman inputs exercised local
group 0, patient-less uploads, re-upload IDs, JSON confirmation and PDF bytes.
Missing downstream data was retained for review; no live writes ran.
2026-10-31 (center layout): both members served requests after moving center code
and shared infrastructure. All 8 HIMS checks passed with 21 HTTP events, and all
9 Ramsnehi/MsgClub simulation checks passed. No live writes ran.
2026-10-31: after consolidating KRJ source under `src/integrations/hims/krj/`,
both members again served requests. All 8 HIMS simulation tests passed with
21 HTTP events; the 9 MsgClub simulation tests also passed. No live writes ran.
2026-10-27: both HIMS and PACS-file members served requests. The real worker sent
JSON and binary multipart requests, suppressed duplicate upload notifications,
sent re-sign-off reports, and preserved failure/review decisions. All checks passed.
<!-- end:observations -->

2026-11-01 (group correction): the user corrected KRJ's actual group to 27919. Current configuration, examples and tests use 27919; the group-24564 entries above describe earlier verification. Historical accepted events and jobs are retained.

2026-11-01 (group 27919 live): revision 962672fccf5016e7fe9d279ff196855b472842d2 passed 36 backend, 12 HIMS and 9 MsgClub checks and was deployed as krj-27919-20261101T090606Z. Public KRJ filtered/duplicate and Ramsnehi no-recipient checks passed with zero outbound jobs; old group 24564 returns 503. All previous events/jobs and other environment settings were preserved. Python worklist source was committed to GitHub but excluded from deployment. See docs/deployments/krj-27919-20261101T090606Z.md.
