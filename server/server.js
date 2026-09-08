/**
 * Local entrypoint. All routes live in app.js so the same Express app can be
 * mounted as a Vercel serverless function (see /api/index.js at the repo root).
 */

import 'dotenv/config';
import { app, pool } from './app.js';

const PORT = process.env.PORT ?? 4000;

const server = app.listen(PORT, () => {
  console.log(`ConsultTrack API listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[${signal}] shutting down...`);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
