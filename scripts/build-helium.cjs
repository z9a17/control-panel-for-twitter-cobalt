const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'dist', 'helium-mv3')
fs.mkdirSync(output, {recursive: true})
for (const entry of ['_locales', 'icons', 'cobalt', 'background.js', 'content.js', 'script.js', 'options.html', 'options.js', 'options.css', 'options-icon.png', 'LICENSE', 'NOTICE']) {
  fs.cpSync(path.join(root, entry), path.join(output, entry), {recursive: true})
}
fs.copyFileSync(path.join(root, 'manifest.mv3.json'), path.join(output, 'manifest.json'))
fs.writeFileSync(path.join(output, 'browser_action.html'), fs.readFileSync(path.join(root, 'options.html'), 'utf8').replace('<body>', '<body class="browserAction">'))
console.log('Built Helium extension:', output)
