import { readFileSync, writeFileSync } from 'fs'
const h = readFileSync('dist/index.html', 'utf8')
const patched = h.replace('<script>', '<script>window.process={env:{NODE_ENV:"development"}};')
writeFileSync('dist/index.html', patched)
console.log('Dev mode injected')
