# CodeMirror 6 Markdown Editor Design

**Date:** 2026-11-25

## Goal

Replace the Markdown mode's native textarea text segments with CodeMirror 6 while preserving the existing Markdown string as the source of truth, image-block interactions, mobile behavior, Markdown shortcuts, preview, export, archive, and WeChat output.

## Scope

Included:

- CodeMirror 6 editing for every text segment in `EditorPanel`.
- Markdown syntax highlighting through `@codemirror/lang-markdown`.
- Existing selection, replacement, shortcut, paste, drag/drop, and image insertion behavior routed through CodeMirror state and dispatch APIs.
- Read-only mode, composition/IME input, undo/redo, and keyboard save behavior.
- Preservation of the current `splitEditorContent()` model: text segments alternate with image blocks.

Excluded:

- WYSIWYG Markdown editing.
- Milkdown, BlockNote, Lexical, or ProseMirror migration.
- Rich-text mode changes; `RichTextEditor` remains the existing CodeMirror-based implementation.
- Markdown parser, storage schema, preview renderer, PNG export, archive, and WeChat renderer changes.

## Architecture

`EditorPanel` remains the owner of image blocks, selection mapping, drag/drop, captions, crop/delete actions, and the overall Markdown string. Each text block gets one CodeMirror `EditorView` mounted in the existing text-segment position. The parent keeps the canonical `markdown` string; CodeMirror documents are derived from `EditorTextBlock.text` and write changes upward through `onMarkdownChange`.

A text-block view must be recreated when its block identity or source range changes. Normal typing uses `EditorView.dispatch` and emits one combined Markdown update. When an image operation or Markdown shortcut changes the full document, the parent updates `markdown`, CodeMirror views receive the new segment text through a controlled synchronization effect, and the selection is restored using the existing absolute Markdown offsets.

## Interfaces

Create a focused internal component in `src/components/MarkdownCodeMirror.tsx`:

```ts
interface MarkdownCodeMirrorProps {
  ariaLabel: string;
  className?: string;
  initialSelection?: { end: number; start: number };
  readOnly?: boolean;
  text: string;
  onChange: (text: string, selection: { end: number; start: number }) => void;
  onSelect?: (selection: { end: number; start: number }) => void;
  onKeyDown?: (event: KeyboardEvent, view: EditorView) => boolean;
  onPaste?: (event: ClipboardEvent, view: EditorView) => boolean;
  onFocus?: () => void;
}
```

The component owns only the CodeMirror view lifecycle and local-to-segment selection. It must not own Markdown parsing, image blocks, persistence, or application state.

`EditorPanel` keeps these responsibilities:

- Convert absolute Markdown offsets to local text-block offsets.
- Convert CodeMirror local selections back to absolute offsets.
- Apply Markdown shortcuts against the canonical full string.
- Insert, replace, move, caption, crop, download, and delete images.
- Handle drag/drop and clipboard image imports.
- Restore focus and selection after full-document changes.

## CodeMirror extensions

Use the existing packages plus `@codemirror/lang-markdown`:

- `EditorState.readOnly.of(readOnly)`.
- `EditorView.editable.of(!readOnly)`.
- `EditorView.lineWrapping`.
- Markdown language support from `@codemirror/lang-markdown`.
- `history()` and the existing default/history keymaps.
- A small `updateListener` to emit text and selection changes.
- `EditorView.domEventHandlers` for image clipboard handling and the existing editor-level drag/drop behavior where the event is not already handled by the outer frame.

Use the existing CSS class `markdown-editor editor-text-segment` on the CodeMirror mount element so the current paper layout remains unchanged. Add only the minimum `.cm-editor`/`.cm-content` rules required to preserve the existing font, padding, line height, white-space, focus outline, and mobile scrolling behavior.

## Selection and synchronization invariants

1. The canonical full `markdown` string remains the only persisted value.
2. A CodeMirror document equals its current `EditorTextBlock.text` after every parent render.
3. A local selection is translated by `block.start` before calling `onMarkdownChange`.
4. A full-document edit invalidates old local selections; the existing absolute selection restoration path is used.
5. Programmatic synchronization dispatches with `addToHistory: false` and does not emit a duplicate `onChange`.
6. User edits dispatch normally and emit exactly one parent change.
7. Read-only mode blocks CodeMirror edits and image mutations through the existing `readOnly`/editable guards.
8. IME composition is not interrupted by parent synchronization or shortcut handling.

## Image and clipboard behavior

The existing image-block parser and DOM remain. Text segments no longer use textarea events, so image clipboard handling moves to CodeMirror's `domEventHandlers` for the active text segment. The outer `.markdown-editor-flow` continues to handle file/url drop events. Image insertion calls the existing `insertImageMarkdown()` path, which updates the canonical Markdown and restores the absolute cursor after CodeMirror views synchronize.

## Testing and verification

- Preserve and update existing frontend feedback assertions for Markdown mode and editor controls.
- Add behavioral coverage for the CodeMirror component's text change, selection translation, read-only state, programmatic synchronization, and Markdown language mount.
- Run `npm run typecheck`.
- Run `npm run test:frontend` and the full `npm test` suite.
- Run `npm run build`.
- Start `npm run dev` and use a real browser to verify:
  - Markdown typing and cursor movement;
  - Chinese IME input;
  - Markdown shortcuts;
  - image paste/drop/import and image deletion;
  - switching Markdown/preview/rich-text modes;
  - mobile editor scrolling;
  - Cmd/Ctrl+S behavior.

## Risks and rollback

The main risk is selection/focus drift when the parent splits Markdown around image blocks. Keep the old `EditorPanel` implementation in the same commit until the CodeMirror component passes browser verification; rollback is then a single component-level revert. Do not alter persisted Markdown or rich-text conversion during this migration.
