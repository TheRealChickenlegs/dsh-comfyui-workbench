/**
 * Static checks for the browser-side plugin configuration page.
 * The real page is exercised by DSH's client module loader; these checks prevent a package
 * that silently omits the page or its bundle from being published.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8')

test('client: the bundle is a module-loader bundle for this package', () => {
  const source = read('lib/client.js')
  assert.match(source, /__ModuleLoader__\.load/)
  assert.match(source, /id: 'dsh-comfyui-workbench'/)
  assert.match(source, /plugins\.bundle\.config/)
  assert.match(source, /configForms/)
  assert.match(source, /exports\.apply/)
})

test('client: the package declares the client half and every UI field', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.client?.immediately, true)
  assert.deepEqual(pkg.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager'
  ])
  assert.equal(pkg.exports?.['./client']?.default, './lib/client.js')
  const source = read('lib/client.js')
  for (const key of [
    'baseUrl',
    'outputDir',
    'requestTimeoutMs',
    'timeoutMs',
    'pollIntervalMs',
    'checkpoint',
    'negativePrompt',
    'steps',
    'cfgScale',
    'samplerName',
    'scheduler',
    'width',
    'height',
    'strength',
    'inpaintGrowMask',
    'saveToComfyUI',
    'writeMetadata',
    'rembgNode',
    'huggingFaceToken',
    'huggingFaceEndpoint',
    'comfyuiModelsDir',
    'modelDownloadDir',
    'maxDownloadBytes'
  ]) {
    assert.match(source, new RegExp(`key: '${key}'`))
  }
})

test('client: apply registers a bundle configuration page with the package key', () => {
  const originalWindow = globalThis.window
  let entry
  globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  try {
    // Evaluate the browser bundle with a minimal window object; no DOM is touched at load time.
    new Function('window', read('lib/client.js'))(globalThis.window)
    assert.equal(entry?.id, 'dsh-comfyui-workbench')
    const fakeReact = {}
    const exported = entry.factory((id) => {
      assert.equal(id, 'react')
      return fakeReact
    })
    assert.equal(typeof exported.apply, 'function')
    assert.deepEqual(exported.inject, ['slots', 'configForms'])

    let injected
    let registered
    const form = { getSnapshot: () => ({ status: 'ready', value: {}, revision: 0, writable: true }), subscribe: () => () => {}, mutate: async () => true }
    const ctx = {
      effect: (callback) => callback(),
      configForms: {
        get: (id) => { assert.equal(id, 'dsh-comfyui-workbench'); return form },
        whileServed: (ids, callback) => {
          assert.deepEqual(ids, ['dsh-comfyui-workbench'])
          return callback()
        }
      },
      slots: {
        inject: (name, callback) => { assert.equal(name, 'plugins.bundle.config'); injected = callback },
        register: (options, component) => { registered = { options, component }; return () => {} }
      }
    }
    exported.apply(ctx)
    assert.equal(typeof injected, 'function')
    injected()
    assert.equal(registered?.options.name, 'plugins.bundle.config')
    assert.equal(registered?.options.key, 'dsh-comfyui-workbench')
    assert.equal(typeof registered?.component, 'function')
  } finally {
    globalThis.window = originalWindow
  }
})
