var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);

function test(fn) {
  try { new Function(fn); return true; }
  catch(e) { return false; }
}

// Try removing various patterns from the full function
var variants = {};

// Remove ALL escape sequences (backslash followed by something)
variants.no_escapes = runFull.replace(/\\./g, 'X');

// Remove ONLY \uXXXX (4 hex digit unicode escapes)
variants.no_u4 = runFull.replace(/\\u[0-9A-Fa-f]{4}/g, 'X');

// Remove ONLY \u{...} escapes
variants.no_ubrace = runFull.replace(/\\u\{[0-9A-Fa-f]+\}/g, 'X');

// Replace double quotes with single quotes in test (for writing HTML)
// Actually just test each variant
for (var name in variants) {
  if (test(variants[name])) {
    console.log('PASSES when ' + name);
    break;
  } else {
    console.log('FAILS when ' + name);
  }
}

// Test the FULL body with exactly 1 escape removed at a time
// Find all \u escapes
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));
var escapes = [];
for (var i = 0; i < body.length - 1; i++) {
  if (body[i] === '\\' && body[i+1] === 'u') {
    var end = i + 2;
    if (body[end] === '{') {
      while (body[end] !== '}' && end < body.length) end++;
      escapes.push({start: i, end: end+1, text: body.substring(i, end+1)});
    } else {
      escapes.push({start: i, end: i+6, text: body.substring(i, i+6)});
    }
  }
}

console.log('\nFound ' + escapes.length + ' escape sequences in body');
escapes.forEach(function(e, idx) {
  console.log('  ' + idx + ': ' + e.text + ' at pos ' + e.start);
});

// Now try REMOVING each escape sequence individually (replacing with plain text)
for (var i = 0; i < escapes.length; i++) {
  var modified = body.substring(0, escapes[i].start) + 'X' + body.substring(escapes[i].end);
  var wrapper = 'function runRepair(){' + modified + '}';
  if (test(wrapper)) {
    console.log('\nPASSES when escape ' + i + ' (' + escapes[i].text + ') is removed');
    break;
  }
}
if (i === escapes.length) {
  console.log('\nNone of the individual escape removals fixes it');
}
