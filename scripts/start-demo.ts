import { spawn } from 'node:child_process';

const env = { ...process.env, DEMO_MODE: 'true' };
const children = ['billing-mock', 'patient-service', 'billing-service', 'charge-service', 'gateway'].map(name => spawn(process.execPath, [`services/${name}/dist/main.js`], { env, stdio: 'inherit', windowsHide: true }));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
for (const child of children) child.on('exit', code => { if (!stopping) { process.exitCode = code || 1; stop(); } });
console.log('Microservices starting. Swagger: http://127.0.0.1:3002/docs/ ; patient:3101 charge:3102 billing:3103 mock:4001');
