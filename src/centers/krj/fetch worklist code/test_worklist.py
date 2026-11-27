"""Run the real app against local HTTP/DICOM peers; never contact live HIMS."""
import configparser
import copy
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from unittest.mock import patch

from pydicom.dataset import Dataset
from pydicom.filebase import DicomBytesIO
from pydicom.filewriter import write_data_element
from pynetdicom import AE, _config
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification

_config.LOG_REQUEST_IDENTIFIERS = False
_config.LOG_RESPONSE_IDENTIFIERS = False
DAY = '20261015'
API_PATH = '/hmserp/api/Patient/GetPatientTreatmentDetails/hospitalId/5/branchId/1/FromDate/2026-10-15/ToDate/2026-10-15'
PATIENT = {
    'Patientid': 'SYNTHETIC-01', 'Name': 'Synthetic Patient', 'Gender': 'FEMALE',
    'Age': 30, 'Birthdate': '15/10/1996', 'Ref_doctor': 'Synthetic Doctor',
    'ExtraPatientDetail': 'Full source detail',
    'TestMastVMs': [
        {'Tranid': '0032001', 'Treatmentname': 'Synthetic MRI', 'Categoryname': 'MRI',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026', 'Addtime': '09:30:00'},
        {'Tranid': '0032002', 'Treatmentname': 'Synthetic CT', 'Categoryname': 'CTSCAN',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
        {'Tranid': '0032003', 'Treatmentname': 'Synthetic X-ray', 'Categoryname': 'X-RAY',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
        {'Tranid': '0032004', 'Treatmentname': 'Synthetic Sonography', 'Categoryname': 'SONOGRAPHY',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
        {'Tranid': '0032005', 'Treatmentname': 'Synthetic Doppler', 'Categoryname': 'DOPPLER',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
        {'Tranid': '0032006', 'Treatmentname': 'Synthetic Mammography', 'Categoryname': 'MAMMOGRAPHY',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
        {'Tranid': '0032007', 'Treatmentname': 'Synthetic DX', 'Categoryname': 'SYNTHETIC-DX',
         'Hospitalid': 5, 'Branchid': 1, 'Adddate': '15/10/2026'},
    ],
}


class WorklistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory(prefix='krj-worklist-test-')
        cls.addClassCleanup(temporary.cleanup)
        cls.folder = Path(temporary.name)
        source = Path(__file__).resolve().parent
        shutil.copy2(source / 'main.py', cls.folder)
        shutil.copytree(source / 'utils', cls.folder / 'utils', ignore=shutil.ignore_patterns('__pycache__'))
        cls.calls = []
        cls.mode = 'ok'

        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                cls.calls.append((url.hostname, url.path))
                if url.hostname != 'api.krjdiagnostics.com' or url.path != API_PATH:
                    self.send_error(501)
                    return
                patient = copy.deepcopy(PATIENT)
                orders = patient['TestMastVMs']
                orders.extend([
                    {**orders[0], 'Tranid': 'CANCELLED', 'Iscancel': True},
                    {**orders[0], 'Tranid': 'OTHER-HOSPITAL', 'Hospitalid': 6},
                    {**orders[0], 'Tranid': 'OTHER-BRANCH', 'Branchid': 2},
                    {**orders[0], 'Tranid': 'OTHER-DATE', 'Adddate': '16/10/2026'},
                    {**orders[0], 'Tranid': 'INVALID\\ID'},
                    copy.deepcopy(orders[0]),
                ])
                if cls.mode == 'conflict':
                    orders.append({**orders[0], 'Treatmentname': 'Conflicting description'})
                payload = [patient]
                if cls.mode == 'shape':
                    payload = {'unexpected': True}
                if cls.mode == 'error':
                    payload = {'error': 'Synthetic upstream failure'}
                body = b'<html>not JSON</html>' if cls.mode == 'json' else json.dumps(payload).encode()
                self.send_response(503 if cls.mode == 'error' else 200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        cls.fixture = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cls.addClassCleanup(cls.fixture.server_close)
        cls.addClassCleanup(cls.fixture.shutdown)
        threading.Thread(target=cls.fixture.serve_forever, daemon=True).start()
        config = configparser.ConfigParser(interpolation=None)
        config.read(source / 'config.txt', encoding='utf-8-sig')
        config.set('krj', 'base_url', 'http://api.krjdiagnostics.com/hmserp/api')
        config.set('krj', 'allow_invalid_tls', 'false')
        config.set('dicom', 'host', '127.0.0.1')
        config.set('ris', 'CR', '{"port": 0}')
        config.set('categories', 'X-RAY', 'CR')
        config.set('categories', 'SYNTHETIC-DX', 'DX')
        cls.ports = {}
        for modality in config['ris']:
            while True:
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0))
                    port = probe.getsockname()[1]
                if port not in cls.ports.values():
                    break
            cls.ports[modality.upper()] = port
            config.set('ris', modality, json.dumps({'port': port}))
        with (cls.folder / 'config.txt').open('w', encoding='utf-8') as stream:
            config.write(stream)
        console = (cls.folder / 'console.log').open('w')
        cls.addClassCleanup(console.close)
        proxy = f'http://127.0.0.1:{cls.fixture.server_port}'
        # This fixture never forwards traffic; requests must go through it.
        env = {**os.environ, 'HTTP_PROXY': proxy, 'http_proxy': proxy,
            'HTTPS_PROXY': proxy, 'https_proxy': proxy, 'NO_PROXY': '', 'no_proxy': ''}
        cls.process = subprocess.Popen([sys.executable, str(cls.folder / 'main.py')],
            cwd=temporary.name, env=env, stdout=console, stderr=subprocess.STDOUT)

        def stop():
            if cls.process.poll() is None:
                cls.process.terminate()
                try:
                    cls.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    cls.process.kill()
                    cls.process.wait(timeout=5)

        cls.addClassCleanup(stop)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise AssertionError((cls.folder / 'console.log').read_text())
            log = cls.read_log()
            if 'app.ready' in log:
                break
            time.sleep(0.05)
        else:
            raise AssertionError('Listeners failed to start: ' + cls.read_log())

    def setUp(self):
        type(self).mode = 'ok'

    @classmethod
    def read_log(cls):
        path = cls.folder / 'krj-worklist.log'
        return path.read_text(encoding='utf-8') if path.exists() else ''

    def associate(self, modality):
        ae = AE(ae_title='SYNTHETIC_TEST')
        ae.add_requested_context(Verification)
        ae.add_requested_context(ModalityWorklistInformationFind)
        assoc = ae.associate('127.0.0.1', self.ports[modality], ae_title='KRJ_MWL')
        self.assertTrue(assoc.is_established)
        return assoc

    def find(self, modality='MR', day=DAY, name='*', query=None, legacy=False):
        assoc = self.associate(modality)
        try:
            if query is None:
                query = Dataset()
                query.PatientName = name
                step = Dataset()
                step.Modality = modality
                step.ScheduledProcedureStepStartDate = day
                step.ScheduledStationAETitle = 'SCANNER_TEST'
                query.ScheduledProcedureStepSequence = [step]
            if legacy:
                # pydicom's normal writer discards group lengths. Preserve them
                # in this test peer to reproduce the actual legacy Fuji wire query.
                with patch('pynetdicom.association.encode', self.encode_legacy_query):
                    replies = list(assoc.send_c_find(query, ModalityWorklistInformationFind))
            else:
                replies = list(assoc.send_c_find(query, ModalityWorklistInformationFind))
            return [s.Status for s, _ in replies], [item for s, item in replies if s.Status == 0xFF00]
        finally:
            assoc.release()

    @staticmethod
    def encode_legacy_query(dataset, implicit, little, deflated=False):
        assert little and not deflated
        stream = DicomBytesIO()
        stream.is_little_endian = little
        stream.is_implicit_VR = implicit
        for element in dataset:
            if element.VR != 'SQ':
                write_data_element(stream, element)
                continue
            content = bytearray()
            for item in element.value:
                encoded = WorklistTests.encode_legacy_query(item, implicit, little)
                content.extend(struct.pack('<HHI', 0xFFFE, 0xE000, len(encoded)))
                content.extend(encoded)
            if implicit:
                stream.write(struct.pack('<HHI', element.tag.group, element.tag.element, len(content)))
            else:
                stream.write(struct.pack('<HH2sHI', element.tag.group, element.tag.element, b'SQ', 0, len(content)))
            stream.write(content)
        return stream.getvalue()

    @staticmethod
    def fuji_query():
        fixture = Path(__file__).resolve().parent / 'fixtures' / 'fuji-worklist-query.json'
        return Dataset.from_json(fixture.read_text(encoding='utf-8'))

    def test_fuji_group_lengths_at_root_and_inside_sequences_return_cr_orders(self):
        query = self.fuji_query()
        statuses, items = self.find('CR', query=query, legacy=True)
        self.assertEqual(statuses, [0xFF00, 0])
        self.assertEqual(str(items[0].AccessionNumber), '0032003')
        self.assertEqual(items[0].ScheduledProcedureStepSequence[0].Modality, 'CR')
        self.assertEqual(items[0].ScheduledProcedureStepSequence[0].ScheduledStationAETitle, 'FCR-CSL')
        self.assertIn('"00080000": {"vr": "UL", "Value": [144]}', self.read_log())

    def test_fuji_nested_group_lengths_alone_do_not_turn_return_sequences_into_filters(self):
        query = self.fuji_query()
        for element in list(query):
            if element.tag.element == 0:
                del query[element.tag]
        self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0xFF00, 0])

    def test_fuji_real_filters_remain_enforced(self):
        for key, value in [('PatientName', 'Other*'), ('PatientID', 'OTHER-PATIENT')]:
            query = self.fuji_query()
            setattr(query, key, value)
            self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0])
        query = self.fuji_query()
        query.ScheduledProcedureStepSequence[0].Modality = 'DX'
        self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0])
        query = self.fuji_query()
        query.ScheduledProcedureStepSequence[0].ScheduledProcedureStepID = 'OTHER-ORDER'
        self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0])
        query = self.fuji_query()
        query.ReferencedStudySequence[0].ReferencedSOPInstanceUID = '1.2.3.4'
        self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0])
        query = self.fuji_query()
        query.PatientComments = 'UNSUPPORTED_MATCHING_VALUE'
        self.assertEqual(self.find('CR', query=query, legacy=True)[0], [0xA900])

    def test_full_payload_logs_preserve_mapping_and_deduplication(self):
        statuses, items = self.find()
        self.assertEqual(statuses, [0xFF00, 0])
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(str(item.AccessionNumber), '0032001')
        self.assertEqual(str(item.PatientID), 'SYNTHETIC-01')
        self.assertEqual(str(item.PatientName), 'Synthetic Patient')
        self.assertEqual(item.PatientAge, '030Y')
        self.assertEqual(item.PatientBirthDate, '19961015')
        self.assertEqual(item.ScheduledProcedureStepSequence[0].ScheduledStationAETitle, 'SCANNER_TEST')
        _, repeated = self.find()
        self.assertEqual(item.StudyInstanceUID, repeated[0].StudyInstanceUID)
        self.assertIn(('api.krjdiagnostics.com', API_PATH), self.calls)
        log = self.read_log()
        for event in ('app.start', 'app.config.loaded', 'worklist.listener.starting', 'app.ready',
                'worklist.query.payload', 'hims.request', 'hims.response.body', 'hims.data_fetched',
                'worklist.patient', 'worklist.treatment', 'worklist.mapping.skipped',
                'worklist.order.duplicate', 'worklist.mapped_payload', 'worklist.response.payload',
                'worklist.query.completed'):
            self.assertIn(event, log)
        for value in ('Synthetic Patient', 'SYNTHETIC-01', 'Full source detail',
                'modality_mismatch', 'hospital_mismatch', 'branch_mismatch', 'cancelled',
                'date_invalid_or_outside_range', 'IDENTITY_INVALID'):
            self.assertIn(value, log)
        payload_lines = [line for line in log.splitlines() if 'worklist.response.payload ' in line]
        line = payload_lines[-1]
        query_id = re.search(r'requestId=([0-9a-f]{32})', line).group(1)
        related = [row for row in log.splitlines() if f'requestId={query_id}' in row]
        self.assertTrue(any('hims.request ' in row for row in related))
        self.assertTrue(any('worklist.patient ' in row for row in related))
        payload = json.loads(line.split(' payload=', 1)[1])
        self.assertEqual(payload['00100020']['Value'], ['SYNTHETIC-01'])
        self.assertEqual(payload['00400100']['Value'][0]['00400001']['Value'], ['SCANNER_TEST'])

    def test_echo_all_modalities_and_ct_result(self):
        for modality in self.ports:
            assoc = self.associate(modality)
            try:
                self.assertEqual(assoc.send_c_echo().Status, 0)
            finally:
                assoc.release()
        statuses, items = self.find('CT')
        self.assertEqual(statuses, [0xFF00, 0])
        self.assertEqual(str(items[0].AccessionNumber), '0032002')
        self.assertIn('dicom.echo', self.read_log())

    def test_all_modalities_return_their_orders_without_crossing_listener_boundaries(self):
        expected = {'CT': {'0032002'}, 'MR': {'0032001'}, 'CR': {'0032003'},
            'US': {'0032004', '0032005'}, 'MG': {'0032006'}, 'DX': {'0032007'}}
        for modality, accessions in expected.items():
            with self.subTest(modality=modality):
                statuses, items = self.find(modality)
                self.assertEqual(statuses, [0xFF00] * len(accessions) + [0])
                self.assertEqual({str(item.AccessionNumber) for item in items}, accessions)
                for item in items:
                    self.assertEqual(str(item.PatientID), 'SYNTHETIC-01')
                    step = item.ScheduledProcedureStepSequence[0]
                    self.assertEqual(step.Modality, modality)
                    self.assertEqual(step.ScheduledProcedureStepStartDate, DAY)
                    self.assertEqual(step.ScheduledStationAETitle, 'SCANNER_TEST')
                self.assertEqual(self.find(modality, name='OTHER-PATIENT*')[0], [0])

    def test_group_length_metadata_remains_compatible_with_every_modality_listener(self):
        for modality, accessions in [('CT', {'0032002'}), ('MR', {'0032001'}),
                ('US', {'0032004', '0032005'}), ('DX', {'0032007'}), ('MG', {'0032006'})]:
            with self.subTest(modality=modality):
                query = self.fuji_query()
                query.ScheduledProcedureStepSequence[0].Modality = modality
                statuses, items = self.find(modality, query=query, legacy=True)
                self.assertEqual(statuses, [0xFF00] * len(accessions) + [0])
                self.assertEqual({str(item.AccessionNumber) for item in items}, accessions)

    @staticmethod
    def siemens_query():
        # Siemens CT query from the reported failure, with a synthetic date.
        fixture = Path(__file__).resolve().parent / 'fixtures' / 'siemens-worklist-query.json'
        return Dataset.from_json(fixture.read_text(encoding='utf-8'))

    def test_siemens_empty_return_sequences_allow_ct_and_mr_orders(self):
        for modality, accession in (('CT', '0032002'), ('MR', '0032001')):
            with self.subTest(modality=modality):
                statuses, items = self.find(modality, query=self.siemens_query())
                self.assertEqual(statuses, [0xFF00, 0])
                self.assertEqual(len(items), 1)
                self.assertEqual(str(items[0].AccessionNumber), accession)
                self.assertEqual(str(items[0].PatientID), 'SYNTHETIC-01')
                self.assertEqual(str(items[0].PatientName), 'Synthetic Patient')

    def test_siemens_query_still_enforces_real_matching_keys(self):
        for key, value in (('PatientID', 'OTHER-PATIENT'), ('PatientName', 'Other*'),
                ('StudyDate', '20261014')):
            with self.subTest(key=key):
                query = self.siemens_query()
                setattr(query, key, value)
                self.assertEqual(self.find('CT', query=query)[0], [0])
        for key, value in (('Modality', 'MR'), ('ScheduledProcedureStepID', 'OTHER-ORDER')):
            with self.subTest(key=key):
                query = self.siemens_query()
                setattr(query.ScheduledProcedureStepSequence[0], key, value)
                self.assertEqual(self.find('CT', query=query)[0], [0])
        query = self.siemens_query()
        query.PatientID = 'SYNTHETIC-01'
        query.ScheduledProcedureStepSequence[0].Modality = 'CT'
        query.ScheduledProcedureStepSequence[0].ScheduledProcedureStepID = '0032002'
        self.assertEqual(self.find('CT', query=query)[0], [0xFF00, 0])

    def test_siemens_populated_optional_sequence_remains_a_filter(self):
        query = self.siemens_query()
        query.ReferencedStudySequence[0].ReferencedSOPInstanceUID = '1.2.3.4'
        self.assertEqual(self.find('CT', query=query)[0], [0])
        query = self.siemens_query()
        query.ScheduledProcedureStepSequence[0].ScheduledProtocolCodeSequence[0].CodeValue = 'KNOWN_CODE'
        self.assertEqual(self.find('CT', query=query)[0], [0])

    def test_siemens_multi_item_query_sequence_is_rejected(self):
        query = self.siemens_query()
        query.ReferencedStudySequence = [Dataset(), Dataset()]
        self.assertEqual(self.find('CT', query=query)[0], [0xA900])

    def test_query_filter_and_invalid_dates(self):
        self.assertEqual(self.find(name='NoMatch')[0], [0])
        self.assertIn('reason=query_mismatch', self.read_log())
        before = len(self.calls)
        self.assertEqual(self.find(day='20261016-20261015')[0], [0xA900])
        self.assertEqual(len(self.calls), before)
        self.assertIn('errorCode=QUERY_INVALID', self.read_log())

    def test_upstream_errors_keep_dicom_failure_status_and_body_logs(self):
        for mode, code in (('error', 'HIMS_HTTP_503'), ('json', 'HIMS_JSON_INVALID'),
                ('shape', 'HIMS_RESPONSE_INVALID'), ('conflict', 'HIMS_ORDER_ID_CONFLICT')):
            with self.subTest(mode=mode):
                type(self).mode = mode
                self.assertEqual(self.find()[0], [0xC000])
                self.assertIn(code, self.read_log())
        self.assertIn('Synthetic upstream failure', self.read_log())
        self.assertIn('<html>not JSON</html>', self.read_log())


if __name__ == '__main__':
    unittest.main()
