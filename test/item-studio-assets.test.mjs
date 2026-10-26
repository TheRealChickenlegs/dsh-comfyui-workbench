import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve('data/item_studio')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'item_catalog.json'), 'utf8'))

test('item studio assets: every family has a guide, style reference and palette', () => {
  const families = new Set(catalog.items.map((item) => item.family))
  for (const family of families) {
    assert.ok(fs.existsSync(path.join(root, 'guides', `${family}.png`)), `missing guide ${family}`)
  }
  assert.ok(fs.statSync(path.join(root, 'style_reference.png')).size > 1000)
  const palette = JSON.parse(fs.readFileSync(path.join(root, 'palette.json'), 'utf8'))
  assert.equal(palette.colours.length, 32)
  assert.equal(catalog.count, 108)
  assert.equal(catalog.items.length, 108)
})
