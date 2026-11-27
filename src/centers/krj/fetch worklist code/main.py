import json
import logging
import re
import signal
import threading
from time import monotonic
from uuid import uuid4
from datetime import date, datetime, timedelta

from pydicom.dataset import Dataset
from pydicom.uid import generate_uid
from pynetdicom import AE, evt, _config
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification

from utils.utils import config, healer_helper_logger, log_payload, request_id, s, worklist_url

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
    started = monotonic()
    url = worklist_url.format(start_date=start_date.isoformat(), end_date=end_date.isoformat())
    timeout = config.getfloat('krj', 'timeout_seconds', fallback=20)
    log_payload('hims.request', {'method': 'GET', 'url': url, 'body': None},
        modality=modality, timeout_seconds=timeout)
    try:
        with s.get(url, timeout=timeout, allow_redirects=False) as response:
            healer_helper_logger.info('hims.response status=%s elapsedMs=%.1f',
                response.status_code, (monotonic() - started) * 1000)
            log_payload('hims.response.body', response.text)
            if response.status_code != 200:
                raise RuntimeError(f'HIMS_HTTP_{response.status_code}')
            try:
                patients = response.json()
            except ValueError:
                raise RuntimeError('HIMS_JSON_INVALID') from None
    except RuntimeError:
        healer_helper_logger.exception('hims.fetch.failed modality=%s', modality)
        raise
    except Exception:
        healer_helper_logger.exception('hims.fetch.failed modality=%s errorCode=HIMS_CONNECTION_FAILED', modality)
        raise RuntimeError('HIMS_CONNECTION_FAILED') from None

    if not isinstance(patients, list):
        healer_helper_logger.error('hims.validation.failed reason=patients_not_list')
        raise RuntimeError('HIMS_RESPONSE_INVALID')
    healer_helper_logger.info('hims.data_fetched patients=%d modality=%s', len(patients), modality)
    items, seen, skipped = [], {}, 0
    for patient_index, patient in enumerate(patients):
        log_payload('worklist.patient', patient, patient_index=patient_index)
        if not isinstance(patient, dict) or not isinstance(patient.get('TestMastVMs'), list):
            healer_helper_logger.error('hims.validation.failed patientIndex=%s reason=patient_or_treatments_invalid', patient_index)
            raise RuntimeError('HIMS_RESPONSE_INVALID')
        for treatment_index, treatment in enumerate(patient['TestMastVMs']):
            log_payload('worklist.treatment', treatment,
                patient_index=patient_index, treatment_index=treatment_index)
            if not isinstance(treatment, dict):
                healer_helper_logger.error('hims.validation.failed patientIndex=%s treatmentIndex=%s reason=treatment_invalid',
                    patient_index, treatment_index)
                raise RuntimeError('HIMS_RESPONSE_INVALID')
            scheduled = source_date(treatment.get('Adddate'))
            reasons = []
            if str(treatment.get('Hospitalid')) != config.get('krj', 'hospital_id'):
                reasons.append('hospital_mismatch')
            if str(treatment.get('Branchid')) != config.get('krj', 'branch_id'):
                reasons.append('branch_mismatch')
            if str(treatment.get('Iscancel') or '').lower() not in ('', 'false', '0', 'n', 'no'):
                reasons.append('cancelled')
            if category_modalities.get(str(treatment.get('Categoryname') or '').strip().upper()) != modality.upper():
                reasons.append('modality_mismatch')
            if not scheduled or not start_date <= scheduled <= end_date:
                reasons.append('date_invalid_or_outside_range')
            if reasons:
                healer_helper_logger.info('worklist.treatment.filtered patientIndex=%s treatmentIndex=%s orderId=%s reasons=%s',
                    patient_index, treatment_index, treatment.get('Tranid'), ','.join(reasons))
                continue
            healer_helper_logger.info('worklist.mapping.start patientIndex=%s treatmentIndex=%s orderId=%s',
                patient_index, treatment_index, treatment.get('Tranid'))
            try:
                item = create_worklist_item(patient, treatment, modality, scheduled)
            except ValueError as error:
                skipped += 1
                healer_helper_logger.warning('worklist.mapping.skipped patientIndex=%s treatmentIndex=%s errorCode=%s',
                    patient_index, treatment_index, error)
                continue
            log_payload('worklist.mapped_payload', item)
            order_id = str(item.AccessionNumber)
            if order_id in seen:
                if seen[order_id] != item:
                    healer_helper_logger.error('worklist.order.conflict orderId=%s', order_id)
                    raise RuntimeError('HIMS_ORDER_ID_CONFLICT')
                healer_helper_logger.info('worklist.order.duplicate orderId=%s', order_id)
                continue
            seen[order_id] = item
            items.append(item)
            healer_helper_logger.info('worklist.order.accepted orderId=%s patientId=%s', order_id, item.PatientID)
    healer_helper_logger.info('worklist.fetched modality=%s from=%s to=%s patients=%d orders=%d skipped=%d',
        modality, start_date, end_date, len(patients), len(items), skipped)
    return items


def has_matching_keys(query):
    """Empty return keys, including nested sequences, do not restrict results."""
    for element in query:
        # Legacy Fuji queries include retired (gggg,0000) group lengths. These
        # describe encoding, not search criteria, including inside sequences.
        if element.tag.element == 0x0000 or element.tag.is_private or element.keyword in ('SpecificCharacterSet', 'QueryRetrieveLevel'):
            continue
        if element.VR == 'SQ':
            if len(element.value) > 1:
                raise ValueError('QUERY_UNSUPPORTED')
            if element.value and has_matching_keys(element.value[0]):
                return True
        elif element.value not in (None, '', b''):
            return True
    return False


def matches_query(query, item):
    for element in query:
        if element.tag.element == 0x0000 or element.tag.is_private or element.keyword in ('SpecificCharacterSet', 'QueryRetrieveLevel'):
            continue
        if element.VR == 'SQ':
            if not element.value:
                continue
            if len(element.value) != 1:
                raise ValueError('QUERY_UNSUPPORTED')
            # Siemens requests optional sequences with empty child return keys.
            # A missing response sequence only excludes an order when the query
            # actually contains a matching value inside that sequence.
            if not has_matching_keys(element.value[0]):
                continue
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
        token = request_id.set(uuid4().hex)
        started = monotonic()
        sent = 0
        try:
            healer_helper_logger.info('worklist.query.received modality=%s port=%s', modality, port)
            query = event.identifier
            log_payload('worklist.query.payload', query)
            sequence = query.get('ScheduledProcedureStepSequence', [])
            if len(sequence) > 1:
                raise ValueError('QUERY_UNSUPPORTED')
            step = sequence[0] if sequence else Dataset()
            start_date, end_date = get_date_range(step.get('ScheduledProcedureStepStartDate', ''))
            healer_helper_logger.info('worklist.query.dates from=%s to=%s', start_date, end_date)
            results = []
            for item in fetch_worklist(start_date, end_date, modality):
                if event.is_cancelled:
                    healer_helper_logger.info('worklist.query.cancelled sent=%s status=0xFE00', sent)
                    yield 0xFE00, None
                    return
                station = str(step.get('ScheduledStationAETitle', ''))
                if '*' not in station and '?' not in station:
                    item.ScheduledProcedureStepSequence[0].ScheduledStationAETitle = station
                if matches_query(query, item):
                    results.append(item)
                    healer_helper_logger.info('worklist.query.matched orderId=%s', item.AccessionNumber)
                else:
                    healer_helper_logger.info('worklist.query.filtered orderId=%s reason=query_mismatch', item.AccessionNumber)
            healer_helper_logger.info('worklist.query.results count=%d', len(results))
            for item in results:
                if event.is_cancelled:
                    healer_helper_logger.info('worklist.query.cancelled sent=%s status=0xFE00', sent)
                    yield 0xFE00, None
                    return
                log_payload('worklist.response.payload', item, status='0xFF00', index=sent)
                sent += 1
                yield 0xFF00, item
            healer_helper_logger.info('worklist.query.completed sent=%s status=0x0000 elapsedMs=%.1f',
                sent, (monotonic() - started) * 1000)
            yield 0x0000, None
        except ValueError:
            healer_helper_logger.exception('worklist.failed modality=%s errorCode=QUERY_INVALID status=0xA900', modality)
            yield 0xA900, None
        except RuntimeError as error:
            healer_helper_logger.exception('worklist.failed modality=%s errorCode=%s status=0xC000', modality, error)
            yield 0xC000, None
        except Exception:
            healer_helper_logger.exception('worklist.failed modality=%s errorCode=WORKLIST_FAILED status=0xC000', modality)
            yield 0xC000, None
        finally:
            healer_helper_logger.info('worklist.query.finished sent=%s elapsedMs=%.1f', sent, (monotonic() - started) * 1000)
            request_id.reset(token)

    def on_connection(event):
        peer = event.assoc.requestor
        healer_helper_logger.info('dicom.association event=%s modality=%s peer=%s:%s ae=%s',
            event.event.name, modality, peer.address, peer.port, peer.ae_title)

    def on_echo(event):
        healer_helper_logger.info('dicom.echo modality=%s status=0x0000', modality)
        return 0x0000

    ae = AE(ae_title=config.get('dicom', 'ae_title', fallback='KRJ_MWL'))
    ae.require_called_aet = True
    ae.add_supported_context(Verification)
    ae.add_supported_context(ModalityWorklistInformationFind)
    healer_helper_logger.info('worklist.listener.starting modality=%s host=%s port=%s ae=%s',
        modality, config.get('dicom', 'host', fallback='0.0.0.0'), port, ae.ae_title)
    try:
        server = ae.start_server((config.get('dicom', 'host', fallback='0.0.0.0'), int(port)),
            evt_handlers=[(evt.EVT_C_FIND, on_c_find), (evt.EVT_C_ECHO, on_echo),
                *[(event_type, on_connection) for event_type in (
                    evt.EVT_ACCEPTED, evt.EVT_REJECTED, evt.EVT_RELEASED, evt.EVT_ABORTED)]], block=False)
    except OSError as error:
        healer_helper_logger.error('worklist.listen_failed modality=%s port=%s osError=%s',
            modality, port, getattr(error, 'winerror', None) or error.errno)
        raise
    ae_instances[modality] = server
    healer_helper_logger.info('worklist.listening modality=%s port=%s ae=%s', modality, port, ae.ae_title)
    return server


def OnExitApp(*args):
    healer_helper_logger.info('app.stop_requested signal=%s', args[0] if args else 'manual')
    stop_event.set()


def main():
    signal.signal(signal.SIGINT, OnExitApp)
    signal.signal(signal.SIGTERM, OnExitApp)
    try:
        log_payload('app.listeners.configuration', ris_dict)
        log_payload('app.categories.configuration', category_modalities)
        for modality, value in ris_dict.items():
            create_worklist_server(modality.upper(), json.loads(value)['port'])
        healer_helper_logger.info('app.ready listeners=%d waiting_for_scanner_queries=true', len(ae_instances))
        stop_event.wait()
    finally:
        healer_helper_logger.info('app.stopping listeners=%d', len(ae_instances))
        for modality, server in ae_instances.items():
            healer_helper_logger.info('worklist.listener.stopping modality=%s', modality)
            for association in server.active_associations:
                association.abort()
            server.shutdown()
            server.server_close()
            healer_helper_logger.info('worklist.listener.stopped modality=%s', modality)
        ae_instances.clear()
        s.close()
        healer_helper_logger.info('app.stopped')


if __name__ == '__main__':
    # Our correlated logger records full payloads without duplicate library dumps.
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
        healer_helper_logger.exception('worklist.stopped errorCode=STARTUP_FAILED')
        raise SystemExit(1)
