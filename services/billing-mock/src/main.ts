import { Database } from '@rounding/platform/db';
import { serviceConfig, listen } from '@rounding/platform/runtime';
import { buildMock } from './app.js';

const cfg = serviceConfig('billing-mock', 4001);
if (!cfg.demo) throw new Error('Billing mock requires DEMO_MODE=true');
const store = new Database(cfg.database); const app = buildMock(store, cfg.billingToken);
await listen(app, cfg, store);
