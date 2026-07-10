var https = require('https');

function fetch(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    }).on('error', reject);
  });
}

fetch('https://saraha-brain.richard-brown-miami.workers.dev/skytronchat').then(function(html) {
  var match = html.match(/<script>([\s\S]*?)<\/script>/);
  var code = match[1].trim();
  
  // Extract runRepair using brace counting
  var start = code.indexOf('function runRepair()');
  var braceCount = 0;
  var endPos = start;
  for (var i = start; i < code.length; i++) {
    if (code[i] === '{') braceCount++;
    if (code[i] === '}') {
      braceCount--;
      if (braceCount === 0) { endPos = i + 1; break; }
    }
  }
  
  var func = code.substring(start, endPos);
  
  // Strategy: build the function statement by statement, testing each addition
  // The function starts with:
  // function runRepair(){
  var statements = [];
  var depth = 0;
  var currentStmt = '';
  var inSingle = false, inDouble = false;
  
  var body = func.substring(func.indexOf('{') + 1, func.lastIndexOf('}'));
  
  // Track statement boundaries
  for (var i = 0; i < body.length; i++) {
    var ch = body[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '{' && !inSingle && !inDouble) depth++;
    if (ch === '}' && !inSingle && !inDouble) depth--;
    
    if (ch === ';' && depth === 0 && !inSingle && !inDouble) {
      currentStmt += ch;
      statements.push(currentStmt);
      currentStmt = '';
    } else {
      currentStmt += ch;
    }
  }
  if (currentStmt) statements.push(currentStmt);
  
  console.log('Number of top-level statements:', statements.length);
  
  // Now test incrementally
  var built = '';
  for (var i = 0; i < statements.length; i++) {
    built += statements[i];
    var fullFunc = 'function runRepair(){' + built + '}';
    try {
      new Function(fullFunc);
      console.log('Statement ' + i + ' OK (' + statements[i].substring(0, 60) + '...)');
    } catch(e) {
      console.log('Statement ' + i + ' FAIL: ' + e.message);
      console.log('  Statement text: ' + statements[i].substring(0, 100));
      console.log('  Full built so far: ' + built.substring(0, 200));
      break;
    }
  }
  
  // Also check: is the problem related to the \u{...} inside a regex?
  // Or maybe inside a different context?
  console.log('\nRaw runRepair first 100 chars:', JSON.stringify(func.substring(0, 100)));
  
}).catch(function(e) { console.log('Error:', e.message); });
