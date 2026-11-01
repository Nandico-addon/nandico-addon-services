import configparser
import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT_DIR = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

config = configparser.ConfigParser(interpolation=None)
with open(os.path.join(ROOT_DIR, 'config.txt'), encoding='utf-8-sig') as config_file:
    config.read_file(config_file)

base_url = config.get('krj', 'base_url').rstrip('/')
url = urlsplit(base_url)
if (url.hostname != 'api.krjdiagnostics.com' or url.scheme not in ('http', 'https')
        or url.path != '/hmserp/api' or url.username or url.password
        or url.query or url.fragment or url.port not in (None, 80, 443)):
    raise ValueError('KRJ_BASE_URL_INVALID')
hospital_id = config.get('krj', 'hospital_id')
branch_id = config.get('krj', 'branch_id')
if not hospital_id.isdigit() or not branch_id.isdigit() or int(hospital_id) < 1 or int(branch_id) < 1:
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

healer_helper_logger = logging.getLogger('krj.worklist')
healer_helper_logger.setLevel(logging.INFO)
healer_helper_logger.propagate = False
if not healer_helper_logger.handlers:
    formatter = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    log = TimedRotatingFileHandler(os.path.join(ROOT_DIR, 'krj-worklist.log'),
        when='midnight', backupCount=5, encoding='utf-8')
    console = logging.StreamHandler()
    for handler in (log, console):
        handler.setFormatter(formatter)
        healer_helper_logger.addHandler(handler)
