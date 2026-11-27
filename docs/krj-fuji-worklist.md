# Fuji CR worklist: group-length query failure

The supplied 27 November 2026 screenshots show Fuji connecting as AE `FCR-CSL`
and querying the `KRJ_MWL` worklist server for modality `CR`. The API fetch
returned 47 patients and the app prepared 14 orders, but then returned DICOM
`0xA900` with `QUERY_UNSUPPORTED` and sent no results.

The query screenshot includes populated retired group-length elements such as
`(0008,0000)`, `(0010,0000)` and `(0040,0000)`, at the top level and inside
sequences. These are encoding metadata. They are not patient-search criteria.
DICOM PS3.5 section 7.2 permits implementations to discard these elements:
https://dicom.nema.org/MEDICAL/Dicom/2024a/output/chtml/part05/sect_7.2.html

The old matcher treated top-level group lengths as unsupported populated keys,
raising `QUERY_UNSUPPORTED`. It also treated nested group lengths as real
matching constraints, so otherwise empty optional return sequences could
exclude every order.

`src/centers/krj/fetch worklist code/main.py` now skips elements whose tag's
`element == 0x0000` in both `has_matching_keys()` and `matches_query()`. Existing
patient, modality, date and procedure filters are still enforced; unsupported
non-metadata constraints still fail explicitly.

## Apply on the Windows worklist PC

Keep the current scanner settings and installed `config.txt`, including the
working AE/IP/port and both the CR listener and `X-RAY=CR` category mapping.
This source change does not change any production modality mapping or ports.

Back up the existing installation, configuration and logs before updating. If
running Python source, stop the worklist process, replace the source with the
fixed version in the existing folder, then restart that process. The focused
change is to both matcher conditions:

```python
if element.tag.element == 0x0000 or element.tag.is_private or element.keyword in ('SpecificCharacterSet', 'QueryRetrieveLevel'):
    continue
```

If running `KRJWorklist.exe`, rebuild the executable on Windows from the fixed
source using the existing build process. Replacing a loose `main.py` does not
patch a frozen executable. Replace the executable and its matching `_internal`
files as a set, preserving the installed configuration and logs. A rebuilt
Windows executable was not produced or installed from this Linux session.

After restarting the worklist app, refresh RIS on Fuji. Inspect the same
request's `worklist.query.payload`, `worklist.query.results`,
`worklist.response.payload`, and `worklist.query.completed sent=`. Eligible
matches should return pending responses followed by success; the actual
scanner display still needs verification on the installed Windows build.

## Regression evidence

`fixtures/fuji-worklist-query.json` transcribes the captured query structure
using a synthetic date and no patient identities. The regression uses local
synthetic HIMS data and real DICOM associations. Its test peer deliberately
preserves group-length elements on the wire, because pydicom's ordinary writer
removes them and would otherwise hide this failure.

Before the fix, the root-element replay failed with `0xA900`; a separate replay
with only nested group lengths returned zero results. Both returned the
expected synthetic CR order after the fix. Real patient, modality and procedure
constraints and populated optional sequence filters remained enforced; an
unsupported populated scalar still returned `0xA900`.

All 11 Python integration tests passed, including the existing Siemens CT/MR
query regressions and Echo tests on every configured test listener. Backend
checks passed 37 tests with 6 simulation wrappers skipped; HIMS simulation
passed 14 checks with 44 HTTP events; MsgClub passed 9 with 33 HTTP events.
No live HIMS/WhatsApp calls were made. No Linux service, private environment,
database, historical jobs or running Windows installation was modified.

Follow-up build-kit verification on 27 November added explicit order-return
checks for CT, MR, US (sonography and Doppler), DX and MG, together with CR and
legacy group lengths. All 13 tests passed both in the source folder and after
extracting the refreshed existing source ZIP into a temporary clean directory.
The PowerShell build now stops before packaging if a regression check fails.
Production `config.txt`, ports, mappings and AE Title were unchanged. The ZIP
has one source folder and excludes environments, builds, bytecode and logs.

To generate the Windows app, open PowerShell in that extracted source folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

Keep the existing installed configuration when replacing the generated EXE
and `_internal` files. This session did not create a native Windows executable.
