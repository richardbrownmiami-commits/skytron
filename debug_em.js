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
  
  // Try to find the issue by splitting into larger chunks
  // Split on ';{' and ';}'
  var body = func.substring(func.indexOf('{') + 1, func.lastIndexOf('}'));
  
  // Find the em-dash position
  var emDashPos = func.indexOf('\u2014');
  console.log('Em dash at position:', emDashPos);
  
  // Check: what's the character BEFORE the em dash?
  console.log('Before em dash:', JSON.stringify(func.substring(emDashPos - 5, emDashPos)));
  console.log('After em dash:', JSON.stringify(func.substring(emDashPos, emDashPos + 5)));
  
  // Is the em dash inside a string?
  var inSingle = false;
  var inDouble = false;
  var emInSingle = false;
  var emInDouble = false;
  for (var i = 0; i < func.length; i++) {
    if (i === emDashPos) { emInSingle = inSingle; emInDouble = inDouble; }
    if (func[i] === "'" && !inDouble) inSingle = !inSingle;
    if (func[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  console.log('Em dash in single-quoted string:', emInSingle);
  console.log('Em dash in double-quoted string:', emInDouble);
  
  // Try replacing the em dash and test
  var fixed = func.replace('\u2014', '-');
  try { new Function(fixed); console.log('FIXED (em dash replaced): OK'); }
  catch(e) { console.log('FIXED (em dash replaced): FAIL:', e.message); }
  
  // Now try replacing u{...} syntax
  var fixed2 = func.replace(/\\u\{[0-9A-Fa-f]+\}/g, '\\uXXXX');
  try { new Function(fixed2); console.log('FIXED (u-brace replaced): OK'); }
  catch(e) { console.log('FIXED (u-brace replaced): FAIL:', e.message); }
  
  // Try removing ALL non-ASCII from the string
  var fixed3 = func.replace(/[^\x00-\x7F]/g, ' ');
  try { new Function(fixed3); console.log('FIXED (non-ASCII removed): OK'); }
  catch(e) { console.log('FIXED (non-ASCII removed): FAIL:', e.message); }
  
}).catch(function(e) { console.log('Error:', e.message); });
