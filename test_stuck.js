const https = require('https');

// Check stuck actions
const data = JSON.stringify({ sql: "SELECT id, type, status, task, created_at, updated_at FROM actions WHERE status='running' ORDER BY created_at DESC LIMIT 10" });

const req = https.request({
  hostname: 'saraha-brain.richard-brown-miami.workers.dev',
  path: '/think',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.end(() => {
    try {
      const r = JSON.parse(body);
      console.log(JSON.stringify(r, null, 2));
    } catch(e) {
      console.log("Raw:", body.slice(0, 2000));
    }
  });
});
// Actually, /think doesn't do db_query. Let me try a different approach.
req.destroy();

// Use /brain/knowledge endpoint instead? No, need db_query.
// Let me just curl the /status endpoint to check
const req2 = https.get('https://saraha-brain.richard-brown-miami.workers.dev/status', res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log("Status:", body));
});
req2.end();
