# CodeMirror 6 Markdown Editor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Markdown mode's native textarea text segments with CodeMirror 6 while preserving the canonical Markdown string, image-block behavior, shortcuts, preview, export, and mobile editing behavior.

**Architecture:** Add a focused `MarkdownCodeMirror` component that owns one CodeMirror `EditorView` per text segment. `EditorPanel` remains the owner of the full Markdown string, image blocks, absolute selection offsets, image operations, and drag/drop. CodeMirror documents are derived from `EditorTextBlock.text`; user transactions emit local text and selection changes upward, while parent-driven full-document edits synchronize with `addToHistory: false`.

**Tech Stack:** React 19, TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-markdown`), existing Markdown parser and editor-image helpers, Playwright-backed frontend feedback tests.

## Global Constraints

- Markdown remains the persisted source of truth; no workspace schema change.
- Do not change `splitEditorContent`, image URLs, image storage, rich-text mode, preview rendering, PNG export, archive, or WeChat rendering.
- Preserve existing Markdown shortcuts, image paste/drop/import, image caption/crop/delete/download, mobile layout, IME composition, and Cmd/Ctrl+S behavior.
- No TypeScript `any`; use named types and runtime guards at external boundaries.
- New behavioral verification uses the real browser surface; do not substitute source-text assertions for the browser smoke path.
- Keep the existing public `EditorPanelHandle` and parent callback signatures unless a narrower internal callback is required.

---

### Task 1: Add the Markdown CodeMirror component

**Files:**
- Create: `src/components/MarkdownCodeMirror.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes `EditorTextBlock.text`-compatible text, local selection offsets, read-only state, and parent callbacks.
- Produces a mounted CodeMirror editor element with Markdown language support and controlled document synchronization.

- [ ] **Step 1: Add the Markdown language dependency**

Run:

```bash
npm install @codemirror/lang-markdown
```

Expected: `package.json` and `package-lock.json` add `@codemirror/lang-markdown`; existing CodeMirror packages remain unchanged.

- [ ] **Step 2: Define the component contract**

Create the component with this exact internal contract:

```ts
export interface MarkdownCodeMirrorSelection {
  end: number;
  start: number;
}

export interface MarkdownCodeMirrorProps {
  ariaLabel: string;
  className?: string;
  readOnly?: boolean;
  selection?: MarkdownCodeMirrorSelection;
  text: string;
  onChange: (text: string, selection: MarkdownCodeMirrorSelection) => void;
  onKeyDown?: (event: KeyboardEvent, view: EditorView) => boolean;
  onPaste?: (event: ClipboardEvent, view: EditorView) => boolean;
  onSelect?: (selection: MarkdownCodeMirrorSelection) => void;
}
```

- [ ] **Step 3: Implement the CodeMirror lifecycle**

Use `useRef` for the host element and `EditorView`, then create the view in `useEffect` with:

```ts
history(),
markdown(),
EditorState.readOnly.of(readOnly),
EditorView.editable.of(!readOnly),
EditorView.lineWrapping,
keymap.of([...defaultKeymap, ...historyKeymap]),
EditorView.updateListener.of(update => { ... }),
```

The update listener must:

- Ignore updates marked with a private synchronization annotation.
- On `docChanged`, call `onChange(update.state.doc.toString(), localSelection(update.state))` exactly once.
- On `selectionSet` without `docChanged`, call `onSelect` if supplied.
- Never interrupt an active composition transaction.

Register `domEventHandlers` for `keydown` and `paste` only when the corresponding callback is supplied. If the callback returns `true`, prevent the browser default and stop further handling; otherwise return `false`.

- [ ] **Step 4: Implement parent-to-editor synchronization**

Add a `StateEffect` or `Annotation` named for synchronization. When `text !== view.state.doc.toString()`:

```ts
view.dispatch({
  changes: { from: 0, to: view.state.doc.length, insert: text },
  selection: toCodeMirrorSelection(selection, text.length),
  annotations: syncAnnotation.of(true),
});
```

Use `addToHistory: false` through the synchronization annotation/transaction filter so a parent-driven image insertion or full Markdown replacement does not create a duplicate undo entry or invoke `onChange`.

- [ ] **Step 5: Preserve focus and selection on cleanup**

On unmount, destroy the `EditorView`. Do not move focus from the parent. Use CodeMirror's `EditorSelection.cursor`/`EditorSelection.range` for local selection conversion and clamp all offsets to `[0, text.length]`.

- [ ] **Step 6: Add only the minimum CSS bridge**

Modify `src/styles.css` only if needed to make `.markdown-editor.editor-text-segment.cm-editor` preserve the existing paper typography, padding, line-height, overflow, and focus appearance. Do not change the surrounding image-block layout.

- [ ] **Step 7: Run the narrow typecheck**

Run:

```bash
npm run typecheck:app
```

Expected: PASS. If CodeMirror extension types fail, correct the component types before integrating it into `EditorPanel`.

---

### Task 2: Integrate CodeMirror into EditorPanel without changing Markdown semantics

**Files:**
- Modify: `src/components/EditorPanel.tsx:163-1672`
- Modify: `src/lib/markdown-shortcuts.ts` only if callback event typing requires it
- Modify: `src/lib/editor-images.ts` only if a selection mapping helper is needed

**Interfaces:**
- Consumes `MarkdownCodeMirror` from Task 1.
- Produces the same `EditorPanelProps`, `EditorPanelHandle`, `onMarkdownChange` calls, image behavior, and absolute selection semantics as before.

- [ ] **Step 1: Replace textarea refs with CodeMirror refs/state**

Replace the `Map<number, HTMLTextAreaElement>` used only for Markdown text segments with a `Map<number, EditorView>` or a ref callback owned by `MarkdownCodeMirror`. Keep caption input refs and image input refs unchanged.

Retain `selectionRef` as the absolute Markdown selection contract. Add helpers in `EditorPanel`:

```ts
function localSelectionForBlock(
  block: EditorTextBlock,
  selection: MarkdownSelection,
): MarkdownCodeMirrorSelection;

function absoluteSelectionForBlock(
  block: EditorTextBlock,
  selection: MarkdownCodeMirrorSelection,
): MarkdownSelection;
```

Both helpers must clamp offsets and account for `block.start`.

- [ ] **Step 2: Replace `handleTextBlockChange` with a CodeMirror callback**

Use the text block's start/end range to construct the next full Markdown string:

```ts
function handleTextBlockChange(
  block: EditorTextBlock,
  nextText: string,
  localSelection: MarkdownCodeMirrorSelection,
): void {
  const nextMarkdown = `${markdown.slice(0, block.start)}${nextText}${markdown.slice(block.end)}`;
  const selection = absoluteSelectionForBlock(block, localSelection);
  selectionRef.current = selection;
  onMarkdownChange(nextMarkdown);
  scheduleMobileCaretSync();
}
```

Do not call `setSelectionRange`, `focus`, or manually mutate a textarea because CodeMirror owns its selection.

- [ ] **Step 3: Adapt shortcut application and full-document edits**

Keep `handleMarkdownShortcut`, `commitMarkdownEdit`, `focusAfterImage`, and image replacement logic using absolute Markdown offsets. Change `focusGlobalSelection` so it finds the target text block's `MarkdownCodeMirror` view, focuses it, and dispatches a local CodeMirror selection instead of calling `HTMLTextAreaElement.setSelectionRange`.

When no target text block exists, preserve the existing fallback behavior: update `selectionRef` but do not throw.

- [ ] **Step 4: Move clipboard image handling to CodeMirror paste callbacks**

Pass an `onPaste` callback to each text-segment CodeMirror instance. It must reuse the existing `importFromClipboard` logic, but accept a native `ClipboardEvent` and prevent the event only when an image file or image URL is actually imported.

Keep outer `.markdown-editor-flow` drop handling unchanged. Keep image input and remote URL import functions unchanged.

- [ ] **Step 5: Preserve keyboard shortcuts and editor focus semantics**

Pass `onKeyDown` from `EditorPanel` to CodeMirror. Preserve:

- Markdown shortcut dispatch.
- Backspace/delete image selection behavior where it depends on the active image block.
- Cmd/Ctrl+S handling at the App level.
- Escape and overlay behavior.
- IME composition checks.

Do not duplicate the global save shortcut inside CodeMirror.

- [ ] **Step 6: Render CodeMirror text blocks and keep image blocks unchanged**

Replace only the `textarea` branch in the `editorContent.map` render with:

```tsx
<MarkdownCodeMirror
  ariaLabel={...}
  className={`markdown-editor editor-text-segment${isLast ? " is-last-text-segment" : ""}`}
  readOnly={readOnly}
  selection={localSelectionForBlock(block, selectionRef.current)}
  text={block.text}
  onChange={(text, selection) => handleTextBlockChange(block, text, selection)}
  onKeyDown={(event, view) => handleEditorKeyDown(event, block, blockIndex, view)}
  onPaste={(event, view) => handleMarkdownPaste(event, view)}
  onSelect={selection => handleTextSelection(block, selection)}
/>
```

Keep the image branch unchanged except for any selection/focus calls it makes into the new view map.

- [ ] **Step 7: Run existing editor feedback tests**

Run:

```bash
npm run test:frontend -- frontend/tests/editor-images.test.ts frontend/tests/editor-save-shortcut.test.ts frontend/tests/markdown-shortcuts.test.ts
```

Expected: PASS. If the project test script does not accept the file arguments, run the equivalent `node --import tsx --test` command for those files.

---

### Task 3: Add browser feedback for the Markdown CodeMirror surface

**Files:**
- Create: `frontend/tests/markdown-codemirror.test.ts`
- Modify: `frontend/tests/auth-ui.test.ts` only if an existing editor source assertion becomes stale

**Interfaces:**
- Consumes the built app and local mock API pattern from `frontend/tests/account-storage-isolation.test.ts`.
- Produces a real-browser regression for CodeMirror editing and Markdown behavior.

- [ ] **Step 1: Build a minimal real-browser fixture server**

Reuse the existing `dist` static serving pattern and mock only:

- `GET /api/auth/session` → anonymous `{ requireLogin: false, user: null }`.
- `GET /api/ai/status` → `{ available: false }`.
- `GET/PUT /api/workspace` → an in-memory valid workspace if the app requests it.

Skip the test when `dist/index.html` or Chromium is unavailable, matching `account-storage-isolation.test.ts`.

- [ ] **Step 2: Verify CodeMirror is mounted and editable**

Open the app at a desktop viewport and assert:

```ts
await page.locator(".markdown-editor .cm-editor").count() > 0;
await page.locator(".markdown-editor .cm-content").isVisible();
```

Fill or type Markdown through the CodeMirror content element, then assert the app state is reflected in the content and the existing preview toggle renders the Markdown output.

- [ ] **Step 3: Verify Markdown shortcuts and selection preservation**

Use real keyboard input to select text, invoke the existing bold shortcut, and assert the CodeMirror document contains `**...**`. Click the preview toggle and assert the rendered output contains the expected text without exposing the textarea-only editor.

- [ ] **Step 4: Verify full-document image insertion remains compatible**

Use the existing image import endpoint mock or a local fixture image, trigger insertion through the existing UI, and assert the CodeMirror text contains the image Markdown while the image block remains present in the editor flow. Do not inspect private React state.

- [ ] **Step 5: Run the browser regression**

Run:

```bash
npm run build
node --import tsx --test frontend/tests/markdown-codemirror.test.ts
```

Expected: PASS with a real Chromium instance.

---

### Task 4: Update dependencies, docs, and verification artifacts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `DOCS/architecture.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes the completed editor integration and browser test.
- Produces documented Markdown editor behavior and a reproducible dependency lockfile.

- [ ] **Step 1: Document the editor boundary**

Update `DOCS/architecture.md` to state that Markdown mode uses CodeMirror 6 for source editing, while `MarkdownText`/`NoteSheet` remain the rendering/export chain and rich-text mode remains separate. State that Markdown remains canonical and image blocks remain managed by `EditorPanel`.

- [ ] **Step 2: Add the user-visible changelog entry**

Add an unreleased entry to `CHANGELOG.md` under the existing `[未发布]` section:

```md
- Markdown 模式改用 CodeMirror 6，保留现有图片块、快捷键、实时预览与 Markdown 数据格式。
```

- [ ] **Step 3: Verify dependency lock consistency**

Run:

```bash
npm install --package-lock-only
npm audit --omit=dev
```

Expected: lockfile is consistent and production audit has no new vulnerability.

- [ ] **Step 4: Run the full verification set**

Run:

```bash
npm run typecheck
npm test
npm run fnos:test
npm run build
```

Expected:

- Typecheck passes for app, server, and feedback tests.
- Frontend, backend, and DSH feedback tests pass.
- Native tests pass.
- Production build passes.

- [ ] **Step 5: Run local browser smoke verification**

Start:

```bash
npm run dev
```

Open `http://127.0.0.1:15173/` in a real browser and verify Markdown typing, preview toggle, shortcut formatting, image import, mobile editor scroll, and Cmd/Ctrl+S. Capture any console errors before marking the task complete.

- [ ] **Step 6: Commit the migration**

```bash
git add package.json package-lock.json src/components/MarkdownCodeMirror.tsx src/components/EditorPanel.tsx src/styles.css frontend/tests/markdown-codemirror.test.ts DOCS/architecture.md CHANGELOG.md
git commit -m "feat: use CodeMirror for Markdown editing"
```
