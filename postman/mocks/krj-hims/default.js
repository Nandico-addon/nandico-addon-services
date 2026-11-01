'use strict';

// JSON fields come from the vendor's 2026-10-27 message. Multipart fields
// come from HIMS_Integration_APIs.pdf. All IDs and failure controls are synthetic.
const http = require('node:http');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const answer = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/__requests') return answer(200, await pm.state.get('krj-hims:requests') || []);
  if (req.method !== 'POST' || !['/hmserp/api/Patient/mark-uploaded', '/hmserp/api/Patient/send-report'].includes(url.pathname)) {
    return answer(501, { error: 'Endpoint outside the documented integration' });
  }
  let orderId;
  let detail;
  if (url.pathname.endsWith('/mark-uploaded')) {
    const body = req.body;
    if (!String(req.headers['content-type']).startsWith('application/json') ||
        typeof body?.OrderId !== 'string' || !body.OrderId || typeof body.ZipFilePath !== 'string' || !body.ZipFilePath) {
      return answer(400, { error: 'Expected OrderId and ZipFilePath JSON fields' });
    }
    orderId = body.OrderId;
    detail = { body };
  } else {
    const type = req.headers['content-type'];
    if (!String(type).startsWith('multipart/form-data; boundary=')) return answer(400, { error: 'Expected multipart form' });
    // The local interceptor exposes the multipart body as a string/buffer.
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    try {
      const form = await new Response(raw, { headers: { 'Content-Type': type } }).formData();
      orderId = form.get('orderId');
      const file = form.get('multipartFile');
      if (typeof orderId !== 'string' || !orderId || !file || typeof file.arrayBuffer !== 'function' || file.type !== 'application/pdf') throw new Error();
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error();
      detail = { fieldNames: [...form.keys()], fileType: file.type, fileSize: bytes.length, pdfHeader: '%PDF-' };
    } catch { return answer(400, { error: 'Expected orderId text and multipartFile PDF bytes' }); }
  }
  const calls = await pm.state.get('krj-hims:requests') || [];
  calls.push({ path: url.pathname, orderId, ...detail });
  await pm.state.set('krj-hims:requests', calls);
  if (orderId === 'SIM-429') return answer(429, { error: 'Injected rate limit' });
  if (orderId === 'SIM-500') return answer(500, { error: 'Injected uncertain failure' });
  if (orderId === 'SIM-400') return answer(400, { error: 'Injected permanent rejection' });
  if (orderId === 'SIM-HTML') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Login required</html>'); }
  return answer(200);
}).listen(process.env.PORT || 4501);
