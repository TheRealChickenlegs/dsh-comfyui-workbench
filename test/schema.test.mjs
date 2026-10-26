/**
 * Schema guard tests.
 *
 * Basis: `@deepseek-ai/dsh-tools/lib/types/json-schema.d.ts` states —
 *   "The subset accepts ... one scalar `type`, object `properties`/`required`/boolean
 *    `additionalProperties`, array `items`, type-correct scalar `enum`/`const`,
 *    and exact-one `oneOf`. **Unsupported or misplaced keywords reject rather than
 *    being accepted without enforcement.**"
 *
 * In other words, seemingly harmless keywords such as minimum / maximum / format / pattern make
 * the whole tool registration fail. So the allowed keywords are frozen into a whitelist here and
 * the entire parameter and output schema trees are walked — anyone who slips in a `format` turns
 * this red immediately.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_DESCRIPTION,
  AUDIO_DESCRIPTION,
  AUDIO_OUTPUT_SCHEMA,
  AUDIO_PARAMETERS_SCHEMA,
  API_OUTPUT_SCHEMA,
  API_PARAMETERS_SCHEMA,
  INSPECT_DESCRIPTION,
  INSPECT_OUTPUT_SCHEMA,
  INSPECT_PARAMETERS_SCHEMA,
  HUGGINGFACE_OUTPUT_SCHEMA,
  HUGGINGFACE_PARAMETERS_SCHEMA,
  OUTPUT_SCHEMA,
  PARAMETERS_SCHEMA,
  TOOL_DESCRIPTION,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_OUTPUT_SCHEMA,
  WORKFLOW_PARAMETERS_SCHEMA,
  VIDEO_DESCRIPTION,
  VIDEO_OUTPUT_SCHEMA,
  VIDEO_PARAMETERS_SCHEMA
} from '../lib/index.js'

/** The allowed fields, listed verbatim in json-schema.d.ts. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

const SCALAR_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function walk(node, where, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  visit(node, where)
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, `${where}.properties.${key}`, visit)
    }
  }
  if (node.items) walk(node.items, `${where}.items`, visit)
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => walk(child, `${where}.oneOf[${index}]`, visit))
  }
}

function collect(node, where) {
  const problems = []
  walk(node, where, (current, at) => {
    for (const key of Object.keys(current)) {
      if (!ALLOWED_KEYWORDS.has(key)) {
        problems.push(`${at} uses the unsupported JSON Schema keyword "${key}" (DSH rejects the whole schema)`)
      }
    }
    if (current.type !== undefined && !SCALAR_TYPES.has(current.type)) {
      problems.push(`${at}.type is not a legal scalar type: ${JSON.stringify(current.type)}`)
    }
    if (current.enum !== undefined) {
      if (!Array.isArray(current.enum) || current.enum.length === 0) {
        problems.push(`${at}.enum must be a non-empty array`)
      } else {
        for (const value of current.enum) {
          const type = typeof value
          if (value !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
            problems.push(`${at}.enum may only contain scalars, received ${type}`)
          }
        }
      }
    }
    if (current.const !== undefined) {
      const type = typeof current.const
      if (current.const !== null && type !== 'string' && type !== 'number' && type !== 'boolean') {
        problems.push(`${at}.const may only be a scalar, received ${type}`)
      }
    }
    if (current.oneOf !== undefined && (!Array.isArray(current.oneOf) || current.oneOf.length < 2)) {
      problems.push(`${at}.oneOf needs at least two branches`)
    }
    if (current.required !== undefined) {
      if (!Array.isArray(current.required)) {
        problems.push(`${at}.required must be an array of strings (not a required: true style)`)
      } else {
        const declared = Object.keys(current.properties ?? {})
        for (const name of current.required) {
          if (!declared.includes(name)) {
            problems.push(`${at}.required lists "${name}", which is not declared in properties`)
          }
        }
      }
    }
    if (current.additionalProperties !== undefined && typeof current.additionalProperties !== 'boolean') {
      problems.push(`${at}.additionalProperties may only be a boolean`)
    }
  })
  return problems
}

test('parameter schema: the whole tree only uses the JSON Schema subset DSH supports', () => {
  const problems = collect(PARAMETERS_SCHEMA, 'parameters')
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('output schema: the whole tree only uses the JSON Schema subset DSH supports', () => {
  const problems = collect(OUTPUT_SCHEMA, 'output.schema')
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('parameter schema: object root + extra fields disabled (wrong keys from the Agent are rejected clearly)', () => {
  assert.equal(PARAMETERS_SCHEMA.type, 'object')
  assert.equal(PARAMETERS_SCHEMA.additionalProperties, false)
  assert.ok(Array.isArray(PARAMETERS_SCHEMA.required))
  assert.deepEqual(PARAMETERS_SCHEMA.required, [], 'V1 allows a single prompt, so there are no required fields')
})

test('parameter schema: none of the parameters from the spec may be missing', () => {
  const expected = [
    'mode',
    'prompt',
    'negative_prompt',
    'input_image',
    'mask_image',
    'width',
    'height',
    'seed',
    'output_path',
    'style_reference',
    'character_reference',
    'strength',
    'steps',
    'cfg_scale',
    'extra_options'
  ]
  const declared = Object.keys(PARAMETERS_SCHEMA.properties)
  for (const name of expected) {
    assert.ok(declared.includes(name), `the parameter schema is missing ${name}, which the spec requires`)
  }
  // Two extra optional fields V1 provides for "Agent friendliness"
  assert.ok(declared.includes('model'), 'it should be possible to specify a checkpoint')
  assert.ok(declared.includes('sampler_name'), 'it should be possible to specify a sampler')
})

test('parameter schema: mode is an enum, and the enum values match the runtime', () => {
  const mode = PARAMETERS_SCHEMA.properties.mode
  assert.deepEqual([...mode.enum].sort(), ['img2img', 'inpaint', 'remove_background', 'text2img'])
})

test('parameter schema: every parameter has a description (the model relies on it)', () => {
  for (const [name, spec] of Object.entries(PARAMETERS_SCHEMA.properties)) {
    assert.equal(typeof spec.description, 'string', `parameter ${name} is missing a description`)
    assert.ok(spec.description.length > 4, `parameter ${name}'s description is too short for the model to understand`)
  }
})

test('output schema: declares the four categories the acceptance criteria require (path/success/description/metadata)', () => {
  const required = OUTPUT_SCHEMA.required
  for (const key of ['text', 'path', 'files', 'success', 'mode', 'seed', 'width', 'height', 'model']) {
    assert.ok(required.includes(key), `the output schema should list ${key} as required`)
  }
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false)
})

test('output schema: notes and files are string arrays', () => {
  assert.equal(OUTPUT_SCHEMA.properties.notes.type, 'array')
  assert.equal(OUTPUT_SCHEMA.properties.notes.items.type, 'string')
  assert.equal(OUTPUT_SCHEMA.properties.files.type, 'array')
  assert.equal(OUTPUT_SCHEMA.properties.files.items.type, 'string')
})

test('tool description: says the backend is ComfyUI, names the four modes, and explains what is filled in automatically', () => {
  assert.match(TOOL_DESCRIPTION, /ComfyUI/)
  for (const mode of ['text2img', 'img2img', 'inpaint', 'remove_background']) {
    assert.ok(TOOL_DESCRIPTION.includes(mode), `the description should mention ${mode}`)
  }
  assert.match(TOOL_DESCRIPTION, /mode/, 'the description should tell the model there is a mode parameter')
})

/* ─────────────────────────── advanced tool schemas ─────────────────────────── */

const ADVANCED_SCHEMAS = [
  ['comfyui_inspect parameters', INSPECT_PARAMETERS_SCHEMA],
  ['comfyui_inspect output', INSPECT_OUTPUT_SCHEMA],
  ['comfyui_workflow parameters', WORKFLOW_PARAMETERS_SCHEMA],
  ['comfyui_workflow output', WORKFLOW_OUTPUT_SCHEMA],
  ['comfyui_api parameters', API_PARAMETERS_SCHEMA],
  ['comfyui_api output', API_OUTPUT_SCHEMA],
  ['generate_audio parameters', AUDIO_PARAMETERS_SCHEMA],
  ['generate_audio output', AUDIO_OUTPUT_SCHEMA],
  ['generate_video parameters', VIDEO_PARAMETERS_SCHEMA],
  ['generate_video output', VIDEO_OUTPUT_SCHEMA],
  ['huggingface_models parameters', HUGGINGFACE_PARAMETERS_SCHEMA],
  ['huggingface_models output', HUGGINGFACE_OUTPUT_SCHEMA]
]

test('advanced schemas: every tree only uses the JSON Schema subset DSH supports', () => {
  for (const [label, schema] of ADVANCED_SCHEMAS) {
    const problems = collect(schema, label)
    assert.deepEqual(problems, [], `${label}:\n${problems.join('\n')}`)
  }
})

test('advanced schemas: object roots, required fields declared, descriptions present', () => {
  for (const [label, schema] of ADVANCED_SCHEMAS) {
    assert.equal(schema.type, 'object', `${label} should be an object root`)
    assert.equal(schema.additionalProperties, false, `${label} should reject undeclared output/parameter fields`)
    assert.ok(Array.isArray(schema.required), `${label} should declare required`)
    const declared = Object.keys(schema.properties ?? {})
    for (const name of schema.required) assert.ok(declared.includes(name), `${label}: required ${name} is undeclared`)
    for (const [name, spec] of Object.entries(schema.properties ?? {})) {
      assert.equal(typeof spec.description, 'string', `${label}: ${name} needs a description`)
    }
  }
})

test('advanced tool descriptions explain what each tool is for', () => {
  assert.match(INSPECT_DESCRIPTION, /models/)
  assert.match(INSPECT_DESCRIPTION, /nodes/)
  assert.match(WORKFLOW_DESCRIPTION, /validate/)
  assert.match(WORKFLOW_DESCRIPTION, /run/)
  assert.match(API_DESCRIPTION, /raw|Raw/)
  assert.match(API_DESCRIPTION, /base URL/)
  assert.match(AUDIO_DESCRIPTION, /ACE-Step/)
  assert.match(VIDEO_DESCRIPTION, /Wan 2\.1/)
  assert.match(VIDEO_DESCRIPTION, /detects/i)
})
