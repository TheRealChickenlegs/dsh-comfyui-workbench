/**
 * ComfyUI Workbench plugin-page configuration UI.
 *
 * The host half exports a volatile Config schema; DSH exposes those fields through
 * ctx.configForms. This bundle registers the bundle configuration page in the Plugins
 * panel and writes only fields the user actually changed, so file/env/default layers
 * continue to apply to untouched fields.
 *
 * Plain JS on purpose: the DSH client module loader serves this file directly, and the
 * platform provides React. No bundler or UI-primitive dependency is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-comfyui-workbench',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var PACKAGE_ID = 'dsh-comfyui-workbench'
    var ENTRY_ID = 'dsh-comfyui-workbench'
    var STYLE_ID = PACKAGE_ID + '/settings.css'

    var FIELDS = [
      { key: 'baseUrl', label: 'ComfyUI server address', type: 'text', group: 'Connection', placeholder: 'http://127.0.0.1:8188', hint: 'Default is http://127.0.0.1:8188. Do not use 0.0.0.0 as a request address.' },
      { key: 'outputDir', label: 'Default output directory', type: 'text', group: 'Connection', placeholder: 'Current project root', hint: 'Directory for generated files when a tool does not pass output_path. ~ is expanded.' },
      { key: 'requestTimeoutMs', label: 'HTTP request timeout (ms)', type: 'number', group: 'Connection', placeholder: '30000', hint: 'Timeout for a single ComfyUI HTTP request (1000-600000).' },
      { key: 'timeoutMs', label: 'Generation wait timeout (ms)', type: 'number', group: 'Connection', placeholder: '300000', hint: 'Total wait for a job (1000-3600000). Audio/video tools may need more.' },
      { key: 'pollIntervalMs', label: 'History poll interval (ms)', type: 'number', group: 'Connection', placeholder: '700', hint: 'How often to check /history while a job runs (100-10000).' },
      { key: 'checkpoint', label: 'Default image checkpoint', type: 'text', group: 'Image defaults', placeholder: 'Auto-pick (prefers names containing xl)', hint: 'A file name under ComfyUI/models/checkpoints. Leave blank to auto-pick.' },
      { key: 'negativePrompt', label: 'Default negative prompt', type: 'textarea', group: 'Image defaults', placeholder: 'Built-in quality-focused negative prompt', hint: 'Used by generate_image when the tool call does not pass negative_prompt.' },
      { key: 'steps', label: 'Sampling steps', type: 'number', group: 'Image defaults', placeholder: '20', hint: 'Default steps for generate_image (1-500).' },
      { key: 'cfgScale', label: 'CFG scale', type: 'number', group: 'Image defaults', placeholder: '7', hint: 'Default CFG for generate_image (0-100).' },
      { key: 'samplerName', label: 'Sampler', type: 'text', group: 'Image defaults', placeholder: 'euler', hint: 'Default sampler. An unavailable config default falls back with a note.' },
      { key: 'scheduler', label: 'Scheduler', type: 'text', group: 'Image defaults', placeholder: 'normal', hint: 'Default scheduler. An unavailable config default falls back with a note.' },
      { key: 'width', label: 'Default width', type: 'number', group: 'Image defaults', placeholder: '1024', hint: 'Default text-to-image width (64-8192); SD1.5-style checkpoints auto-adapt to 512.' },
      { key: 'height', label: 'Default height', type: 'number', group: 'Image defaults', placeholder: '1024', hint: 'Default text-to-image height (64-8192).' },
      { key: 'strength', label: 'Default img2img strength', type: 'number', group: 'Image defaults', placeholder: '0.6', hint: '0-1. Inpainting uses 1.0 regardless.' },
      { key: 'inpaintGrowMask', label: 'Inpaint mask growth (px)', type: 'number', group: 'Image defaults', placeholder: '6', hint: 'Grow the mask outward during inpainting (0-256).' },
      { key: 'saveToComfyUI', label: 'Save image copies in ComfyUI output', type: 'boolean', group: 'Output', hint: 'true uses SaveImage and keeps output/dsh-comfyui-workbench/. false uses PreviewImage only.' },
      { key: 'writeMetadata', label: 'Write JSON metadata sidecars', type: 'boolean', group: 'Output', hint: 'Write the full parameters/workflow sidecar next to generated files.' },
      { key: 'rembgNode', label: 'Background-removal preference', type: 'text', group: 'Background removal', placeholder: 'Auto-pick', hint: 'essentials, bria, layerstyle, was, or a node class such as RemBGSession+. Leave blank to auto-pick.' }
    ]

    var GROUPS = ['Connection', 'Image defaults', 'Output', 'Background removal']

    var CSS = [
      '.cw-root{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.cw-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.cw-group{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));padding-top:12px}',
      '.cw-groupTitle{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.cw-field{display:flex;flex-direction:column;gap:4px}',
      '.cw-label{font-size:12px;font-weight:600;line-height:18px}',
      '.cw-input,.cw-select,.cw-textarea{font:inherit;font-size:13px;line-height:20px;padding:5px 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f1115);box-sizing:border-box;width:100%}',
      '.cw-textarea{min-height:70px;resize:vertical}',
      '.cw-input:focus-visible,.cw-select:focus-visible,.cw-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d93f8));outline-offset:1px}',
      '.cw-input:disabled,.cw-select:disabled,.cw-textarea:disabled{opacity:.55}',
      '.cw-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.cw-actions{display:flex;align-items:center;gap:8px;padding-top:2px}',
      '.cw-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:0 0;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.cw-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(15,17,21,.05))}',
      '.cw-btn:disabled{opacity:.5;cursor:default}',
      '.cw-btnPrimary{background:var(--dsw-alias-state-business-primary,#4d93f8);border-color:transparent;color:#fff}',
      '.cw-msg{margin:0;font-size:12px;line-height:18px}',
      '.cw-ok{color:var(--dsw-alias-state-business-primary,#4d93f8)}',
      '.cw-err{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.cw-state{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}'
    ].join('\n')

    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE_ID
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (_) {}
    }

    function useSnapshot(form) {
      return React.useSyncExternalStore(
        function (listener) { return form.subscribe(listener) },
        function () { return form.getSnapshot() }
      )
    }

    function rawValue(snapshot, key) {
      var value = snapshot.value
      return value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
    }

    function textValue(snapshot, field, edits) {
      if (Object.prototype.hasOwnProperty.call(edits, field.key)) return edits[field.key]
      var value = rawValue(snapshot, field.key)
      if (value === undefined || value === null) return ''
      if (field.type === 'boolean') return value ? 'true' : 'false'
      return String(value)
    }

    function ConfigPage(props) {
      var form = props.form
      var snapshot = useSnapshot(form)
      var editsState = React.useState({})
      var edits = editsState[0]
      var setEdits = editsState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var messageState = React.useState('')
      var message = messageState[0]
      var setMessage = messageState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var disabled = !snapshot.writable || saving

      function edit(key, value) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setMessage('')
        setError('')
      }

      function discard() {
        setEdits({})
        setMessage('')
        setError('')
      }

      async function save() {
        var keys = Object.keys(edits)
        if (keys.length === 0) return
        var ops = []
        for (var i = 0; i < keys.length; i += 1) {
          var key = keys[i]
          var field = null
          for (var j = 0; j < FIELDS.length; j += 1) if (FIELDS[j].key === key) field = FIELDS[j]
          if (!field) continue
          var text = edits[key]
          if (text === '' || text === undefined) {
            ops.push({ op: 'unset', path: [key] })
            continue
          }
          if (field.type === 'number') {
            var number = Number(text)
            if (!Number.isFinite(number)) {
              setError('Enter a valid number for "' + field.label + '", or leave it blank to inherit.')
              return
            }
            ops.push({ op: 'set', path: [key], value: number })
          } else if (field.type === 'boolean') {
            if (text !== 'true' && text !== 'false') {
              setError('Choose true or false for "' + field.label + '", or leave it inherited.')
              return
            }
            ops.push({ op: 'set', path: [key], value: text === 'true' })
          } else {
            ops.push({ op: 'set', path: [key], value: text })
          }
        }
        setSaving(true)
        setError('')
        setMessage('')
        try {
          var accepted = await form.mutate(ops, snapshot.revision)
          if (accepted) {
            setEdits({})
            setMessage('Saved. Unchanged fields continue to inherit from the config file, environment, or defaults.')
          } else {
            setError('The server did not accept these values. Check the field ranges and try again.')
          }
        } catch (cause) {
          setError('Could not save: ' + String(cause && cause.message ? cause.message : cause))
        } finally {
          setSaving(false)
        }
      }

      if (snapshot.status === 'loading') {
        return React.createElement('p', { className: 'cw-state' }, 'Loading configuration…')
      }
      if (snapshot.status === 'unavailable') {
        return React.createElement('p', { className: 'cw-state' }, 'The configuration entry is not available. Make sure the plugin is enabled and the profile is loaded.')
      }
      if (!snapshot.value) {
        return React.createElement('p', { className: 'cw-state' }, 'No editable configuration is available for this plugin.')
      }

      var groups = GROUPS.map(function (group) {
        var fields = FIELDS.filter(function (field) { return field.group === group })
        if (fields.length === 0) return null
        return React.createElement('section', { className: 'cw-group', key: group }, [
          React.createElement('h3', { className: 'cw-groupTitle', key: 'title' }, group),
          fields.map(function (field) {
            var value = textValue(snapshot, field, edits)
            var id = 'cw-' + field.key
            var control
            if (field.type === 'boolean') {
              control = React.createElement('select', {
                id: id,
                className: 'cw-select',
                value: value,
                disabled: disabled,
                onChange: function (event) { edit(field.key, event.target.value) }
              }, [
                React.createElement('option', { value: '', key: 'inherit' }, 'Inherit'),
                React.createElement('option', { value: 'true', key: 'true' }, 'true'),
                React.createElement('option', { value: 'false', key: 'false' }, 'false')
              ])
            } else if (field.type === 'textarea') {
              control = React.createElement('textarea', {
                id: id,
                className: 'cw-textarea',
                value: value,
                placeholder: field.placeholder || '',
                disabled: disabled,
                onChange: function (event) { edit(field.key, event.target.value) }
              })
            } else {
              control = React.createElement('input', {
                id: id,
                className: 'cw-input',
                type: 'text',
                inputMode: field.type === 'number' ? 'decimal' : 'text',
                value: value,
                placeholder: field.placeholder || '',
                disabled: disabled,
                onChange: function (event) { edit(field.key, event.target.value) }
              })
            }
            return React.createElement('div', { className: 'cw-field', key: field.key }, [
              React.createElement('label', { className: 'cw-label', htmlFor: id, key: 'label' }, field.label),
              control,
              React.createElement('p', { className: 'cw-hint', key: 'hint' }, field.hint)
            ])
          })
        ])
      }).filter(Boolean)

      return React.createElement('div', { className: 'cw-root' }, [
        React.createElement('p', { className: 'cw-intro', key: 'intro' }, 'Every field is optional. Leave a field blank to inherit from the config file, environment variable, or built-in default. Saving writes only the fields you changed to the active profile.'),
        groups,
        error ? React.createElement('p', { className: 'cw-msg cw-err', key: 'err' }, error) : null,
        message ? React.createElement('p', { className: 'cw-msg cw-ok', key: 'ok' }, message) : null,
        !snapshot.writable ? React.createElement('p', { className: 'cw-state', key: 'readonly' }, 'This deployment stores settings read-only.') : null,
        React.createElement('div', { className: 'cw-actions', key: 'actions' }, [
          React.createElement('button', {
            className: 'cw-btn cw-btnPrimary',
            type: 'button',
            key: 'save',
            disabled: disabled || Object.keys(edits).length === 0,
            onClick: save
          }, saving ? 'Saving…' : 'Save'),
          React.createElement('button', {
            className: 'cw-btn',
            type: 'button',
            key: 'discard',
            disabled: disabled || Object.keys(edits).length === 0,
            onClick: discard
          }, 'Discard edits')
        ])
      ])
    }

    function apply(ctx) {
      installStyles()
      var form = ctx.configForms.get(ENTRY_ID)
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE_ID,
          inject: function () { return { form: form } }
        }, ConfigPage)
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms']
    return module.exports
  }
})
