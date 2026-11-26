"""Synthetic checks for the standalone viewer; no providers or app process run."""
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[3] / 'src/centers/krj/scripts/view-logs.py'
spec = importlib.util.spec_from_file_location('krj_view_logs', SCRIPT)
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / 'data/backend/outbox.sqlite'
        self.database.parent.mkdir(parents=True)
        self.logs = self.root / 'logs'
        self.logs.mkdir()
        self.writer = sqlite3.connect(self.database)
        self.addCleanup(self.writer.close)
        self.writer.executescript('''
            CREATE TABLE events (id INTEGER PRIMARY KEY, group_id INTEGER, type TEXT,
                body TEXT, group_config TEXT, request_id TEXT, disposition TEXT, received_at TEXT);
            CREATE TABLE jobs (id INTEGER PRIMARY KEY, event_id INTEGER, action TEXT,
                status TEXT, attempts INTEGER, error_code TEXT, updated_at TEXT);
        ''')
        self.add_event(1, 'STUDY_UPLOADED', '2026-11-25T18:29:59.000Z', 'SYNTHETIC BEFORE')
        self.add_event(2, 'STUDY_UPLOADED', '2026-11-25T18:30:00.000Z', 'SYNTHETIC 100%_NAME')
        self.add_event(3, 'SIGNOFF', '2026-11-26T18:29:59.000Z', 'SYNTHETIC 100%_NAME')
        self.add_event(4, 'SIGNOFF', '2026-11-26T18:30:00.000Z', 'SYNTHETIC AFTER')
        self.add_event(5, 'SIGNOFF', '2026-11-26T08:00:00.000Z', 'OTHER CENTER', group_id=48991)

    def add_event(self, identity, kind, received, name, group_id=27919):
        event = {'id': identity, 'groupId': group_id, 'type': kind, 'reportStatusId': 900001,
                 'payload': {'reportStatusId': 900001, 'patientName': name,
                             'originReferenceId': '0001134', 'hasReport': kind == 'SIGNOFF',
                             'ftpPath': 'synthetic/archive.zip', 'shareLink': 'https://example.test/view',
                             'reportPdfLink': 'https://example.test/report.pdf' if kind == 'SIGNOFF' else None}}
        group = {'provider': 'krj_hims', 'zipField': 'shareLink' if identity == 1 else 'ftpPath'}
        self.writer.execute('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)',
                            (identity, group_id, kind, json.dumps(event), json.dumps(group), 'request-' + str(identity), 'queued', received))
        self.writer.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)',
                            (identity, identity, 'send_report' if kind == 'SIGNOFF' else 'mark_uploaded', 'processing', 1, None, received))
        self.writer.commit()

    def args(self, *args):
        return viewer.options(['--root', str(self.root), *args])

    def test_readonly_query_and_main_do_not_change_data_or_recover_processing_jobs(self):
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(viewer.main(['--root', str(self.root), '--study', '900001', '--full']), 0)
        self.assertIn('SYNTHETIC', stdout.getvalue())
        self.assertNotIn('OTHER CENTER', stdout.getvalue())
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before)
        self.assertEqual(self.writer.execute("SELECT count(*) FROM jobs WHERE status='processing'").fetchone()[0], 5)
        connection = viewer.connect_readonly(self.database)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute('DELETE FROM jobs')
        finally:
            connection.close()

    def test_ist_boundaries_and_literal_patient_filters(self):
        rows = viewer.records(self.args('--date', '2026-11-26', '--patient', '100%_name', '--order', '0001134'))
        self.assertEqual([row['eventId'] for row in rows], [3, 2])
        self.assertEqual(rows[1]['receivedAtIST'], '2026-11-26T00:00:00+05:30')
        self.assertEqual(viewer.records(self.args('--patient', "' OR 1=1 --")), [])
        self.assertEqual(viewer.records(self.args('--order', '1134')), [])
        self.assertEqual([r['eventId'] for r in viewer.records(self.args('--limit', '1'))], [4])

    def test_request_previews_use_saved_mappings_and_never_treat_url_as_pdf_bytes(self):
        legacy = viewer.records(self.args('--event', '1', '--full'))[0]
        new = viewer.records(self.args('--event', '2', '--full'))[0]
        report = viewer.records(self.args('--event', '3', '--full'))[0]
        self.assertEqual(legacy['himsRequestPreviews'][0]['body']['ZipFilePath'], 'https://example.test/view')
        self.assertEqual(new['himsRequestPreviews'][0]['body']['ZipFilePath'], 'synthetic/archive.zip')
        file = report['himsRequestPreviews'][0]['fields']['multipartFile']
        self.assertEqual(file['filename'], 'report.pdf')
        self.assertEqual(file['downloadSource'], 'https://example.test/report.pdf')
        self.assertNotIn('customerReportId', report['receivedEnvelope']['payload'])
        self.assertIn('not a wire capture', report['requestPreviewNote'])

    def test_incremental_logs_partial_lines_rotation_and_job_changes(self):
        path = self.logs / 'app-2026-11-26.log'
        def entry(event, status):
            return json.dumps({'eventId': event, 'groupId': 27919, 'event': status})
        path.write_text('invalid json\n' + entry(3, 'notification.started') + '\n' + entry(3, 'notification.accepted'))
        index = viewer.LogIndex(self.logs, 27919)
        selected = viewer.records(self.args('--event', '3', '--full'))
        index.attach(selected)
        self.assertEqual(len(selected[0]['processingLogs']), 1)
        index.attach(selected)
        self.assertEqual(len(selected[0]['processingLogs']), 1)
        with path.open('a') as output:
            output.write('\n')
        index.attach(selected)
        self.assertEqual(len(selected[0]['processingLogs']), 2)
        self.writer.execute("UPDATE jobs SET status='accepted' WHERE id=3")
        self.writer.commit()
        self.assertEqual(viewer.records(self.args('--event', '3'))[0]['jobs'][0]['status'], 'accepted')
        other = self.logs / 'app-2026-11-27.log'
        other.write_text(entry(3, 'later.record') + '\n')
        index.attach(selected)
        self.assertEqual(selected[0]['processingLogs'][-1]['event'], 'later.record')
        self.assertTrue(index.warnings)

    def test_missing_database_is_not_created_and_missing_logs_are_reported(self):
        missing = self.root / 'missing.sqlite'
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(viewer.main(['--database', str(missing)]), 1)
        self.assertFalse(missing.exists())
        index = viewer.LogIndex(self.root / 'no-logs', 27919)
        rows = viewer.records(self.args('--event', '3', '--full'))
        index.attach(rows)
        self.assertEqual(rows[0]['processingLogs'], [])
        self.assertTrue(index.warnings)

    def test_follow_emits_changes_only_and_exits_cleanly(self):
        original_sleep, calls = viewer.time.sleep, []
        self.addCleanup(setattr, viewer.time, 'sleep', original_sleep)
        def sleep(_):
            calls.append(1)
            if len(calls) == 1:
                return
            if len(calls) == 2:
                self.writer.execute("UPDATE jobs SET status='accepted' WHERE id=3")
                self.writer.commit()
                return
            raise KeyboardInterrupt()
        viewer.time.sleep = sleep
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(viewer.main(['--root', str(self.root), '--event', '3', '--follow']), 0)
        self.assertEqual(output.getvalue().count('"eventId": 3'), 2)


if __name__ == '__main__':
    unittest.main()
