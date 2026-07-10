var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');

// Test if the issue is in the single-line string with multi-byte characters
// Check for stray unescaped chars that break string parsing
function testPartial(end) {
  try {
    new Function(code.substring(0, end));
    return true;
  } catch(e) {
    return false;
  }
}

// Binary search for first failure
var lo = 0, hi = code.length;
while (lo < hi) {
  var mid = Math.floor((lo + hi) / 2);
  if (testPartial(mid)) {
    lo = mid + 1;
  } else {
    hi = mid;
  }
}
console.log('First failure at position:', lo);
console.log('Context:', JSON.stringify(code.substring(Math.max(0, lo - 10), lo + 40)));

// Now extract the problematic section
var problem = code.substring(Math.max(0, lo - 30), lo + 10);
console.log('Problem area:', problem);

// Also test the raw file with --check
