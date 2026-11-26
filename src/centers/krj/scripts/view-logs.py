#!/usr/bin/env python3
"""Read KRJ events, jobs and correlated logs without loading the application."""
import argparse
from collections import OrderedDict, deque
from datetime import date, datetime, time as day_time, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time

IST = timezone(timedelta(hours=5, minutes=30))
HIMS = 'https://api.krjdiagnostics.com/hmserp/api/Patient'


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError('Use a positive number')
    return number


def options(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[4],
                        help='Application root; defaults to the parent of src/')
    parser.add_argument('--database', type=Path, help='Override the SQLite path (opened read-only)')
    parser.add_argument('--log-dir', type=Path, help='Override the application log directory')
    parser.add_argument('--group', type=positive, default=27919, help='PACS group (default: 27919)')
    parser.add_argument('--study', type=positive, help='PACS reportStatusId')
    parser.add_argument('--event', type=positive, help='Exact envelope event ID')
    parser.add_argument('--order', help='Exact HIMS order reference, preserving leading zeros')
    parser.add_argument('--patient', help='Patient name contains this literal text (case insensitive)')
    parser.add_argument('--date', type=date.fromisoformat, help='Received date in IST: YYYY-MM-DD')
    parser.add_argument('--limit', type=positive, default=20, help='Newest matching events, at most 500')
    parser.add_argument('--full', action='store_true', help='Include full PACS envelope and correlated logs')
    parser.add_argument('--follow', action='store_true', help='Print new/changed matching events until Ctrl+C')
    parser.add_argument('--interval', type=positive, default=5, help='Follow refresh seconds, minimum 2')
    args = parser.parse_args(argv)
    if args.limit > 500 or args.interval < 2:
        parser.error('--limit must be <= 500 and --interval must be >= 2')
    args.database = args.database or args.root / 'data/backend/outbox.sqlite'
    args.log_dir = args.log_dir or args.root / 'logs'
    return args


def connect_readonly(path):
    # mode=ro fails for a missing file and cannot create/migrate/recover jobs.
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def received_ist(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(IST).isoformat()


def at_path(value, path):
    for key in str(path or '').split('.'):
        value = value.get(key) if isinstance(value, dict) else None
    return value


def request_preview(envelope, group, action):
    """Describe saved mappings, without downloading a PDF or making any requests."""
    if group.get('provider') != 'krj_hims':
        return None
    payload = envelope['payload']
    if action == 'mark_uploaded':
        return {'method': 'POST', 'url': HIMS + '/mark-uploaded',
                'contentType': 'application/json',
                'body': {'OrderId': payload.get('originReferenceId'),
                         'ZipFilePath': at_path(payload, group.get('zipField'))},
                'savedZipField': group.get('zipField')}
    if action == 'send_report':
        return {'method': 'POST', 'url': HIMS + '/send-report',
                'contentType': 'multipart/form-data',
                'fields': {'orderId': payload.get('originReferenceId'), 'multipartFile': {
                    'filename': 'report.pdf', 'contentType': 'application/pdf',
                    'downloadSource': payload.get('reportPdfLink'),
                    'contents': 'PDF bytes downloaded during processing; bytes are not stored here'}}}
    return None


def records(args):
    conditions, values = ['group_id = ?'], [args.group]
    for argument, expression in [('study', "json_extract(body, '$.reportStatusId')"),
                                 ('event', 'id'),
                                 ('order', "json_extract(body, '$.payload.originReferenceId')")]:
        value = getattr(args, argument)
        if value is not None:
            conditions.append(expression + ' = ?')
            values.append(value)
    if args.patient:
        conditions.append("instr(lower(coalesce(json_extract(body, '$.payload.patientName'), '')), lower(?)) > 0")
        values.append(args.patient)
    if args.date:
        start = datetime.combine(args.date, day_time(), tzinfo=IST)
        for operator, instant in [('>=', start), ('<', start + timedelta(days=1))]:
            conditions.append('received_at ' + operator + ' ?')
            values.append(instant.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
    values.append(args.limit)
    connection = connect_readonly(args.database)
    try:
        # Finish all reads and close before inspecting logs or waiting. No long read transaction.
        rows = connection.execute('SELECT * FROM events WHERE ' + ' AND '.join(conditions) +
                                  ' ORDER BY received_at DESC, id DESC LIMIT ?', values).fetchall()
        if not rows:
            return []
        ids = [row['id'] for row in rows]
        jobs = connection.execute('SELECT * FROM jobs WHERE event_id IN (' +
                                  ','.join('?' for _ in ids) + ') ORDER BY id', ids).fetchall()
    finally:
        connection.close()
    result = []
    for row in rows:
        envelope = json.loads(row['body'])
        payload = envelope['payload']
        group = json.loads(row['group_config'])
        event_jobs = [dict(job) for job in jobs if job['event_id'] == row['id']]
        record = {'eventId': row['id'], 'groupId': row['group_id'], 'eventType': row['type'],
                  'patientName': payload.get('patientName'), 'studyId': payload.get('reportStatusId'),
                  'orderId': payload.get('originReferenceId'), 'receivedAtIST': received_ist(row['received_at']),
                  'receivedAtUTC': row['received_at'], 'disposition': row['disposition'],
                  'requestId': row['request_id'], 'jobs': event_jobs}
        if args.full:
            record.update({'receivedEnvelope': envelope, 'savedGroupConfiguration': group,
                           'himsRequestPreviews': [preview for job in event_jobs
                               if (preview := request_preview(envelope, group, job.get('action')))],
                           'requestPreviewNote': 'Reconstructed from the stored event and its saved configuration; '
                               'not a wire capture. A planned or attempted job does not prove an HTTP send. '
                               'Exact HIMS response bodies and multipart bytes were not retained.'})
        result.append(record)
    return result


class LogIndex:
    """Incrementally read complete lines, bounding memory and closing files each poll."""
    def __init__(self, directory, group):
        self.directory, self.group = directory, group
        self.positions, self.entries = {}, OrderedDict()
        self.warnings = set()

    def update(self, selected):
        protected = {record['eventId'] for record in selected}
        earliest = min((record['receivedAtUTC'][:10] for record in selected), default='9999')
        if not self.directory.is_dir():
            self.warnings.add('Log directory is missing; database results are still available.')
            return
        for path in sorted(self.directory.glob('app-????-??-??.log')):
            if path.name[4:14] < earliest:
                continue
            try:
                with path.open('rb') as stream:
                    stat = path.stat()
                    identity, offset = self.positions.get(path, (None, 0))
                    if identity != (stat.st_dev, stat.st_ino) or stat.st_size < offset:
                        offset = 0
                    stream.seek(offset)
                    while True:
                        start = stream.tell()
                        line = stream.readline()
                        if not line or not line.endswith(b'\n'):
                            stream.seek(start)
                            break
                        try:
                            item = json.loads(line)
                            event_id = item.get('eventId')
                            if item.get('groupId') != self.group or not isinstance(event_id, int):
                                continue
                        except (ValueError, AttributeError):
                            self.warnings.add('Some malformed log lines were skipped.')
                            continue
                        bucket = self.entries.setdefault(event_id, deque(maxlen=200))
                        bucket.append(item)
                        self.entries.move_to_end(event_id)
                        while len(self.entries) > 2000:
                            removable = next((key for key in self.entries if key not in protected), None)
                            if removable is None:
                                break
                            del self.entries[removable]
                    self.positions[path] = ((stat.st_dev, stat.st_ino), stream.tell())
            except OSError:
                self.warnings.add('A log file could not be read or was removed; database results remain available.')

    def attach(self, selected):
        self.update(selected)
        for record in selected:
            entries = list(self.entries.get(record['eventId'], []))
            record['processingLogs'] = entries
            record['processingLogsNote'] = 'Up to the latest 200 correlated records per event; deleted logs cannot be recovered here.'


def main(argv=None):
    args = options(argv)
    index = LogIndex(args.log_dir, args.group)
    previous, announced = {}, set()
    empty_announced = False
    try:
        while True:
            selected = records(args)
            if args.full:
                index.attach(selected)
                for warning in sorted(index.warnings - announced):
                    print(warning, file=sys.stderr)
                    announced.add(warning)
            if not selected and not empty_announced:
                print('No matching stored events.', file=sys.stderr)
            empty_announced = not selected
            for record in reversed(selected):
                encoded = json.dumps(record, ensure_ascii=True, indent=2)
                fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
                if previous.get(record['eventId']) != fingerprint:
                    print(encoded, flush=True)
                previous[record['eventId']] = fingerprint
            visible = {record['eventId'] for record in selected}
            previous = {key: value for key, value in previous.items() if key in visible}
            if not args.follow:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    except (OSError, sqlite3.Error, ValueError, KeyError) as error:
        print('Cannot read event history: ' + str(error) + '\nCheck --root/--database and file permissions. No data was changed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
