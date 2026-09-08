/**
 * Vercel serverless entrypoint.
 *
 * vercel.json rewrites every /api/* request here, and the Express app routes it
 * from there. Env vars come from the Vercel dashboard, not a .env file.
 */

export { default } from '../server/app.js';
