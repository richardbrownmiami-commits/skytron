var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');
var parts = code.split(/(?=function\s)/);
var runRepair = parts[20];

console.log('runRepair length:', runRepair.length);
console.log('Full text:', runRepair);

// Try to find the exact error by converting to lines (split at statement boundaries)
// Remove the function wrapper
var inner = runRepair.replace(/^function\w+\(\)\{/, '').replace(/\}\s*$/, '');
console.log('Inner body length:', inner.length);
console.log('First 100 chars:', JSON.stringify(inner.substring(0, 100)));
console.log('Last 100 chars:', JSON.stringify(inner.substring(inner.length-100)));

// Test inner body as standalone
var testBody = 'function f(){' + inner + '}';
try {
  new Function(testBody);
  console.log('Inner body: OK');
} catch(e) {
  console.log('Inner body: FAIL at character', inner.substring(0, 100));
}

// Try to evaluate each statement
// First, separate inner body by semicolons and try each statement one by one
try {
  new Function('function f(){' + inner.substring(0, inner.indexOf(';')+1) + '}');
  console.log('First statement: OK');
} catch(e) {
  console.log('First statement error:', e.message);
}

// Character-by-character binary search within inner body
function testBody(len) {
  try {
    new Function('function f(){' + inner.substring(0, len) + '}');
    return true;
  } catch(e) { return false; }
}

var lo = 0, hi = inner.length;
while (lo < hi) {
  var mid = Math.floor((lo + hi) / 2);
  if (testBody(mid)) { lo = mid + 1; } else { hi = mid; }
}
console.log('Inner body breaks at character', lo);
console.log('Context:', JSON.stringify(inner.substring(Math.max(0, lo - 30), lo + 30)));
console.log('Last valid context:', JSON.stringify(inner.substring(Math.max(0, lo - 30), lo)));
