import { spawn } from 'node:child_process';

const env = { ...process.env, DEMO_MODE: 'true' };
const children = ['src/mock-main.ts', 'src/server.ts', 'src/worker-main.ts'].map(file => spawn(process.execPath, ['--import', 'tsx', file], { env, stdio: 'inherit', windowsHide: true }));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
for (const child of children) child.on('exit', code => { if (!stopping) { process.exitCode = code || 1; stop(); } });
console.log(`Demo processes starting. API: http://127.0.0.1:${process.env.PORT ?? 3000} ; mock: http://127.0.0.1:${process.env.MOCK_PORT ?? 4001}`);
