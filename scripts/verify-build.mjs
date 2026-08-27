import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const required = [
  'lib/index.js',
  'lib/client.js',
  'lib/client.js.map',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
]

for (const file of required) {
  if (!existsSync(file)) throw new Error(`missing build artifact: ${file}`)
}

const client = readFileSync('lib/client.js', 'utf8')
if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']dsh-plugin-profiler["']/.test(client)) {
  throw new Error('client bundle does not register the expected DSH module id')
}
if (/require\(["']zod["']\)/.test(client)) {
  throw new Error('client bundle leaked zod as an unavailable module-table dependency')
}
if (!client.includes('settings.plugins.tab')) {
  throw new Error('client bundle does not contain the profiler settings contribution')
}

let registration
runInNewContext(client, {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
})
if (registration?.id !== 'dsh-plugin-profiler' || typeof registration.factory !== 'function') {
  throw new Error('client bundle did not submit a materializable DSH registration')
}

const require = createRequire(import.meta.url)
const exports = registration.factory(specifier => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
  throw new Error('client bundle requested unexpected module-table entry: ' + specifier)
})
if (typeof exports.apply !== 'function' || !Array.isArray(exports.inject)) {
  throw new Error('materialized client bundle does not expose its Cordis plugin face')
}

process.stdout.write('verified Host Typert artifacts and DSH client bundle\n')
