var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));

// Output EVERY character as [code] for the first 3000 chars
console.log('Full body length:', body.length);
for (var i = 0; i < Math.min(3000, body.length); i++) {
  var c = body.charCodeAt(i);
  if (c < 32 || c > 126) {
    console.log('POS ' + i + ': CODE=' + c + ' HEX=0x' + c.toString(16));
  }
}
console.log('Done scanning');

// Now also check: what if we construct a MINIMAL valid function?
// The first valid statements are:
// var v=document.getElementById("repairView");v.innerHTML='<div class="loading"><span class="spinner"></span>Checking health...</div>';
// This is 133 chars including semicolons
// Let me build from there, adding just the fetch chain as a JS expression
var miniBody = body.substring(0, 133); // The first two semicolons
// Now add the fetch chain as a SINGLE complete JS expression
// fetch("/brain/health-check").then(function(r){return r.json()}).then(function(d){...})
// Let me add it 10 chars at a time from the complete string
var rest = body.substring(133);
console.log('\nRest length:', rest.length);

// Find the end of the fetch chain expression (where we return to depth=0)
var depth = 0;
var fetchEnd = -1;
for (var i = 0; i < rest.length; i++) {
  if (rest[i] === '{') depth++;
  if (rest[i] === '}') {
    depth--;
    if (depth < 0) { fetchEnd = i; break; }
  }
  if (rest[i] === ';' && depth === -1) { fetchEnd = i; break; }
}
console.log('Complete expression would end at rest index:', fetchEnd);
if (fetchEnd > 0) {
  var completeExpr = rest.substring(0, fetchEnd + 1);
  console.log('Complete expr length:', completeExpr.length);
  var fullFn = 'function runRepair(){' + miniBody + completeExpr + '}';
  try {
    new Function(fullFn);
    console.log('Complete expression: OK');
  } catch(e) {
    console.log('Complete expression: FAIL:', e.message);
  }
  
  // Try wrapping as variable assignment
  try {
    new Function('var _ = ' + completeExpr);
    console.log('As expression statement: OK');
  } catch(e) {
    console.log('As expression statement: FAIL:', e.message);
  }
}
