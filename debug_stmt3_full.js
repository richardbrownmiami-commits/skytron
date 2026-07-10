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
  var body = func.substring(func.indexOf('{') + 1, func.lastIndexOf('}'));
  
  // Let me output the body and examine it carefully
  console.log('BODY:');
  console.log(body);
  console.log('END BODY');
  
  // Now build from the start, testing at each complete ';'
  // including semicolons at ANY depth
  var inSingle = false, inDouble = false;
  var depth = 0;
  var current = '';
  
  for (var i = 0; i < body.length; i++) {
    var ch = body[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    current += ch;
    
    if (ch === ';' && !inSingle && !inDouble) {
      // Test up to this point
      var full = 'function runRepair(){' + current + '}';
      try {
        new Function(full);
        console.log('OK at pos ' + i + ' (depth=' + depth + ')');
      } catch(e) {
        console.log('FAIL at pos ' + i + ' (depth=' + depth + '): ' + e.message);
        console.log('  Last 50:', JSON.stringify(body.substring(Math.max(0,i-50), i+1)));
        break;
      }
    }
  }
  
}).catch(function(e) { console.log('Error:', e.message); });
