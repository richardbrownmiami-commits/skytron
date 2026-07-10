var fs = require('fs');
var code = fs.readFileSync('C:/Users/Reena/AppData/Local/Temp/deployed.js', 'utf8');
var parts = code.split(/(?=function\s)/);
var runRepair = parts[20];

// Format with newlines and save to file
var formatted = '';
for (var i = 0; i < runRepair.length; i++) {
  formatted += runRepair[i];
  if (runRepair[i] === ';' || runRepair[i] === '{' || runRepair[i] === '}') {
    formatted += '\n';
  }
}
fs.writeFileSync('C:/Users/Reena/AppData/Local/Temp/runRepair_formatted.js', formatted);
console.log('Wrote formatted version');
