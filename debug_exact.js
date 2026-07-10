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
  
  // Extract runRepair
  var start = code.indexOf('function runRepair()');
  var endPos = start;
  var braceCount = 0;
  var found = false;
  for (var i = start; i < code.length; i++) {
    if (code[i] === '{') braceCount++;
    if (code[i] === '}') {
      braceCount--;
      if (braceCount === 0) { endPos = i + 1; found = true; break; }
    }
  }
  
  var func = code.substring(start, endPos);
  console.log('Function:', func);
  console.log('Total length:', func.length);
  
  // Now let me look for anything suspicious character-by-character
  var suspicious = [];
  for (var i = 0; i < func.length; i++) {
    var c = func.charCodeAt(i);
    // Check for: non-printable, non-ASCII that's not inside string
    if (c > 127 || c < 32) {
      suspicious.push({pos: i, code: c, char: func[i], context: func.substring(Math.max(0,i-10), i+10)});
    }
  }
  
  if (suspicious.length > 0) {
    console.log('Suspicious chars found:', suspicious.length);
    suspicious.forEach(function(s) {
      console.log('  Pos', s.pos, ': code=' + s.code + ' hex=0x' + s.code.toString(16) + ' char=' + JSON.stringify(s.char));
      console.log('  Context:', JSON.stringify(s.context));
    });
  } else {
    console.log('No suspicious characters');
  }
  
  // Now let's find the exact error location by binary search
  function testPartial(len) {
    try { new Function(func.substring(0, len)); return true; }
    catch(e) { return false; }
  }
  
  var lo = 0, hi = func.length;
  while (lo < hi) {
    var mid = Math.floor((lo + hi) / 2);
    if (testPartial(mid)) { lo = mid + 1; } else { hi = mid; }
  }
  
  console.log('\nFirst error at position:', lo);
  console.log('Error context:', JSON.stringify(func.substring(Math.max(0, lo - 30), Math.min(func.length, lo + 30))));
  console.log('Char at error:', JSON.stringify(func[lo]), 'code:', func.charCodeAt(lo));
  
  // Check quote state at that position
  var inSingle = false, inDouble = false;
  for (var i = 0; i < lo; i++) {
    if (func[i] === "'" && !inDouble) inSingle = !inSingle;
    if (func[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  console.log('Quote state at error: inSingle=' + inSingle + ' inDouble=' + inDouble);
}).catch(function(e) { console.log('Error:', e.message); });
