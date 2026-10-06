import { createApp } from './app.js';
import { getDb } from './db.js';
import { startLocalWebhookDispatcher } from './webhookOutbox.js';

const app = createApp();
const PORT = process.env.PORT || 5000;

if (!process.env.VERCEL) startLocalWebhookDispatcher();

app.listen(PORT, () => {
  console.log(`🚀 ProcureFlow running on http://localhost:${PORT}`);
  getDb()
    .then((db) => {
      console.log(`   DB mode: ${db.useTurso ? 'turso-http' : 'sqlite'}`);
    })
    .catch((error) => {
      console.error('   DB init failed:', error.message);
    });
});
