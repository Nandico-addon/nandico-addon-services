'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.join(__dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const simulation = spawn('postman', ['simulation', 'run', 'postman/simulations/msgclub.sim.yaml',
    '--port', String(port), '--output', 'ndjson', '--no-history'], { cwd: root, detached: true });
  const lines = [];
  let buffered = '';
  let ready;
  let rejectReady;
  const started = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
  simulation.stdout.on('data', chunk => {
    buffered += chunk;
    const rows = buffered.split('\n'); buffered = rows.pop();
    for (const row of rows) {
      try {
        const entry = JSON.parse(row);
        lines.push(entry);
        if (entry.event === 'listening' || entry.type === 'listening') ready();
      } catch { /* CLI notices are not request evidence. */ }
    }
  });
  simulation.stderr.on('data', chunk => process.stderr.write(chunk));
  simulation.on('error', rejectReady);
  simulation.on('exit', code => rejectReady(new Error(`Postman simulation exited before readiness (${code})`)));
  const timeout = setTimeout(() => rejectReady(new Error('Postman simulation did not start within 30 seconds')), 30_000);
  try {
    await started;
    clearTimeout(timeout);
    const tests = spawn(process.execPath, ['--test', 'test/msgclub-simulation.test.js'], {
      cwd: root, stdio: 'inherit', env: { ...process.env,
        ICLOUDSMS_SIMULATION_URL: `http://127.0.0.1:${port}/icloudsms/rest/services/sendSMS/v2/sendtemplate` },
    });
    const code = await new Promise((resolve, reject) => { tests.on('error', reject); tests.on('exit', resolve); });
    const requests = lines.filter(entry => entry.event === 'request' || entry.type === 'request');
    console.log(`Postman simulation recorded ${requests.length} HTTP request events.`);
    process.exitCode = code || (requests.length ? 0 : 1);
  } finally {
    clearTimeout(timeout);
    // Signal the process group: the Postman launcher alone does not stop its mock children.
    try { process.kill(-simulation.pid, 'SIGINT'); } catch { /* Already exited. */ }
    simulation.stdout.destroy(); simulation.stderr.destroy();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
