var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));

// Known-valid prefix: first 136 chars
var prefix = 'function runRepair(){' + body.substring(0, 136); 
// prefix = 'function runRepair(){var v=...v.innerHTML=...;fet'

// Find where 'fetch' starts
var fetchPos = body.indexOf('fetch(');
var fetchCall = body.substring(fetchPos);

console.log('Prefix length:', prefix.length);
console.log('Fetch call length:', fetchCall.length);

// Add fetch call character by character, testing each
for (var i = 1; i <= fetchCall.length; i++) {
  var full = prefix + fetchCall.substring(0, i) + '}';
  try {
    new Function(full);
    // OK
  } catch(e) {
    console.log('FAIL at char ' + i + ' of fetchCall: ' + e.message);
    console.log('  Last 20 added: ' + JSON.stringify(fetchCall.substring(Math.max(0,i-20), i)));
    console.log('  Full context(' + (full.length - 1) + '): ' + JSON.stringify(full.substring(full.length-50)));
    break;
  }
}
