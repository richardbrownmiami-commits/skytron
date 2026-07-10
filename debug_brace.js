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
  for (var i = start; i < code.length; i++) {
    if (code[i] === '{') braceCount++;
    if (code[i] === '}') {
      braceCount--;
      if (braceCount === 0) { var endPos = i + 1; break; }
    }
  }
  
  var func = code.substring(start, endPos);
  
  // Test the EXACT 5-char snippet around \u{1F5D1}
  var bracePos = func.indexOf('\\u{1F5D1}');
  console.log('Literal \\\\u{1F5D1} text at position:', bracePos);
  console.log('Context:', JSON.stringify(func.substring(bracePos - 20, bracePos + 20)));
  
  // Check whether this is actually inside a string literal
  var inSingle = false, inDouble = false;
  for (var i = 0; i < func.length; i++) {
    if (i === bracePos) {
      console.log('At bracePos: inSingle=' + inSingle + ' inDouble=' + inDouble);
      break;
    }
    if (func[i] === "'" && !inDouble) inSingle = !inSingle;
    if (func[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  
  // Carefully test: what if I remove ALL backslash-u sequences?
  // Replace ONLY the \u braces, not the \uXXXX ones
  var fixed = func.replace(/\\u\{[0-9A-Fa-f]+\}/g, '" + String.fromCodePoint(0x1F5D1) + "');
  try { new Function(fixed); console.log('FIXED: OK'); }
  catch(e) { console.log('FIXED: FAIL:', e.message); }
  
  // Try removing the old_logs branch entirely
}).catch(function(e) { console.log('Error:', e.message); });
