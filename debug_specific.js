var fs = require('fs');

// Test specific problematic constructs
function test(desc, code) {
  try { new Function(code); console.log('OK:', desc); }
  catch(e) { console.log('FAIL:', desc, '-', e.message); }
}

test('simple u brace', 'var x="\\u{1F5D1}"');
test('assignment u brace', 'var icon="\\u{1F5D1}";label="test"');
test('inside if block', 'function f(){if(true){var icon="\\u{1F5D1}";label="test"}}');
test('close to original', 'function runRepair(){if(issue.type==="old_logs"){icon="\\u{1F5D1}";label="Old logs";detail="test"}}');

// Test the EXACT full deployed script
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');
var parts = code.split(/(?=function\s)/);
var runRepair = parts[20];

// Check - does the runRepair work in strict mode?
try {
  new Function('"use strict";' + runRepair);
  console.log('OK in strict mode');
} catch(e) {
  console.log('FAIL in strict mode:', e.message);
}

// Check what Node version we're running
console.log('Node version:', process.version);

// Check the exact problematic position in the runRepair function
var repaired = runRepair.replace(/\\u\{1F5D1\}/g, '\\uFFFF');
try {
  new Function(repaired);
  console.log('OK after replacing \\u{1F5D1} with \\uFFFF');
} catch(e) {
  console.log('FAIL after replacement:', e.message);
}

// Also test: is the issue the em-dash inside the function?
var repaired2 = runRepair.replace(/\u2014/g, '-');
try {
  new Function(repaired2);
  console.log('OK after replacing em-dash');
} catch(e) {
  console.log('FAIL after em-dash replacement:', e.message);
}

// Test: em-dash replacement + u-brace replacement
var repaired3 = runRepair.replace(/\u2014/g, '-').replace(/\\u\{1F5D1\}/g, '\\uFFFF');
try {
  new Function(repaired3);
  console.log('OK after BOTH replacements');
} catch(e) {
  console.log('FAIL after both:', e.message);
}

// Test the function with newline-formatted version
var formatted = runRepair.replace(/;/g, ';\n').replace(/{/g, '{\n').replace(/}/g, '}\n');
try {
  new Function(formatted);
  console.log('OK formatted');
} catch(e) {
  console.log('FAIL formatted:', e.message);
}
