import json
import logging
import re
import signal
import threading
from datetime import date, datetime, timedelta

from pydicom.dataset import Dataset
from pydicom.uid import generate_uid
from pynetdicom import AE, evt, _config
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification

from utils.utils import config, healer_helper_logger, s, worklist_url

ris_dict = dict(config.items('ris'))
category_modalities = {key.upper(): value.upper() for key, value in config.items('categories')}
ae_instances = {}
stop_event = threading.Event()


def source_date(value):
    for pattern in ('%d/%m/%Y', '%Y-%m-%d', '%Y%m%d'):
        try:
            return datetime.strptime(str(value or ''), pattern).date()
        except ValueError:
            pass
    return None


def get_date_range(value):
    value = str(value or '').strip()
    if not value:
        return date.today(), date.today()
    first, separator, last = value.partition('-')
    start = source_date(first)
    end = source_date(last) if separator else start
    if separator and not first and end:
        start = end - timedelta(days=30)
    if separator and not last and start:
        end = start + timedelta(days=30)
    if not start or not end or start > end or (end - start).days >= 31:
        raise ValueError('DATE_RANGE_INVALID')
    return start, end


def patient_age(patient):
    for unit in ('Y', 'M', 'W', 'D'):
        match = re.search(r'(\d+)\s*' + unit, str(patient.get('Disp_age') or ''), re.I)
        if match and 0 < int(match[1]) <= 999:
            return f'{int(match[1]):03d}{unit}'
    try:
        age = float(patient.get('Age'))
        if age.is_integer() and 0 <= age <= 999:
            return f'{int(age):03d}Y'
    except (TypeError, ValueError):
        pass
    return ''


def create_worklist_item(patient, treatment, modality, scheduled_date):
    # KRJ order ID is the treatment Tranid, never the parent patient Tranid.
    order_id = treatment.get('Tranid')
    patient_id = patient.get('Patientid')
    for value, limit in ((order_id, 16), (patient_id, 64)):
        if (isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value).strip()
                or len(str(value)) > limit or not str(value).isascii()
                or any(ord(c) < 32 or c == '\\' for c in str(value))):
            raise ValueError('IDENTITY_INVALID')
    order_id = str(order_id)
    description = str(treatment.get('Treatmentname') or '')[:64]
    doctor = str(patient.get('Ref_doctor') or '')[:64]

    item = Dataset()
    item.SpecificCharacterSet = 'ISO_IR 192'
    item.AccessionNumber = order_id
    item.PatientID = str(patient_id)
    item.PatientName = str(patient.get('Name') or '')[:64]
    item.PatientSex = {'MALE': 'M', 'FEMALE': 'F', 'OTHER': 'O', 'M': 'M', 'F': 'F', 'O': 'O'}.get(str(patient.get('Gender') or '').upper(), '')
    item.PatientAge = patient_age(patient)
    birth_date = source_date(patient.get('Birthdate'))
    item.PatientBirthDate = birth_date.strftime('%Y%m%d') if birth_date else ''
    item.ReferringPhysicianName = doctor
    item.RequestingPhysician = doctor
    item.StudyInstanceUID = generate_uid(entropy_srcs=[
        'krj-worklist-v1', config.get('krj', 'hospital_id'), config.get('krj', 'branch_id'), order_id
    ])
    item.StudyID = order_id
    item.StudyDate = scheduled_date.strftime('%Y%m%d')
    item.StudyDescription = description
    item.RequestedProcedureID = order_id
    item.RequestedProcedureDescription = description

    step = Dataset()
    step.Modality = modality.upper()
    step.ScheduledStationAETitle = ''
    step.ScheduledProcedureStepID = order_id
    step.ScheduledProcedureStepStartDate = scheduled_date.strftime('%Y%m%d')
    step.ScheduledProcedureStepStartTime = ''
    for pattern in ('%H:%M:%S', '%H:%M', '%I:%M %p', '%H%M%S'):
        try:
            step.ScheduledProcedureStepStartTime = datetime.strptime(str(treatment.get('Addtime') or ''), pattern).strftime('%H%M%S')
            break
        except ValueError:
            pass
    step.ScheduledProcedureStepDescription = description
    step.ScheduledPerformingPhysicianName = doctor
    item.ScheduledProcedureStepSequence = [step]
    return item


def fetch_worklist(start_date, end_date, modality):
    url = worklist_url.format(start_date=start_date.isoformat(), end_date=end_date.isoformat())
    timeout = config.getfloat('krj', 'timeout_seconds', fallback=20)
    try:
        with s.get(url, timeout=timeout, allow_redirects=False) as response:
            if response.status_code != 200:
                raise RuntimeError(f'HIMS_HTTP_{response.status_code}')
            try:
                patients = response.json()
            except ValueError:
                raise RuntimeError('HIMS_JSON_INVALID') from None
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('HIMS_CONNECTION_FAILED') from None

    if not isinstance(patients, list):
        raise RuntimeError('HIMS_RESPONSE_INVALID')
    items, seen, skipped = [], {}, 0
    for patient in patients:
        if not isinstance(patient, dict) or not isinstance(patient.get('TestMastVMs'), list):
            raise RuntimeError('HIMS_RESPONSE_INVALID')
        for treatment in patient['TestMastVMs']:
            if not isinstance(treatment, dict):
                raise RuntimeError('HIMS_RESPONSE_INVALID')
            scheduled = source_date(treatment.get('Adddate'))
            if (str(treatment.get('Hospitalid')) != config.get('krj', 'hospital_id')
                    or str(treatment.get('Branchid')) != config.get('krj', 'branch_id')
                    or str(treatment.get('Iscancel') or '').lower() not in ('', 'false', '0', 'n', 'no')
                    or category_modalities.get(str(treatment.get('Categoryname') or '').strip().upper()) != modality.upper()
                    or not scheduled or not start_date <= scheduled <= end_date):
                continue
            try:
                item = create_worklist_item(patient, treatment, modality, scheduled)
            except ValueError:
                skipped += 1
                continue
            order_id = str(item.AccessionNumber)
            if order_id in seen:
                if seen[order_id] != item:
                    raise RuntimeError('HIMS_ORDER_ID_CONFLICT')
                continue
            seen[order_id] = item
            items.append(item)
    healer_helper_logger.info('worklist.fetched modality=%s from=%s to=%s patients=%d orders=%d skipped=%d',
        modality, start_date, end_date, len(patients), len(items), skipped)
    return items


def matches_query(query, item):
    for element in query:
        if element.tag.is_private or element.keyword in ('SpecificCharacterSet', 'QueryRetrieveLevel'):
            continue
        if element.VR == 'SQ':
            if not element.value:
                continue
            if len(element.value) != 1:
                raise ValueError('QUERY_UNSUPPORTED')
            sequence = item.get(element.keyword, [])
            if not sequence or not matches_query(element.value[0], sequence[0]):
                return False
        elif element.value not in (None, '', b''):
            if element.keyword not in item:
                raise ValueError('QUERY_UNSUPPORTED')
            actual, pattern = str(item.get(element.keyword, '')), str(element.value)
            if element.VR in ('DA', 'TM') and '-' in pattern:
                low, high = pattern.split('-', 1)
                if not actual or (low and actual < low) or (high and actual > high):
                    return False
            else:
                pattern = ''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in pattern)
                if not re.fullmatch(pattern, actual, re.I):
                    return False
    return True


def create_worklist_server(modality, port):
    def on_c_find(event):
        try:
            query = event.identifier
            sequence = query.get('ScheduledProcedureStepSequence', [])
            if len(sequence) > 1:
                raise ValueError('QUERY_UNSUPPORTED')
            step = sequence[0] if sequence else Dataset()
            start_date, end_date = get_date_range(step.get('ScheduledProcedureStepStartDate', ''))
            results = []
            for item in fetch_worklist(start_date, end_date, modality):
                if event.is_cancelled:
                    yield 0xFE00, None
                    return
                station = str(step.get('ScheduledStationAETitle', ''))
                if '*' not in station and '?' not in station:
                    item.ScheduledProcedureStepSequence[0].ScheduledStationAETitle = station
                if matches_query(query, item):
                    results.append(item)
            for item in results:
                if event.is_cancelled:
                    yield 0xFE00, None
                    return
                yield 0xFF00, item
            yield 0x0000, None
        except ValueError:
            healer_helper_logger.error('worklist.failed modality=%s errorCode=QUERY_INVALID', modality)
            yield 0xA900, None
        except RuntimeError as error:
            healer_helper_logger.error('worklist.failed modality=%s errorCode=%s', modality, error)
            yield 0xC000, None
        except Exception:
            healer_helper_logger.error('worklist.failed modality=%s errorCode=WORKLIST_FAILED', modality)
            yield 0xC000, None

    ae = AE(ae_title=config.get('dicom', 'ae_title', fallback='KRJ_MWL'))
    ae.require_called_aet = True
    ae.add_supported_context(Verification)
    ae.add_supported_context(ModalityWorklistInformationFind)
    server = ae.start_server((config.get('dicom', 'host', fallback='0.0.0.0'), int(port)),
        evt_handlers=[(evt.EVT_C_FIND, on_c_find)], block=False)
    ae_instances[modality] = server
    healer_helper_logger.info('worklist.listening modality=%s port=%s ae=%s', modality, port, ae.ae_title)
    return server


def OnExitApp(*args):
    stop_event.set()


def main():
    signal.signal(signal.SIGINT, OnExitApp)
    signal.signal(signal.SIGTERM, OnExitApp)
    try:
        for modality, value in ris_dict.items():
            create_worklist_server(modality.upper(), json.loads(value)['port'])
        stop_event.wait()
    finally:
        for server in ae_instances.values():
            for association in server.active_associations:
                association.abort()
            server.shutdown()
            server.server_close()
        ae_instances.clear()


if __name__ == '__main__':
    # Disable library dataset dumps; our logger records only counts/error codes.
    _config.LOG_REQUEST_IDENTIFIERS = False
    _config.LOG_RESPONSE_IDENTIFIERS = False
    for name in ('pynetdicom', 'pydicom'):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.addHandler(logging.NullHandler())
        logger.propagate = False
    try:
        main()
    except Exception:
        healer_helper_logger.error('worklist.stopped errorCode=STARTUP_FAILED')
        raise SystemExit(1)
