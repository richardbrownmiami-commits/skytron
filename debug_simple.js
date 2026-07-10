// Test basic functionality
function test(desc, code) {
  try { new Function(code); console.log('OK:', desc); }
  catch(e) { console.log('FAIL:', desc, '-', e.message); }
}

// Basic function declaration inside new Function
test('empty func decl', 'function test(){}');
test('func decl with body', 'function test(){var x=1}');
test('two func decls', 'function a(){} function b(){}');
test('var + func decl', 'var x=1; function test(){}');
test('func decl + var', 'function test(){} var x=1');

// Check what the actual string is in the file
var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();

var runPos = js.indexOf('function runRepair()');
var runRepair = js.substring(runPos, runPos + 50);
console.log('\nFirst 50 chars of runRepair:', JSON.stringify(runRepair));

// Try wrapping it
try {
  new Function('return (' + js.substring(runPos) + ')');
  console.log('Wrapped as expression: OK');
} catch(e) {
  console.log('Wrapped as expression: FAIL:', e.message);
}

// Actually, the problem might be that new Function creates a function with the given string
// as the BODY. So `new Function('function f(){}')` creates:
// function anonymous() { function f(){} }
// This should be valid...

// Let's test runRepair in various ways
var runFull = js.substring(runPos, runPos + 2358); // full runRepair from the file
console.log('\nrunFull length:', runFull.length);

// Try with named function expression
try {
  new Function('(function runRepair(){})');
  console.log('Named func expr: OK');
} catch(e) {
  console.log('Named func expr: FAIL:', e.message);
}

// Try wrapping runRepair body in a simple function
var runBody = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));
console.log('runBody length:', runBody.length);
try {
  new Function('var _ = function(){' + runBody + '}');
  console.log('runBody as anonymous: OK');
} catch(e) {
  console.log('runBody as anonymous: FAIL:', e.message);
}
