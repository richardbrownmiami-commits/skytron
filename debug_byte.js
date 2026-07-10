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
  
  // Let's look at the EXACT bytes of the function  
  // Output EVERY character that could be problematic
  for (var i = 0; i < func.length; i++) {
    var c = func.charCodeAt(i);
    if (c > 126) {
      console.log('Non-ASCII at', i, ': hex=' + c.toString(16), 'char=' + func[i]);
    }
  }
  
  // Check: what exactly follows the "return function" pattern
  // i.e., inside the issues.map(function(issue){...}) - the callback has its own return
  var mapPos = func.indexOf('.map(function(issue)');
  if (mapPos >= 0) {
    console.log('\n.map function starts at', mapPos);
    // Count braces from map position to see if it's balanced
    var sub = func.substring(mapPos);
    var depth = 0;
    for (var i = 0; i < sub.length; i++) {
      if (sub[i] === '{') depth++;
      if (sub[i] === '}') depth--;
      if (depth === 0 && i > 0) {
        console.log('.map callback ends at', mapPos + i, 'total inner length:', i+1);
        var innerCallback = sub.substring(0, i+1);
        // Test just this callback
        try { new Function('var _ = ' + innerCallback); console.log('Callback expr: OK'); }
        catch(e) { console.log('Callback expr: FAIL:', e.message); }
        break;
      }
    }
  }
  
  // Let me try yet another approach: evaluate the function in parts
  // by tracking brace depth and testing at each statement boundary
  var inSingle = false, inDouble = false;
  var depth = 0;
  var lastGoodPos = 0;
  for (var i = 0; i < func.length; i++) {
    var ch = func[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (i > 0 && depth === 0 && i > lastGoodPos + 10) {
      // This position is a suitable boundary to test
      // (we only test a few times to keep it fast)
    }
  }
  
  // Instead: let me just look at the runRepair from the deployed version
  // and compare it with a KNOWN GOOD version
  // From the earlier test, we know the prefix up to (but not including) runRepair is valid
  // Let me check exactly what the prefix + runRepair produces
  var prefix = code.substring(0, start);
  var fullWithRepair = prefix + func;
  
  try {
    new Function(fullWithRepair);
    console.log('Full with repair: OK');
  } catch(e) {
    console.log('Full with repair: FAIL:', e.message);
  }
  
  // Now, let me try to find the exact cause by constructing valid JS that should work
  // and comparing with what we have
  console.log('\n=== Character-level analysis of potential issues ===');
  for (var i = 0; i < func.length - 1; i++) {
    // Check for: 0x60 (backtick), 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F
    var c = func.charCodeAt(i);
    if ((c >= 0x00 && c <= 0x08) || c === 0x0B || c === 0x0C || (c >= 0x0E && c <= 0x1F) || c === 0x7F) {
      console.log('Control char at', i, ': hex=' + c.toString(16));
    }
  }
  console.log('Done checking control characters');
  
}).catch(function(e) { console.log('Error:', e.message); });
