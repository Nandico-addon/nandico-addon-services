import configparser
import json
import logging
import os
import sys
from contextvars import ContextVar
from logging.handlers import TimedRotatingFileHandler
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT_DIR = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

request_id = ContextVar('worklist_request_id', default='-')


class RequestContextFilter(logging.Filter):
    def filter(self, record):
        record.request_id = request_id.get()
        return True


healer_helper_logger = logging.getLogger('krj.worklist')
healer_helper_logger.setLevel(logging.INFO)
healer_helper_logger.propagate = False
if not healer_helper_logger.handlers:
    formatter = logging.Formatter(
        '%(asctime)s %(levelname)s thread=%(threadName)s requestId=%(request_id)s %(message)s')
    log = TimedRotatingFileHandler(os.path.join(ROOT_DIR, 'krj-worklist.log'),
        when='midnight', backupCount=5, encoding='utf-8')
    handlers = [log]
    # Windows --noconsole executables have no stderr stream.
    if sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    for handler in handlers:
        handler.setFormatter(formatter)
        handler.addFilter(RequestContextFilter())
        healer_helper_logger.addHandler(handler)


def log_payload(event, payload, **details):
    """Write complete JSON on one line, including DICOM sequences and patient data."""
    try:
        value = payload.to_json_dict() if hasattr(payload, 'to_json_dict') else payload
        serialized = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        # Diagnostics must not change the result of a scanner request.
        healer_helper_logger.exception('%s.serialization_failed', event)
        serialized = json.dumps(str(payload), ensure_ascii=False)
    healer_helper_logger.info('%s details=%s payload=%s', event,
        json.dumps(details, ensure_ascii=False, default=str), serialized)


healer_helper_logger.info('app.start pid=%s frozen=%s python=%s root=%s cwd=%s',
    os.getpid(), getattr(sys, 'frozen', False), sys.version.split()[0], ROOT_DIR, os.getcwd())


def load_config():
    configuration = configparser.ConfigParser(interpolation=None)
    path = os.path.join(ROOT_DIR, 'config.txt')
    healer_helper_logger.info('app.config.loading path=%s', path)
    with open(path, encoding='utf-8-sig') as config_file:
        configuration.read_file(config_file)
    return configuration


try:
    config = load_config()
except Exception:
    healer_helper_logger.exception('app.config.failed')
    raise

base_url = config.get('krj', 'base_url').rstrip('/')
url = urlsplit(base_url)
if (url.hostname != 'api.krjdiagnostics.com' or url.scheme not in ('http', 'https')
        or url.path != '/hmserp/api' or url.username or url.password
        or url.query or url.fragment or url.port not in (None, 80, 443)):
    healer_helper_logger.error('app.config.failed errorCode=KRJ_BASE_URL_INVALID')
    raise ValueError('KRJ_BASE_URL_INVALID')
hospital_id = config.get('krj', 'hospital_id')
branch_id = config.get('krj', 'branch_id')
if not hospital_id.isdigit() or not branch_id.isdigit() or int(hospital_id) < 1 or int(branch_id) < 1:
    healer_helper_logger.error('app.config.failed errorCode=KRJ_SCOPE_INVALID')
    raise ValueError('KRJ_SCOPE_INVALID')

worklist_url = (base_url + '/Patient/GetPatientTreatmentDetails'
    + '/hospitalId/' + hospital_id + '/branchId/' + branch_id
    + '/FromDate/{start_date}/ToDate/{end_date}')

# Separate session: no changes to other integrations or global TLS settings.
s = requests.Session()
s.verify = not config.getboolean('krj', 'allow_invalid_tls', fallback=False)
retries = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=['GET'], raise_on_status=False, respect_retry_after_header=False)
s.mount(base_url, HTTPAdapter(max_retries=retries))
s.headers.update({'Accept': 'application/json'})
healer_helper_logger.info(
    'app.config.loaded hospitalId=%s branchId=%s endpoint=%s tlsVerify=%s retries=%s',
    hospital_id, branch_id, worklist_url, s.verify, retries.total)
