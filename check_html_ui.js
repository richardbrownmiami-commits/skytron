const fs = require('fs');
const h = fs.readFileSync('chat.html', 'utf-8');
console.log('Has think/latest:', h.includes('/think/latest'));
console.log('Has addMsg("user",t):', h.includes('addMsg("user",t)'));
console.log('Has optimistic msg:', h.includes('if(!t)return;addMsg("user",t)'));
