const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/<script>(.*?)<\/script>/);
if (!match) { console.log('NO SCRIPT TAG'); process.exit(1); }
const code = match[1].trim();
// Find the error by trying to parse
try {
  new Function(code);
  console.log('OK');
} catch(e) {
  console.log('Error: ' + e.message);
  // Try to find the position by checking character by character
  // Use the fact that node SyntaxError has a limited stack
  const stackLine = e.stack.split('\n')[0];
  console.log('Stack: ' + stackLine);
}
