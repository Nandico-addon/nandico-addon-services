# View KRJ patient events and processing logs

The standalone script is `src/centers/krj/scripts/view-logs.py`. It uses Python's
standard library, opens SQLite with `mode=ro` and `query_only=ON`, and does not
load the application, recover jobs, migrate tables, download PDFs or call HIMS.
It runs separately from the service; installation requires no service restart.

Run these commands on the live server after connecting with
`ssh root@168.144.187.125`:

```bash
# Latest 20 events: patient details, order/study IDs, job results and errors.
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py

# Full saved PACS payload, reconstructed HIMS request fields and correlated logs.
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --study 17687269 --full

# Live view: initial results, then only new or changed events, every five seconds.
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --study 17687269 --full --follow

# Other filters; these can also be combined.
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --patient "RESHMABEN" --full
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --order 133123 --full
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --date 2026-11-26 --full --limit 50
python3 /opt/nandico-addon/src/centers/krj/scripts/view-logs.py --event 2184 --full
```

Press Ctrl+C to leave the viewer. The application continues running. `--help`
lists options, including alternate database/log locations. The default group is
KRJ 27919. Filters use the received date in **IST**; both UTC and IST timestamps
are displayed. The limit applies to events, newest first; output is chronological
within that selection. There is no persistent viewer process unless you run it.

## What the output establishes

- `receivedEnvelope` is the complete stored PACS event, including patient details.
- `jobs` shows current persisted action, attempts, status, error and update time.
- `processingLogs` contains up to the last 200 available correlated records per
  event. Deleted logs cannot be recovered by this viewer. Entries without an
  event ID, such as startup or pre-validation failures, cannot be attributed to
  a patient; inspect those with `journalctl -u nandico-addon.service`.
- `himsRequestPreviews` reconstructs requests from the event and its **saved**
  configuration. Historical jobs therefore show their historical mapping.
  These previews are not exact captured HTTP requests or proof that a request
  reached HIMS. Report previews show the download URL and PDF file metadata;
  the PDF binary and exact HIMS response bodies were not retained.
- A job with `accepted` means the provider acknowledgement passed the adapter's
  checks. It does not independently inspect the HIMS UI or database.

The viewer writes only to the terminal. It does not create a new log archive.
Full output contains patient details and report links; redirect it only to a
private location if you need to save it. Follow mode closes all database reads
before waiting, reads only appended log lines, and bounds cached records to
limit load. It never changes job state, replays events or sends messages.

## Removing old logs

Yes, old application log files can be removed to free disk space without
removing events or jobs. Keep any records needed for troubleshooting or retention.
Do not remove today's UTC log while investigating an active case. The viewer
will still show stored patient events and job results after old logs are removed,
but the deleted processing timeline will be unavailable.

Check disk usage and preview application logs older than 30 days:

```bash
du -sh /opt/nandico-addon/logs
df -h /opt/nandico-addon
find /opt/nandico-addon/logs -maxdepth 1 -type f \
  -name 'app-????-??-??.log' -mtime +30 \
  ! -name "app-$(date -u +%F).log" -print
```

After reviewing that list, this removes those same old application log files:

```bash
find /opt/nandico-addon/logs -maxdepth 1 -type f \
  -name 'app-????-??-??.log' -mtime +30 \
  ! -name "app-$(date -u +%F).log" -delete
```

Never delete `data/backend/outbox.sqlite`, `outbox.sqlite-wal`,
`outbox.sqlite-shm`, the `data/` directory or `.env` as log cleanup. These are
application data/configuration, not disposable text logs. This script performs
no cleanup and does not change system journal retention or other integrations.

## Verification

Run the synthetic read-only and follow-mode checks without external services:

```bash
python3 -m unittest discover -s test/centers/krj -p 'test_view_logs.py' -v
```

Installed on the live server on 26 November 2026 after a code/private-environment
and consistent SQLite backup at
`/var/backups/nandico-addon/krj-log-viewer-20261126T113915Z`. A read-only run for
study 17687269 displayed both accepted upload events and the accepted report
event, each with four correlated processing records. Health stayed OK and the
service process ID did not change. Runtime JavaScript, environment, prior event
bodies/configuration and job identities/routes were verified unchanged. All six
synthetic checks passed; no delivery code was changed or restarted.
