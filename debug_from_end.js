var fs = require('fs');
var code = fs.readFileSync('D:/Github/Skytron/chat.html', 'utf8');
var match = code.match(/<script>([\s\S]*?)<\/script>/);
var js = match[1].trim();
var runPos = js.indexOf('function runRepair()');
var runFull = js.substring(runPos, runPos + 2358);
var body = runFull.substring(runFull.indexOf('{')+1, runFull.lastIndexOf('}'));

// Instead of binary search from the start, let me try adding/removing 
// chunks from the END
function test(code) {
  try { new Function(code); return true; }
  catch(e) { 
    // console.log(e.message);
    return false; 
  }
}

// Strategy: remove chunks from the end until it becomes valid
// Start with full body, remove 100 chars at a time from the end
for (var remove = 0; remove < body.length; remove += 100) {
  var partial = body.substring(0, body.length - remove);
  var wrapper = 'function runRepair(){' + partial + '}';
  if (test(wrapper)) {
    console.log('VALID when last ' + remove + ' chars removed');
    console.log('Valid body:', partial);
    console.log('Removed suffix:', JSON.stringify(body.substring(body.length - remove)));
    break;
  }
}
