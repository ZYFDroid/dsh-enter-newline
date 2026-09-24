window.__ModuleLoader__.load({ id: 'dsh-enter-newline', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var inject = [];
var COMPOSER_CARD = "[data-composer-card]";
var COMPOSER_TEXTAREA = "textarea";
var COMPOSER_EDITABLE = "[data-composer-input]";
var OPEN_POPUP = '[role="listbox"], [role="menu"], [role="dialog"]';
var INSERT_LINE_BREAK = "insertLineBreak";
function isEditable(element) {
  if (element.isContentEditable) return true;
  const declared = element.getAttribute("contenteditable");
  return declared === "" || declared === "true" || declared === "plaintext-only";
}
function composing(event, target) {
  if (event.isComposing || event.keyCode === 229) return true;
  if (target.hasAttribute("data-composer-composing")) return true;
  const root = target.closest("[data-composer-input], [data-composer-card]");
  return root !== null && root.hasAttribute("data-composer-composing");
}
function supportsSyntheticInputType() {
  if (typeof InputEvent !== "function") return false;
  try {
    return new InputEvent("beforeinput", { inputType: INSERT_LINE_BREAK }).inputType === INSERT_LINE_BREAK;
  } catch {
    return false;
  }
}
function insertLineBreak(root) {
  if (supportsSyntheticInputType()) {
    root.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: INSERT_LINE_BREAK
      })
    );
    return;
  }
  if (typeof document.execCommand === "function") {
    try {
      document.execCommand(INSERT_LINE_BREAK);
    } catch {
    }
  }
}
function insertNewlineIntoTextarea(textarea) {
  try {
    if (document.execCommand(INSERT_LINE_BREAK)) return;
    if (document.execCommand("insertText", false, "\n")) return;
  } catch {
  }
  const { selectionStart, selectionEnd } = textarea;
  const next = `${textarea.value.slice(0, selectionStart)}
${textarea.value.slice(selectionEnd)}`;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === void 0) return;
  setter.call(textarea, next);
  const caret = selectionStart + 1;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: INSERT_LINE_BREAK, data: "\n" }));
}
function apply(ctx) {
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Enter") return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const card = target.closest(COMPOSER_CARD);
      if (card === null) return;
      if (card.querySelector(OPEN_POPUP) !== null) return;
      if (composing(event, target)) return;
      const textarea = target.closest(COMPOSER_TEXTAREA);
      if (textarea instanceof HTMLTextAreaElement) {
        if (textarea.readOnly || textarea.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        insertNewlineIntoTextarea(textarea);
        return;
      }
      if (!target.matches(COMPOSER_EDITABLE) || !isEditable(target)) return;
      event.preventDefault();
      event.stopPropagation();
      insertLineBreak(target);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, "dsh-enter-newline: composer enter policy");
}
return module.exports; } });
//# sourceMappingURL=client.js.map
