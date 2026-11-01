'use strict';

const http = require('node:http');
const https = require('node:https');
const { ProviderError } = require('../../shared/utils/errors');
const { himsOrderId, himsZipFilePath, buildMarkUploadedPayload, buildReportForm } = require('./payload');

const BASE_URL = 'https://api.krjdiagnostics.com/hmserp/api/Patient';

class KrjHimsProvider {
  constructor(config) { this.config = config; }

  endpoint(action) {
    const suffix = action === 'mark_uploaded' ? '/mark-uploaded' : action === 'send_report' ? '/send-report' : null;
    if (!suffix) throw new ProviderError('HIMS_ACTION_INVALID');
    const override = this.config.providerEnv.HIMS_KRJ_SIMULATION_URL;
    if (!override) return new URL(BASE_URL + suffix);
    try {
      const url = new URL(override);
      if (this.config.production || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
          !url.port || url.pathname !== '/krj_hims/hmserp/api/Patient' || url.username || url.password || url.search || url.hash) throw new Error();
      return new URL(override + suffix);
    } catch { throw new ProviderError('HIMS_SIMULATION_URL_INVALID'); }
  }

  isConfigured(group, eventType) {
    try {
      this.endpoint(eventType === 'SIGNOFF' ? 'send_report' : 'mark_uploaded');
      return !(this.config.production && group.groupId === 0) && group.jobMode === 'hims' && group.events.includes(eventType) &&
        (eventType !== 'SIGNOFF' || Boolean(this.config.providerEnv.HIMS_KRJ_REPORT_HOSTS));
    } catch { return false; }
  }

  reportUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new ProviderError('HIMS_REPORT_URL_INVALID'); }
    if (url.username || url.password || url.hash) throw new ProviderError('HIMS_REPORT_URL_INVALID');
    const simulation = this.config.providerEnv.HIMS_KRJ_SIMULATION_URL;
    if (simulation && !this.config.production) {
      const base = this.endpoint('send_report');
      if (url.origin === base.origin && url.pathname.startsWith('/pacs/')) return url;
    }
    const hosts = String(this.config.providerEnv.HIMS_KRJ_REPORT_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !hosts.includes(url.hostname.toLowerCase())) {
      throw new ProviderError('HIMS_REPORT_HOST_NOT_ALLOWED');
    }
    return url;
  }

  async downloadPdf(value) {
    const url = this.reportUrl(value);
    const maximum = this.config.himsMaxPdfBytes || 20 * 1024 * 1024;
    let response;
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(this.config.providerTimeoutMs) });
    } catch { throw new ProviderError('HIMS_REPORT_FETCH_FAILED', { retryable: true }); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`HIMS_REPORT_HTTP_${response.status}`, {
        retryable: [404, 408, 429].includes(response.status) || response.status >= 500,
      });
    }
    if (Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel();
      throw new ProviderError('HIMS_REPORT_TOO_LARGE');
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > maximum) throw new ProviderError('HIMS_REPORT_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('HIMS_REPORT_FETCH_FAILED', { retryable: true });
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new ProviderError('HIMS_REPORT_NOT_PDF');
    return bytes;
  }

  async post(action, body, contentType) {
    const url = this.endpoint(action);
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: 'POST', signal: AbortSignal.timeout(this.config.providerTimeoutMs),
        // A temporary exception is restricted to this fixed HIMS host. PACS
        // downloads and every other integration always retain TLS validation.
        rejectUnauthorized: this.config.providerEnv.HIMS_KRJ_ALLOW_INVALID_TLS !== 'true',
        headers: { 'Content-Type': contentType, 'Content-Length': body.length, Accept: 'application/json' },
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 65536) {
            reject(new ProviderError('HIMS_ACK_TOO_LARGE', { ambiguous: true })); res.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve({ code: res.statusCode, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => reject(new ProviderError('HIMS_ACK_UNKNOWN', { ambiguous: true })));
      });
      request.on('error', error => {
        const certificate = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code);
        reject(new ProviderError(certificate ? 'HIMS_TLS_CERTIFICATE' : 'HIMS_CONNECTION_UNKNOWN', { ambiguous: !certificate }));
      });
      request.end(body);
    });
    if (response.code < 200 || response.code >= 300) {
      throw new ProviderError(`HIMS_HTTP_${response.code}`, {
        retryable: response.code === 429, ambiguous: response.code === 408 || response.code >= 500,
      });
    }
    if (response.body.trim()) {
      // The PDF specifies an empty 200 response. Do not treat a login/error
      // page or an explicit JSON rejection as a successful acknowledgement.
      let acknowledgement;
      try { acknowledgement = JSON.parse(response.body); }
      catch { throw new ProviderError('HIMS_ACK_UNKNOWN', { ambiguous: true }); }
      if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
        throw new ProviderError('HIMS_ACK_UNKNOWN', { ambiguous: true });
      }
      if (acknowledgement.success === false || acknowledgement.status === false || acknowledgement.error || acknowledgement.IsSuccess === false) {
        throw new ProviderError('HIMS_REJECTED');
      }
      if (acknowledgement.success !== true && acknowledgement.IsSuccess !== true) throw new ProviderError('HIMS_ACK_UNKNOWN', { ambiguous: true });
    }
    return { status: 'accepted' };
  }

  async send(job) {
    // Queued local placeholder jobs must not become production writes simply
    // because a later process starts with different environment settings.
    if (this.config.production && job.group.groupId === 0) throw new ProviderError('HIMS_PLACEHOLDER_GROUP', { requiresReview: true });
    if (!this.isConfigured(job.group, job.event.type)) throw new ProviderError('HIMS_NOT_CONFIGURED');
    const orderId = himsOrderId(job.event);
    if (job.action === 'mark_uploaded') {
      const zip = himsZipFilePath(job.event, job.group);
      return this.post(job.action, Buffer.from(JSON.stringify(buildMarkUploadedPayload(orderId, zip))), 'application/json');
    }
    if (job.action !== 'send_report') throw new ProviderError('HIMS_ACTION_INVALID');
    if (!job.event.payload.hasReport || !job.event.payload.reportPdfLink) {
      throw new ProviderError('HIMS_REPORT_REQUIRED', { requiresReview: true });
    }
    const bytes = await this.downloadPdf(job.event.payload.reportPdfLink);
    const form = buildReportForm(orderId, bytes);
    const encoded = new Request(this.endpoint(job.action), { method: 'POST', body: form });
    return this.post(job.action, Buffer.from(await encoded.arrayBuffer()), encoded.headers.get('content-type'));
  }
}

module.exports = { KrjHimsProvider };
