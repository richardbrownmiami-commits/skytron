import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist')
let html = readFileSync(join(dist, 'index.html'), 'utf8')

// Inline JS
html = html.replace(/<script[^>]*\ssrc="([^"]+)"[^>]*><\/script>/, (_, src) => {
  const js = readFileSync(join(dist, src), 'utf8')
  return `<script>${js}</script>`
})

// Inline CSS
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)">/, (_, href) => {
  const css = readFileSync(join(dist, href), 'utf8')
  return `<style>${css}</style>`
})

writeFileSync(join(dist, 'index.html'), html)
console.log('Assets inlined into index.html')
