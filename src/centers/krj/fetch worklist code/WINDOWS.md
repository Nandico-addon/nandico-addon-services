# KRJ background app for Windows

Build on Windows 10/11 x64 with Python 3.10 or newer. In VS Code, open the
worklist source folder and use its PowerShell terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

The build creates `dist\KRJWorklist-Windows-x64.zip` and the portable folder
`dist\KRJWorklist\`, like the supplied `medimind-ris.zip` reference:

```text
KRJWorklist/
  KRJWorklist.exe
  _internal/             Bundled Python and runtime files; keep this folder
  config.txt             KRJ API, scanner ports and AE title
  Enable PC Startup.cmd
  Enable Startup.cmd
  Start Worklist.cmd
  Stop Worklist.cmd
  Check Status.cmd
  Disable Startup.cmd
  manage-startup.ps1
  WINDOWS.md
```

The destination PC does not need Python or VS Code. The PowerShell build runs
the source integration checks before packaging; the generated executable still
needs a Windows installation check.

Extract the ZIP and keep the whole `KRJWorklist` folder together, including
`_internal`. Move it to a permanent folder your Windows account can write to,
for example `C:\KRJWorklist`. Configuration and rotating `krj-worklist.log` files
are read/written beside the executable. Keep existing `config.txt` when updating
an installation. Stop the app before replacing its executable or changing its
configuration, then start it again.

### Fuji CR group-length fix and existing modalities

The current source ignores retired DICOM group-length elements at the root and
inside sequences. This resolves the captured Fuji query's `QUERY_UNSUPPORTED`
error while preserving real matching keys. The build script now runs all 13
local synthetic integration tests before generating the executable and stops
if any test fails. The tests check returned orders on CT, MR, US (sonography
and Doppler), DX, MG and CR, modality isolation, patient filters, DICOM Echo,
Siemens queries, Fuji legacy metadata and upstream errors.

Do not replace an installation's existing `config.txt` with the source example.
Keep all working CT/MR/US/DX/MG ports and mappings. For the Fuji installation,
keep its verified CR listener/port and `X-RAY=CR` configuration. The fix itself
does not change any production port, AE Title or modality configuration.
The existing source ZIP contains one source folder and no virtual environment,
build output, executable, bytecode or patient logs. Build the new executable
on Windows, then replace its EXE and matching `_internal` folder while keeping
the installation's configuration and logs. A native Windows executable and
actual scanner results still require verification on the Windows PC.

### Siemens worklist matching fix

The source includes a fix for Siemens queries that request optional DICOM
sequences with empty child fields. These return requests no longer exclude
orders; populated patient, modality, date and procedure filters still apply.
The regression suite replays the reported Siemens query structure with a
synthetic date against local synthetic HIMS data for both CT and MR.

To apply the fix to an existing executable installation, rebuild on Windows
with `build-windows.ps1` or use a newly built Windows workflow artifact. Stop
the installed worklist and back up its entire folder, including `config.txt`
and logs. Replace `KRJWorklist.exe` and `_internal` with the new build, preserving
the installed configuration (including CT port `9999` if already configured).
Start the app, check `app.ready`, then select **Update Worklist** on the scanner.
For matching orders, the log should show `worklist.response.payload` and
`worklist.query.completed sent=` with a positive count. The PC needs the rebuilt
executable to use the fix.

## Run in the background

For startup when the PC boots, double-click **Enable PC Startup.cmd** once and
accept the Windows administrator prompt. It registers the `KRJWorklist-Boot`
scheduled task under the local SYSTEM account, launches the app immediately,
and starts it 30 seconds after subsequent Windows boots, before anyone signs in.
Keep the app on the PC's local disk (for example `C:\KRJWorklist`); mapped network
drives and your user's proxy settings may be unavailable to SYSTEM.

For startup only when your Windows user signs in, use **Enable Startup.cmd**
instead. This keeps the existing per-user startup option. Install one mode only;
remove the previous task with **Disable Startup.cmd** before switching modes.

Use **Check Status.cmd**, **Stop Worklist.cmd** and
**Start Worklist.cmd** to manage that installation. These control scripts briefly
open a command window so their result is visible; the worklist has no main window.
They automatically select the boot task when installed and request administrator
rights to manage it. Otherwise, they select the current user's sign-in task.
**Disable Startup.cmd** stops the app and removes its startup registration.

Alternatively, double-click `KRJWorklist.exe` to start manually without a console window.
Check Task Manager and `krj-worklist.log`; each modality should have a
`worklist.listening` entry. To stop a manually launched app, use Task Manager's
**End task**. Close any manual instance before installing automatic startup.

The equivalent commands in PowerShell, if needed, are:

```powershell
cd C:\KRJWorklist
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-startup.ps1 Install -StartupMode Boot
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-startup.ps1 Status
Get-Content .\krj-worklist.log -Tail 20
```

Both modes allow continuous running and retry up to three times at one-minute
intervals after an app failure. Boot mode runs independently of user sign-in;
sign-in mode runs while the installing user is signed in, including while locked.
Boot mode needs administrator approval because it creates a Windows system task.
To explicitly manage a sign-in task, add `-StartupMode Logon` to a command.
If sign-in task registration returns Access denied, open PowerShell as administrator
using the same Windows account and rerun with `Install -StartupMode Logon`.

Use these commands from the same Windows account to manage it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-startup.ps1 Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-startup.ps1 Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\manage-startup.ps1 Remove
```

`Remove` stops the task and removes automatic startup without deleting settings
or logs. Remove the task before moving the installed folder, then reinstall from
the new location. Run only one copy of the app on a PC: manual double-clicks
are separate from Task Scheduler's instance control and can conflict on ports.

## Verify from a scanner

Use the Windows PC's LAN IP, called AE `KRJ_MWL`, and the configured modality
port: US `2034`, MR `2035`, DX `2036`, MG `2037`, or CT `8888`.
Allow the app through Windows Firewall on the scanner's private network.
Run DICOM Echo followed by a worklist query. To reproduce the supplied API
example, query 15 October 2026; otherwise choose a date with known orders.
The API is fetched when the scanner queries; there is no periodic prefetch.

If the task is running but no results appear, inspect the log and check the date,
modality, AE title, network connection and port. With the PC asleep or powered
off, the app cannot answer scanner queries.

## Detailed runtime logs

`krj-worklist.log` records application start, configuration loading, listener
startup, DICOM connections and Echo checks, incoming scanner queries, API URL
and HTTP status, the full response body, every patient's details and treatments,
filter/skip reasons, duplicate/conflicting orders, mapped DICOM payloads, outgoing
DICOM responses, completion/cancellation, exceptions and graceful shutdown.
GET requests have no body; `hims.request` records `body: null` explicitly.
Each scanner query has a `requestId` so concurrent queries can be followed.
DICOM payloads use DICOM JSON tags and include nested procedure-step sequences.

Logs include full patient information. Keep the installation and logs in a folder
accessible only to authorized staff. Logs rotate at midnight with five daily
backups. The app fetches data when queried by a scanner, so API/patient/payload
entries appear after a worklist query, rather than immediately at app startup.
View recent entries with:

```powershell
Get-Content C:\KRJWorklist\krj-worklist.log -Tail 100 -Wait
```

Source regression checks use a local HTTP fixture and synthetic patients only:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s . -p test_worklist.py
```

## Diagnose startup failures

Stop any existing KRJ app instance first. From the source folder on Windows run:

```powershell
.\.venv\Scripts\python.exe diagnose-startup.py
```

This temporarily opens each configured listener and closes them afterwards;
it makes no HIMS request. It prints the exception and the modality/port being
checked. The rebuilt executable also includes startup exception details in
`krj-worklist.log`. Before assuming a port conflict, check that actual error.

Use the final `dist\KRJWorklist` folder for installation. The executable under
`build\KRJWorklist` is an intermediate file and has no adjacent runtime files.
If the build reports a missing startup-control script, extract the complete
source kit; do not copy files from `.venv` or an intermediate build as the app.
