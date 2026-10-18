'use strict';

// Based on examples/msgclub.postman_collection.json and the account's Ready JSON.
// Diagnostic routes and simulation-* keys below are local test controls, not MsgClub APIs.
const http = require('node:http');
const templates = {
  report_ready_message: [4, false], clinician_signoff_message: [5, false],
  patient_scan_done_report_created_info: [5, false], new_clinician_message: [4, false],
  new_patient_message: [4, false], ramsnehi_chatbot: [0, false], chating: [0, false],
  pathology_report: [0, true], office: [0, true], testing_template: [1, true],
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const answer = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/__requests') {
    return answer(200, await pm.state.get('icloudsms:requests') || []);
  }
  if (req.method !== 'POST' || url.pathname !== '/rest/services/sendSMS/v2/sendtemplate') {
    return answer(501, { error: 'Endpoint outside this simulation contract' });
  }
  const body = req.body;
  const component = body?.component;
  const template = component?.template;
  const shape = templates[template?.name];
  const parts = template?.components || [];
  const parameters = parts.find(part => part.type === 'body')?.parameters || [];
  const document = parts.find(part => part.type === 'header')?.parameters?.[0]?.document;
  if (!shape || !/^91[6-9][0-9]{9}$/.test(body.mobileNumbers) || body.mobileNumbers !== component.to ||
      body.senderId !== '919828298283' || component.messaging_product !== 'whatsapp' ||
      component.recipient_type !== 'individual' || component.type !== 'template' || template.language?.code !== 'en' ||
      parameters.length !== shape[0] || parameters.some(p => p.type !== 'text' || typeof p.text !== 'string' || !p.text.trim()) ||
      Boolean(document) !== shape[1] || (document && !/^https?:\/\//.test(document.link)) ||
      !String(req.headers['content-type']).startsWith('application/json')) {
    return answer(400, { error: 'Request does not match the captured provider contract' });
  }
  const key = url.searchParams.get('AUTH_KEY');
  if (!key?.startsWith('simulation-')) return answer(401, { error: 'Use fake simulation credentials' });
  const calls = await pm.state.get('icloudsms:requests') || [];
  const id = 'simulated-' + (calls.length + 1);
  calls.push({ id, body });
  await pm.state.set('icloudsms:requests', calls);
  if (key === 'simulation-rate-limit') return answer(429, { error: 'Injected rate limit' });
  if (key === 'simulation-server-error') return answer(500, { error: 'Injected server error' });
  if (key === 'simulation-rejected') return answer(200, { responseCode: 'SIMULATED_REJECTION', response: 'Rejected' });
  if (key === 'simulation-unknown') return answer(200, { status: 'unknown' });
  return answer(200, { responseCode: '3001', response: id });
}).listen(process.env.PORT || 4500);
