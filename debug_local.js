var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');

// Extract the script
var match = code.match(/<script>([\s\S]*?)<\/script>/);
if (!match) { console.log('No script found'); process.exit(1); }
var js = match[1].trim();
console.log('JS length:', js.length);

// Find the repair functions
var runPos = js.indexOf('function runRepair()');
var doPos = js.indexOf('function doRepair()');
var getViewPos = js.indexOf('function getViewId(n)');

console.log('runRepair at:', runPos);
console.log('doRepair at:', doPos);
console.log('getViewId at:', getViewPos);

// Test separately
function test(desc, code) {
  try { new Function(code); console.log('OK:', desc); }
  catch(e) { console.log('FAIL:', desc, '-', e.message); }
}

// Extract each function by brace counting
function extract(code, start) {
  var depth = 0;
  for (var i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.substring(start, i+1);
    }
  }
  return null;
}

var runRepair = extract(js, runPos+1); // +1 for the 'f' in function
var doRepair = extract(js, doPos);

console.log('\nrunRepair length:', runRepair.length);
test('runRepair alone', runRepair);

console.log('\ndoRepair length:', doRepair.length);
test('doRepair alone', doRepair);

// Test them together with a prefix
var prefix = js.substring(0, runPos);
test('prefix before runRepair', prefix);

var combined = prefix + runRepair;
test('prefix + runRepair', combined);

// Now test them as individual expressions
// runRepair body
var runBody = runRepair.substring(runRepair.indexOf('{')+1, runRepair.lastIndexOf('}'));
test('runRepair body as val', 'function(){' + runBody + '}');

// Test doRepair body
var doBody = doRepair.substring(doRepair.indexOf('{')+1, doRepair.lastIndexOf('}'));
test('doRepair body as val', 'function(){' + doBody + '}');
