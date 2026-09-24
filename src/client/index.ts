/**
 * dsh-enter-newline — client half: composer Enter policy.
 *
 * Default DSH composer behavior (`@deepseek-ai/dsh-client-ui-conversation`,
 * `InputBar` + `registerComposerKeymap`):
 *   - Enter            -> submit ("enter" delivery mode)
 *   - Shift+Enter      -> newline ("insertLineBreak")
 *   - Ctrl/Cmd+Enter   -> submit ("accelerated" mode; steers the queue while busy)
 *
 * This plugin flips the primary gesture:
 *   - Enter            -> newline (type long markdown prompts)
 *   - Ctrl/Cmd+Enter   -> send   (composer's accelerated submit runs unchanged)
 *   - Shift+Enter      -> newline (unchanged)
 *   - Alt+Enter        -> unchanged (falls through to the composer's plain-Enter path)
 *
 * ## Why this needed a rewrite for the 0.7.x composer
 *
 * DSH 0.1.x (what this plugin was written against) rendered the composer as a
 * plain `<textarea>`; its React `onKeyDown` called `keyboard.submit(...)`.
 * Since the composer rewrite the draft surface is a **shell-owned Lexical
 * editor**: `[data-composer-card] [data-composer-input]` is a
 * `contenteditable` div (`role="textbox"`), and the Enter gesture is an
 * editor command (`KEY_ENTER_COMMAND`) registered on that root element.
 *
 * The old implementation therefore stopped working entirely — and silently:
 *   - `target instanceof HTMLTextAreaElement` was false for every keystroke,
 *     so the capture listener returned before doing anything;
 *   - `document.execCommand('insertLineBreak')` and the
 *     `HTMLTextAreaElement.prototype.value` setter are both meaningless for a
 *     contenteditable element.
 *
 * ## How the rewrite works (still no Lexical import, no DSH-private API)
 *
 * 1. A capture-phase `keydown` listener on `document` runs before the editor's
 *    own root listeners. For a plain Enter on the composer surface it calls
 *    `preventDefault()` (no native line break) and `stopPropagation()` (the
 *    editor's bubble-phase keydown handler never runs, so `KEY_ENTER_COMMAND`
 *    neither submits nor inserts).
 * 2. The newline is then requested through the browser's **input pipeline**:
 *    a synthetic `beforeinput` event with `inputType: "insertLineBreak"` is
 *    dispatched on the editor root. That is the same event (and the same
 *    `INSERT_LINE_BREAK_COMMAND` path) the composer itself handles for
 *    Shift+Enter — so Lexical's document, undo stack, projection and the
 *    input machine all see one ordinary edit. Lexical ships no other public
 *    hook for this, and it uses the very same `dispatchEvent(new InputEvent(
 *    'beforeinput', …))` idiom internally (drag-and-drop deletion).
 * 3. Legacy fallbacks keep the plugin working on a `<textarea>` composer
 *    (0.1.x profiles) and on engines without `beforeinput`.
 *
 * Hard exclusions (the event passes through untouched):
 *   - IME composition in progress (`event.isComposing`, `keyCode === 229`, or
 *     the composer's own `[data-composer-composing]` marker) — Chinese/Japanese
 *     input confirms with Enter
 *   - a popup is open inside the composer card (command menu / @-mention
 *     picker render `role="listbox"`; the context panel is a `role="dialog"`),
 *     where Enter must select the highlighted item
 *   - the composer surface is not editable (agent busy, or the hero workspace
 *     picker where Enter opens the workspace chooser)
 */
/**
 * The slice of the client root context this fiber touches. Declared structurally
 * on purpose: the client half must not import a package at runtime (it is
 * bundled standalone and the module loader provides nothing to it), and the
 * published `@deepseek-ai/dsh-client-runtime` package is not installable
 * standalone (its `@deepseek-ai/dsh-compact` dependency is unpublished), so a
 * type-only import would break `npm run typecheck` for consumers of this repo.
 */
export interface ClientContext {
  /**
   * Register a scoped effect; the returned disposer runs on fiber unload.
   * @param effect - effect body, optionally returning its own disposer.
   * @param label - human-readable effect name used by diagnostics.
   */
  effect(effect: () => void | (() => void) | Promise<void | (() => void)>, label?: string): void
}

/** No cordis services needed by this fiber. */
export const inject: string[] = []

/** The composer card (stable data-* hook rendered by InputBar). */
const COMPOSER_CARD = '[data-composer-card]'

/** The editor surface: legacy composer textarea, or the current contenteditable. */
const COMPOSER_TEXTAREA = 'textarea'
const COMPOSER_EDITABLE = '[data-composer-input]'

/** Popups inside the card whose open state must keep Enter for selection. */
const OPEN_POPUP = '[role="listbox"], [role="menu"], [role="dialog"]'

/** `inputType` of the browser's own soft-break edit (what Shift+Enter emits). */
const INSERT_LINE_BREAK = 'insertLineBreak'

/** True when the focused element is an editable composer surface. */
function isEditable(element: HTMLElement): boolean {
  if (element.isContentEditable) return true
  const declared = element.getAttribute('contenteditable')
  return declared === '' || declared === 'true' || declared === 'plaintext-only'
}

/**
 * True while an IME composition owns the keyboard, including its trailing
 * window. The composer stamps `[data-composer-composing]` on the editor root
 * for exactly that span (`registerComposerKeymap`), which also covers engines
 * that report `isComposing === false` on the confirming Enter.
 * @param event - the keydown under inspection.
 * @param target - the editor surface that received it.
 * @returns whether the event must be left to the IME.
 */
function composing(event: KeyboardEvent, target: HTMLElement): boolean {
  if (event.isComposing || event.keyCode === 229) return true
  if (target.hasAttribute('data-composer-composing')) return true
  const root = target.closest('[data-composer-input], [data-composer-card]')
  return root !== null && root.hasAttribute('data-composer-composing')
}

/**
 * Whether this engine forwards a constructed `inputType` to the event, i.e.
 * whether a synthetic `beforeinput` edit is worth dispatching.
 *
 * Probed with a real instance on purpose: `InputEvent.prototype.inputType` is
 * `undefined` in Chromium (and Node), because the accessor lives on instances —
 * a prototype probe always fails and would silently disable the primary path.
 * @returns true when `new InputEvent(type, { inputType })` keeps its inputType.
 */
function supportsSyntheticInputType(): boolean {
  if (typeof InputEvent !== 'function') return false
  try {
    return new InputEvent('beforeinput', { inputType: INSERT_LINE_BREAK }).inputType === INSERT_LINE_BREAK
  } catch {
    return false
  }
}

/**
 * Insert a soft line break into the composer's editable surface by replaying
 * the browser's own `beforeinput` edit, which the editor handles as a regular
 * `INSERT_LINE_BREAK_COMMAND`.
 *
 * The `execCommand` fallback exists for engines without synthetic-beforeinput
 * support; it must stay reachable, because an interrupted insertion is
 * indistinguishable to the user from a dead Enter key (the submit gesture is
 * already suppressed by the caller).
 * @param root - the focused `contenteditable` composer surface.
 */
function insertLineBreak(root: HTMLElement): void {
  if (supportsSyntheticInputType()) {
    root.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: INSERT_LINE_BREAK,
      }),
    )
    return
  }
  if (typeof document.execCommand === 'function') {
    try {
      document.execCommand(INSERT_LINE_BREAK)
    } catch {
      /* the engine refused; a dead Enter beats an unintended send */
    }
  }
}

/**
 * Legacy composer (DSH 0.1.x profiles): a plain `<textarea>` draft with a React
 * `onChange`, where the native editing pipeline is `execCommand` + the value
 * setter.
 * @param textarea - the focused composer textarea.
 */
function insertNewlineIntoTextarea(textarea: HTMLTextAreaElement): void {
  try {
    if (document.execCommand(INSERT_LINE_BREAK)) return
    if (document.execCommand('insertText', false, '\n')) return
  } catch {
    /* fall through to the programmatic fallback */
  }
  const { selectionStart, selectionEnd } = textarea
  const next = `${textarea.value.slice(0, selectionStart)}\n${textarea.value.slice(selectionEnd)}`
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) return
  setter.call(textarea, next)
  const caret = selectionStart + 1
  textarea.setSelectionRange(caret, caret)
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: INSERT_LINE_BREAK, data: '\n' }))
}

/**
 * Apply the composer Enter policy.
 * @param ctx - client root context (used for effect-scoped listener cleanup).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return
      // Modifier chords keep the composer's own semantics.
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const card = target.closest(COMPOSER_CARD)
      if (card === null) return
      // Popup open: leave Enter to the composer (select item / confirm).
      if (card.querySelector(OPEN_POPUP) !== null) return
      // IME composition (e.g. Chinese input): the confirm-Enter must pass through.
      if (composing(event, target)) return

      const textarea = target.closest(COMPOSER_TEXTAREA)
      if (textarea instanceof HTMLTextAreaElement) {
        if (textarea.readOnly || textarea.disabled) return
        event.preventDefault()
        event.stopPropagation()
        insertNewlineIntoTextarea(textarea)
        return
      }

      // Current composer: a contenteditable surface inside the card. The hero
      // workspace-trigger state renders the same surface inert (no editor),
      // where Enter must keep opening the workspace chooser.
      if (!target.matches(COMPOSER_EDITABLE) || !isEditable(target)) return
      event.preventDefault()
      event.stopPropagation()
      insertLineBreak(target)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, 'dsh-enter-newline: composer enter policy')
}
