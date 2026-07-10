var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));

// Find WHERE the fetch call starts (after the second semicolon)
var semi2 = body.indexOf(';', body.indexOf(';') + 1);
var prefixBody = body.substring(0, semi2 + 1); // Ends with second semicolon
var fetchCall = body.substring(semi2 + 1);

console.log('Prefix body length:', prefixBody.length);
console.log('Fetch call length:', fetchCall.length);
console.log('Prefix body: ' + prefixBody.substring(0, 80) + '...');
console.log('Fetch call start: ' + fetchCall.substring(0, 80) + '...');

// Build the prefix
var fullPrefix = 'function runRepair(){' + prefixBody;

// Now test adding fetchCall one character at a time
for (var i = 1; i <= fetchCall.length; i++) {
  var testCode = fullPrefix + fetchCall.substring(0, i) + '}';
  try {
    new Function(testCode);
  } catch(e) {
    console.log('FAIL at char ' + i + ': ' + e.message);
    console.log('  Around pos: ' + JSON.stringify(fetchCall.substring(Math.max(0,i-20), i+20)));
    console.log('  Code end: ' + JSON.stringify(testCode.substring(testCode.length-80)));
    break;
  }
}
