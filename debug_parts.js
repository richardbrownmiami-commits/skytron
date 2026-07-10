var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');

// Test: remove all function declarations and code that was added after searchData
// Find searchData function
var searchPos = code.indexOf('function searchData()');
if (searchPos >= 0) {
  var prefix = code.substring(0, searchPos);
  try {
    new Function(prefix);
    console.log('OK: code before searchData is valid, length:', prefix.length);
  } catch(e) {
    console.log('FAIL: code before searchData: ' + e.message);
  }
}

// Test just the new additions (from runRepair to end)
var repairPos = code.indexOf('function runRepair()');
if (repairPos >= 0) {
  var additions = code.substring(repairPos);
  try {
    new Function(additions);
    console.log('FAIL: additions alone passed but should fail?');
  } catch(e) {
    console.log('Expected: additions alone fail:', e.message);
  }
}

// Now test: code up to runRepair
var upToRepair = code.substring(0, code.indexOf('function runRepair()'));
try {
  new Function(upToRepair);
  console.log('OK: up to runRepair, length:', upToRepair.length);
} catch(e) {
  console.log('FAIL: up to runRepair:', e.message);
}

// Compare with parts approach
var parts = code.split(/(?=function\s)/);
console.log('Total parts:', parts.length);
var accum = '';
for (var i = 0; i < parts.length; i++) {
  accum += parts[i];
  try {
    new Function(accum);
    // OK
  } catch(e) {
    console.log('FAIL at part', i, 'length', accum.length, 'first 80:', parts[i].substring(0, 80));
    console.log('Error:', e.message);
    break;
  }
}
