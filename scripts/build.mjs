import { mkdir, readFile, writeFile } from 'node:fs/promises'
const {name} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const modules = ['controller', 'locales', 'sync-view', 'provider-view', 'view', 'index']
const factories = []
// Embed the same packaged artwork so the settings page needs no asset request.
const icon = await readFile(new URL('../assets/icon.svg', import.meta.url))
factories.push(`"./icon.svg":function(require,module,exports){module.exports=${JSON.stringify(`data:image/svg+xml;base64,${icon.toString('base64')}`)}}`)
for (const name of modules) {
  const source = await readFile(new URL(`../src/client/${name}.cjs`, import.meta.url), 'utf8')
  factories.push(`${JSON.stringify(`./${name}.cjs`)}:function(require,module,exports){\n${source}\n}`)
}
const bundle = `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(external)=>{\nconst factories={${factories.join(',\n')}};const cache={};function require(id){if(!factories[id])return external(id);if(!cache[id]){const module={exports:{}};cache[id]=module;factories[id](require,module,module.exports)}return cache[id].exports}return require('./index.cjs');\n}});\n`
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), bundle)
