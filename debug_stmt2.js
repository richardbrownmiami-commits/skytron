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
  
  // Find statement 2 (fetch) - it starts after the second semicolon
  var semi1 = body.indexOf(';');
  var semi2 = body.indexOf(';', semi1 + 1);
  var stmt3 = body.substring(semi2 + 1); // starts with 'fetch('
  
  console.log('Statement 3 length:', stmt3.length);
  console.log('Statement 3 first 200:', JSON.stringify(stmt3.substring(0, 200)));
  
  // There is only 1 semicolon IN stmt3 (at the very end)
  // Let me split it further by .then boundaries
  var parts = stmt3.split(/(\.then\()/);
  console.log('Parts count:', parts.length);
  
  var accumulated = '';
  var prefix = body.substring(0, semi2 + 1); // statements 0 and 1
  var fullPrefix = 'function runRepair(){' + prefix;
  
  for (var i = 0; i < parts.length; i++) {
    accumulated += parts[i];
    var fullFunc = fullPrefix + accumulated + '}';
    try {
      new Function(fullFunc);
      console.log('Part ' + i + ' OK (' + parts[i].substring(0, 40) + '...)');
    } catch(e) {
      console.log('Part ' + i + ' FAIL: ' + e.message);
      console.log('  This part: ' + JSON.stringify(parts[i].substring(0, 100)));
      break;
    }
  }
  
  // Found it! Let me extract the specific failing sub-part
  // The parts array was split on .then( - let's reconstruct carefully
}).catch(function(e) { console.log('Error:', e.message); });
