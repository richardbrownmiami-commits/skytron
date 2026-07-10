var https = require('https');
var http = require('http');

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
  if (!match) { console.log('No script tag found'); return; }
  var code = match[1].trim();
  console.log('Deployed JS length:', code.length);
  
  // Test directly from the fetched HTML (no file encoding issues)
  try {
    new Function(code);
    console.log('PARSES OK from direct fetch');
  } catch(e) {
    console.log('PARSE FAIL:', e.message);
  }
  
  // Extract runRepair specifically
  var parts = code.split(/(?=function\s)/);
  var runRepair = parts.filter(function(p) { return p.startsWith('function runRepair'); })[0];
  if (runRepair) {
    console.log('runRepair length:', runRepair.length);
    try { new Function(runRepair); console.log('runRepair: OK'); }
    catch(e) { console.log('runRepair: FAIL -', e.message); }
  }
  
  // Also extract runRepair from the ORIGINAL PARTS approach
  var idx = code.indexOf('function runRepair()');
  if (idx >= 0) {
    var prefix = code.substring(0, idx);
    try { new Function(prefix); console.log('Up to runRepair: OK, length=' + prefix.length); }
    catch(e) { console.log('Up to runRepair: FAIL -', e.message); }
    
    var full = prefix + runRepair;
    try { new Function(full); console.log('Including runRepair: OK'); }
    catch(e) { console.log('Including runRepair: FAIL -', e.message); }
  }
}).catch(function(e) {
  console.log('Fetch error:', e.message);
});
