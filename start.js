// Production entry point: restore data from Postgres (if DATABASE_URL is set), then start the app.
const path = require('path');
const store = require('./lib/store');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
let stopping = false;
async function stop(sig) {
  if (stopping) return; stopping = true;
  if (store.active()) console.log(`[store] ${sig}: saving to Postgres before exit…`);
  const t = setTimeout(() => process.exit(1), 25000);
  await store.close(); clearTimeout(t); process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
store.restore({ DATA_DIR, UPLOAD_DIR })
  .then(() => require('./server'))
  .catch(e => { console.error('[store] could not load data from Postgres:', e.message); process.exit(1); });
