/**
 * Smoke test for the built bundles (no browser, no network):
 *
 *  - lib/client.js evaluates, registers via window.__ModuleLoader__, and its
 *    apply() attaches a capture-phase keydown listener with the right
 *    interception rules. The stub DOM below models the *current* composer:
 *    `[data-composer-card]` > `[data-composer-input]` contenteditable whose
 *    own bubble-phase keydown listener plays the part of the Lexical keymap
 *    (submit on Enter) and whose beforeinput listener plays the part of
 *    `case "insertLineBreak"` (insert a soft break). That makes the assertions
 *    behavioral: after a plain Enter the editor saw a line-break edit and never
 *    saw the keydown; Ctrl/Cmd+Enter still reaches the keymap and submits.
 *  - The legacy `<textarea>` composer path is still covered.
 *  - When a DSH install is present, the contract this plugin depends on is
 *    re-verified against the shipped `dsh-client-ui-conversation` bundle: the
 *    composer surface and the `insertLineBreak` beforeinput branch must still
 *    exist (skipped when no install is found).
 *  - lib/index.js imports as ESM and exposes the cordis plugin face.
 */
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`)
  }
}

// --- minimal DOM -----------------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = []
    this.textContent = ''
    this.isContentEditable = false
    this.readOnly = false
    this.disabled = false
    this.value = ''
    this.selectionStart = 0
    this.selectionEnd = 0
  }
  get nodeType() {
    return 1
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'contenteditable') this.isContentEditable = value !== 'false'
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
    if (name === 'contenteditable') this.isContentEditable = false
  }
  matches(selector) {
    return selector === '[data-composer-input]' ? this.hasAttribute('data-composer-input') : false
  }
  closest(selector) {
    for (const part of selector.split(',').map((s) => s.trim())) {
      for (let node = this; node !== null; node = node.parentNode) {
        if (part === '[data-composer-card]' && node.hasAttribute('data-composer-card')) return node
        if (part === '[data-composer-input]' && node.hasAttribute('data-composer-input')) return node
        if (part === 'textarea' && node.tagName === 'TEXTAREA') return node
      }
    }
    return null
  }
  querySelector(selector) {
    for (const part of selector.split(',').map((s) => s.trim())) {
      const found = this._find(part)
      if (found !== null) return found
    }
    return null
  }
  _find(selector) {
    const match = /^\[role="(\w+)"\]$/.exec(selector)
    if (match === null) return null
    for (const child of this.children) {
      if (child.getAttribute('role') === match[1]) return child
      const nested = child._find(selector)
      if (nested !== null) return nested
    }
    return null
  }
  addEventListener(type, fn) {
    this.listeners.push({ type, fn })
  }
  removeEventListener(type, fn) {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
    if (i !== -1) this.listeners.splice(i, 1)
  }
  dispatchEvent(event) {
    this.dispatch(event.type, event)
    return true
  }
  /**
   * Deliver an event to this node, bubbling up through its ancestors — the way
   * a real document dispatch reaches the editor root and then the document.
   * Mirrors DOM semantics: `stopPropagation` ends the walk, `preventDefault`
   * only flags the event.
   */
  dispatch(type, event) {
    const path = []
    for (let node = this; node !== null; node = node.parentNode) path.push(node)
    for (const node of path) {
      if (event._sp === true || event._sip === true) return
      for (const listener of [...node.listeners]) {
        if (listener.type !== type) continue
        listener.fn(event)
        if (event._sip === true) return
      }
    }
  }
}

class FakeTextarea extends FakeNode {
  constructor() {
    super('textarea')
  }
  setSelectionRange(start, end) {
    this.selectionStart = start
    this.selectionEnd = end
  }
}
// Browser shape: `value` is a prototype accessor, which is exactly the hook the
// legacy textarea path reaches for when the native editing pipeline refuses.
Object.defineProperty(FakeTextarea.prototype, 'value', {
  get() {
    return this._value ?? ''
  },
  set(next) {
    this._value = next
  },
  configurable: true,
})

class FakeInputEvent {
  /**
   * Browser shape: the real `InputEvent` accessor lives on instances, so
   * `InputEvent.prototype.inputType` is `undefined` while a constructed event
   * carries its own value. Modelling that faithfully is what catches a broken
   * feature probe — an earlier prototype-based probe passed this harness but
   * silently disabled insertion in the real browser.
   */
  constructor(type, init = {}) {
    this.type = type
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable === true
    this.data = init.data ?? null
    this.inputType = init.inputType
    this._pd = false
    this._sp = false
    this._sip = false
  }
  preventDefault() {
    this._pd = true
  }
  stopPropagation() {
    this._sp = true
  }
  stopImmediatePropagation() {
    this._sip = true
  }
}

const docListeners = []
const documentStub = {
  addEventListener(type, fn, capture) {
    docListeners.push({ type, fn, capture: capture === true })
  },
  removeEventListener(type, fn, capture) {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true))
    if (i !== -1) docListeners.splice(i, 1)
  },
  execCommand(command) {
    documentStub.commands.push(command)
    return documentStub.execResult
  },
  commands: [],
  execResult: false,
}

let exportsResult = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      if (entry.id !== 'dsh-enter-newline') throw new Error(`unexpected bundle id: ${entry.id}`)
      exportsResult = entry.factory((spec) => {
        throw new Error(`unexpected runtime require: ${spec}`)
      })
    },
  },
  HTMLTextAreaElement: FakeTextarea,
}
globalThis.document = documentStub
globalThis.HTMLTextAreaElement = FakeTextarea
globalThis.HTMLElement = FakeNode
globalThis.InputEvent = FakeInputEvent

// --- load the client bundle ------------------------------------------------
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInThisContext(clientSource, { filename: 'lib/client.js' })

console.log('client bundle exports:')
check('registers exactly the expected bundle', exportsResult !== null)
check('exports.inject is an empty array', Array.isArray(exportsResult?.inject) && exportsResult.inject.length === 0)
check('exports.apply is a function', typeof exportsResult?.apply === 'function')
check('no listener attached before apply()', docListeners.length === 0)

// --- apply() attaches the capture listener ---------------------------------
let capturedCleanup
exportsResult.apply({
  effect(fn, label) {
    if (label !== 'dsh-enter-newline: composer enter policy') throw new Error(`unexpected effect label: ${label}`)
    capturedCleanup = fn()
    return capturedCleanup
  },
})
check('apply() attaches one keydown listener', docListeners.length === 1)
check('listener uses capture phase', docListeners[0]?.capture === true && docListeners[0]?.type === 'keydown')
const onKeyDown = docListeners[0].fn

// --- composer stubs --------------------------------------------------------
/**
 * A stand-in for the current composer: card > input(contenteditable), carrying
 * the two behaviors of the shipped editor this plugin interacts with — submit
 * on keydown Enter (the Lexical composer keymap) and insert a soft break on
 * beforeinput `insertLineBreak` (the editor's own input branch).
 */
function currentComposer(opts = {}) {
  const card = new FakeNode('div')
  card.setAttribute('data-composer-card', '')
  if (opts.popup === true) {
    const popup = new FakeNode('div')
    popup.setAttribute('role', opts.popupRole ?? 'listbox')
    card.appendChild(popup)
  }
  const input = new FakeNode('div')
  input.setAttribute('data-composer-input', '')
  input.setAttribute('contenteditable', opts.editable === false ? 'false' : 'true')
  if (opts.composing === true) input.setAttribute('data-composer-composing', '')
  input.textContent = opts.text ?? 'hello'
  card.appendChild(input)

  const seen = { keydown: [], submits: 0, lineBreaks: 0, cancelable: [], input }
  input.addEventListener('keydown', (event) => {
    seen.keydown.push(event.key)
    if (event.key === 'Enter' && event.shiftKey !== true) seen.submits += 1
  })
  input.addEventListener('beforeinput', (event) => {
    if (event.inputType !== 'insertLineBreak') return
    seen.cancelable.push(event.cancelable)
    if (event._pd) return
    seen.lineBreaks += 1
    input.textContent += '\n'
  })
  return seen
}

/** The 0.1.x composer: a plain textarea inside the composer card. */
function legacyComposer(opts = {}) {
  const card = new FakeNode('div')
  card.setAttribute('data-composer-card', '')
  if (opts.popup === true) {
    const popup = new FakeNode('div')
    popup.setAttribute('role', 'listbox')
    card.appendChild(popup)
  }
  const textarea = new FakeTextarea()
  textarea.value = opts.value ?? 'hello'
  textarea.selectionStart = textarea.selectionEnd = opts.caret ?? textarea.value.length
  textarea.readOnly = opts.readOnly === true
  textarea.disabled = opts.disabled === true
  card.appendChild(textarea)
  return { input: textarea, textarea }
}

function fire(target, props = {}) {
  const event = {
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    target,
    _pd: false,
    _sp: false,
    _sip: false,
    preventDefault() {
      this._pd = true
    },
    stopPropagation() {
      this._sp = true
    },
    stopImmediatePropagation() {
      this._sip = true
    },
    ...props,
  }
  onKeyDown(event)
  // Deliver the event to the editor only when the policy let it through.
  if (event._pd !== true && event._sp !== true) target.dispatch('keydown', event)
  return event
}

console.log('current (Lexical contenteditable) composer:')
let composer = currentComposer()
let ev = fire(composer.input)
check('plain Enter is intercepted (preventDefault)', ev._pd === true)
check('plain Enter is intercepted (stopPropagation)', ev._sp === true)
check('plain Enter never reaches the editor keymap', composer.submits === 0 && composer.keydown.length === 0)
check('plain Enter inserts exactly one line break', composer.lineBreaks === 1)
check('line break rides a cancelable beforeinput event', composer.cancelable[0] === true)
check('draft text gained the newline', composer.input.textContent === 'hello\n')

composer = currentComposer()
ev = fire(composer.input, { ctrlKey: true })
check('Ctrl+Enter passes through to the editor (send)', ev._pd !== true && ev._sp !== true)
check('Ctrl+Enter still submits through the keymap', composer.submits === 1 && composer.lineBreaks === 0)

composer = currentComposer()
ev = fire(composer.input, { metaKey: true })
check('Cmd+Enter passes through to the editor (send)', composer.submits === 1 && composer.lineBreaks === 0)

composer = currentComposer()
ev = fire(composer.input, { shiftKey: true })
check('Shift+Enter passes through (native soft break)', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer()
ev = fire(composer.input, { altKey: true })
check('Alt+Enter passes through (untouched)', ev._pd !== true && ev._sp !== true)

composer = currentComposer()
ev = fire(composer.input, { isComposing: true })
check('Enter during IME composition passes through', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer()
ev = fire(composer.input, { keyCode: 229 })
check('Enter with IME keyCode 229 passes through', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer({ composing: true })
ev = fire(composer.input)
check('Enter with the composer composing marker passes through', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer({ popup: true })
ev = fire(composer.input)
check('Enter with an open listbox passes through (select item)', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer({ popup: true, popupRole: 'dialog' })
ev = fire(composer.input)
check('Enter with an open dialog passes through (context panel)', ev._pd !== true && composer.lineBreaks === 0)

composer = currentComposer({ editable: false })
ev = fire(composer.input)
check('Enter on the inert hero surface passes through (workspace picker)', ev._pd !== true && ev._sp !== true)

const nonComposerEditable = new FakeNode('div')
nonComposerEditable.setAttribute('contenteditable', 'true')
ev = fire(nonComposerEditable)
check('a contenteditable outside the composer card is left alone', ev._pd !== true)

const outside = new FakeNode('div')
outside.setAttribute('data-composer-input', '')
outside.setAttribute('contenteditable', 'true')
ev = fire(outside)
check('Enter outside the composer card passes through', ev._pd !== true && ev._sp !== true)

ev = fire(composer.input, { key: 'Tab' })
check('non-Enter keys pass through', ev._pd !== true && ev._sp !== true)

console.log('legacy (textarea) composer:')
documentStub.commands = []
documentStub.execResult = false
let legacy = legacyComposer()
ev = fire(legacy.input)
check('plain Enter on a legacy composer textarea is intercepted', ev._pd === true && ev._sp === true)
check('legacy path asks the native editing pipeline first', documentStub.commands.includes('insertLineBreak'))

documentStub.commands = []
legacy = legacyComposer({ value: 'hello', caret: 5 })
fire(legacy.input)
check('legacy fallback inserts the newline through the value setter', legacy.textarea.value === 'hello\n')

legacy = legacyComposer({ readOnly: true })
ev = fire(legacy.input)
check('Enter on a readOnly textarea passes through', ev._pd !== true)

// --- engines without synthetic-beforeinput support: execCommand fallback ----
console.log('engine without synthetic-beforeinput support:')
delete globalThis.InputEvent
documentStub.commands = []
documentStub.execResult = true
composer = currentComposer()
ev = fire(composer.input)
check('plain Enter is still intercepted', ev._pd === true && ev._sp === true)
check('the executor falls back to execCommand insertLineBreak', documentStub.commands.includes('insertLineBreak'))
check('no submit slipped through in the fallback path', composer.submits === 0)

// A constructor that drops `inputType` must not strand the gesture either: the
// interception already suppressed submit, so a silently skipped insertion would
// present as a dead Enter key.
globalThis.InputEvent = class {
  constructor(type) {
    this.type = type
  }
}
documentStub.commands = []
documentStub.execResult = true
composer = currentComposer()
ev = fire(composer.input)
check('a constructor that drops inputType still reaches execCommand', documentStub.commands.includes('insertLineBreak'))
check('no submit slipped through when the hint is ignored', composer.submits === 0)

// --- cleanup ---------------------------------------------------------------
capturedCleanup()
check('effect cleanup detaches the listener', docListeners.length === 0)

// --- server half -----------------------------------------------------------
console.log('server bundle:')
const server = await import(new URL('../lib/index.js', import.meta.url))
check('exports name = dsh-enter-newline', server.name === 'dsh-enter-newline')
check('exports inject is an empty array', Array.isArray(server.inject) && server.inject.length === 0)
check('exports apply is a function', typeof server.apply === 'function')
server.apply({ logger: undefined }) // must not throw without a logger

// --- installed-composer contract (best effort) -----------------------------
console.log('installed composer contract:')
const installed = [
  'C:/Users/ZYFDroid/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
  'C:/Users/ZYFDroid/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
].find((candidate) => existsSync(candidate))
if (installed === undefined) {
  console.log('  skip no dsh-client-ui-conversation install found on this machine')
} else {
  const bundle = readFileSync(installed, 'utf8')
  check('composer renders [data-composer-input]', bundle.includes('"data-composer-input"'))
  check('composer renders [data-composer-card]', bundle.includes('"data-composer-card"'))
  check('composer still handles beforeinput insertLineBreak', bundle.includes('case "insertLineBreak"'))
  check('composer still marks composition on the editor root', bundle.includes('data-composer-composing'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
