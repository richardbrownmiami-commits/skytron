var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));

// Test body character by character - find the EXACT position
function test(len) {
  try {
    new Function('function f(){' + body.substring(0, len) + '}');
    return true;
  } catch(e) { return false; }
}

// Binary search at 1-char granularity
var lo = 0, hi = body.length;
while (lo < hi) {
  var mid = Math.floor((lo + hi) / 2);
  if (test(mid)) { lo = mid + 1; } else { hi = mid; }
}
console.log('FAIL at position:', lo);
console.log('Char:', JSON.stringify(body[lo-1]) + ' -> ' + JSON.stringify(body[lo]));
console.log('Context (30 before, 10 after):', JSON.stringify(body.substring(Math.max(0,lo-30), lo+10)));

// Check the character codes
console.log('Code of char at', lo, ':', body.charCodeAt(lo));
console.log('Code of char before:', body.charCodeAt(lo-1));

// Try with a space inserted before the problematic position
var fixed1 = body.substring(0, lo) + ' ' + body.substring(lo);
try {
  new Function('function f(){' + fixed1 + '}');
  console.log('Works with space inserted');
} catch(e) {
  console.log('Still fails with space:', e.message);
}

// Try removing just the character
var fixed2 = body.substring(0, lo-1) + body.substring(lo);
try {
  new Function('function f(){' + fixed2 + '}');
  console.log('Works without char');
} catch(e) {
  console.log('Still fails without char:', e.message);
}
