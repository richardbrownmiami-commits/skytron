var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');

// Replace em dash with regular dash
var fixed = code.replace(/\u2014/g, '-');
try {
  new Function(fixed);
  console.log('OK after em dash replacement');
} catch(e) {
  console.log('Still fails:', e.message);
}

// Replace \u{...} with simpler escapes
var fixed2 = code.replace(/\\u\{([0-9A-Fa-f]+)\}/g, function(m, hex) {
  var cp = parseInt(hex, 16);
  if (cp > 0xFFFF) return '\\uFFFF';
  return m;
});
try {
  new Function(fixed2);
  console.log('Still OK after u-brace replacement');
} catch(e) {
  console.log('Fails after u-brace replacement:', e.message);
}

// Test just the \u{...} syntax
try {
  new Function('var x="\\u{1F5D1}"');
  console.log('\\u{1F5D1} syntax: OK');
} catch(e) {
  console.log('\\u{1F5D1} syntax: FAIL:', e.message);
}
