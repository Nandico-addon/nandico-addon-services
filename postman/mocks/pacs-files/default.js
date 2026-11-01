'use strict';

const http = require('node:http');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const paths = await pm.state.get('pacs-files:requests') || [];
  paths.push(url.pathname);
  await pm.state.set('pacs-files:requests', paths);
  if (req.method !== 'GET') { res.writeHead(501); return res.end(); }
  if (url.pathname === '/not-ready.pdf') { res.writeHead(404); return res.end(); }
  if (url.pathname === '/not-pdf') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Login required</html>'); }
  if (url.pathname === '/too-large.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '99999999' }); return res.end('%PDF-1.4');
  }
  if (url.pathname === '/redirect.pdf') { res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); return res.end(); }
  if (url.pathname === '/report.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end('%PDF-1.4\n% synthetic test fixture\n%%EOF\n');
  }
  res.writeHead(501); res.end();
}).listen(process.env.PORT || 4502);
