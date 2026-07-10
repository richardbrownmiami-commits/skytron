var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');

// Convert to lines and check for newlines inside strings
var inSingle = false;
var inDouble = false;
var issueAt = -1;
for (var i = 0; i < code.length; i++) {
  var ch = code[i];
  if (ch === "'" && !inDouble) inSingle = !inSingle;
  if (ch === '"' && !inSingle) inDouble = !inDouble;
  if (ch === '\n' || ch === '\r') {
    if (inSingle) { issueAt = i; break; }
  }
}
if (issueAt >= 0) {
  console.log('NEWLINE inside single-quoted string at position', issueAt);
  console.log('Context:', JSON.stringify(code.substring(Math.max(0, issueAt-30), issueAt+30)));
} else {
  console.log('No newlines inside single-quoted strings');
}

// Check the non-ASCII em dash character
for (var i = 0; i < code.length; i++) {
  if (code.charCodeAt(i) > 127) {
    console.log('Non-ASCII char at', i, 'code:', code.charCodeAt(i), 'context:', JSON.stringify(code.substring(Math.max(0,i-10), i+10)));
    break;
  }
}
