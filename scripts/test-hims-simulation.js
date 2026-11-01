'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.join(__dirname, '..');

async function main() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const simulation = spawn('postman', ['simulation', 'run', 'postman/simulations/hims.sim.yaml',
    '--port', String(port), '--output', 'ndjson', '--no-history'], { cwd: root, detached: true });
  const entries = [];
  let buffered = '';
  let ready, fail;
  const started = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
  simulation.stdout.on('data', chunk => {
    buffered += chunk;
    const lines = buffered.split('\n'); buffered = lines.pop();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line); entries.push(entry);
        if ((entry.event || entry.type) === 'listening') ready();
      } catch { /* Ignore CLI notices, not evidence. */ }
    }
  });
  simulation.stderr.on('data', chunk => process.stderr.write(chunk));
  simulation.on('error', fail);
  simulation.on('exit', code => fail(new Error(`HIMS simulation exited (${code})`)));
  const timeout = setTimeout(() => fail(new Error('HIMS simulation did not start within 30 seconds')), 30_000);
  try {
    await started; clearTimeout(timeout);
    const tests = spawn(process.execPath, ['--test', 'test/centers/krj/simulation.test.js'], {
      cwd: root, stdio: 'inherit', env: { ...process.env,
        HIMS_KRJ_SIMULATION_URL: `http://127.0.0.1:${port}/krj_hims/hmserp/api/Patient` },
    });
    const code = await new Promise((resolve, reject) => { tests.on('error', reject); tests.on('exit', resolve); });
    const requests = entries.filter(entry => (entry.event || entry.type) === 'request');
    console.log(`HIMS simulation recorded ${requests.length} HTTP request events.`);
    process.exitCode = code || (requests.length ? 0 : 1);
  } finally {
    clearTimeout(timeout);
    try { process.kill(-simulation.pid, 'SIGINT'); } catch { /* Already exited. */ }
    simulation.stdout.destroy(); simulation.stderr.destroy();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
