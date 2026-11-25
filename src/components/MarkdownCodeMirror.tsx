import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorSelection, EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";

export interface MarkdownCodeMirrorSelection {
  end: number;
  start: number;
}

export interface MarkdownCodeMirrorProps {
  ariaLabel: string;
  className?: string;
  onBlur?: () => void;
  onChange: (
    text: string,
    selection: MarkdownCodeMirrorSelection,
  ) => void;
  onCompositionEnd?: () => void;
  onCompositionStart?: () => void;
  onFocus?: () => void;
  onKeyDown?: (event: globalThis.KeyboardEvent, view: EditorView) => boolean;
  onPaste?: (event: globalThis.ClipboardEvent, view: EditorView) => boolean;
  onSelect?: (selection: MarkdownCodeMirrorSelection) => void;
  onViewReady?: (view: EditorView | null) => void;
  readOnly?: boolean;
  selection?: MarkdownCodeMirrorSelection;
  text: string;
}

const synchronizeDocument = Annotation.define<boolean>();
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-md-heading1" },
  { tag: tags.heading2, class: "cm-md-heading2" },
  { tag: tags.heading3, class: "cm-md-heading3" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-em" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.processingInstruction, class: "cm-md-meta" },
]);

function clampOffset(value: number, length: number): number {
  return Math.max(0, Math.min(length, value));
}

function toEditorSelection(
  selection: MarkdownCodeMirrorSelection | undefined,
  length: number,
): EditorSelection {
  const start = clampOffset(selection?.start ?? length, length);
  const end = clampOffset(selection?.end ?? start, length);

  return EditorSelection.single(start, Math.max(start, end));
}

function readSelection(view: EditorView): MarkdownCodeMirrorSelection {
  const selection = view.state.selection.main;

  return {
    end: selection.to,
    start: selection.from,
  };
}

export function MarkdownCodeMirror({
  onBlur,
  ariaLabel,
  className,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onKeyDown,
  onPaste,
  onSelect,
  onViewReady,
  readOnly = false,
  selection,
  text,
}: MarkdownCodeMirrorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const blurHandlerRef = useRef(onBlur);
  const viewRef = useRef<EditorView | null>(null);
  const changeHandlerRef = useRef(onChange);
  const compositionStartRef = useRef(onCompositionStart);
  const compositionEndRef = useRef(onCompositionEnd);
  const focusHandlerRef = useRef(onFocus);
  const keyDownHandlerRef = useRef(onKeyDown);
  const pasteHandlerRef = useRef(onPaste);
  const selectHandlerRef = useRef(onSelect);
  const viewReadyHandlerRef = useRef(onViewReady);

  changeHandlerRef.current = onChange;
  blurHandlerRef.current = onBlur;
  compositionEndRef.current = onCompositionEnd;
  focusHandlerRef.current = onFocus;
  keyDownHandlerRef.current = onKeyDown;
  pasteHandlerRef.current = onPaste;
  selectHandlerRef.current = onSelect;
  viewReadyHandlerRef.current = onViewReady;

  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        selection: toEditorSelection(selection, text.length),
        extensions: [
          history(),
          markdown(),
          syntaxHighlighting(markdownHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.domEventHandlers({
            compositionend: () => {
              compositionEndRef.current?.();
              return false;
            },
            compositionstart: () => {
              compositionStartRef.current?.();
              return false;
            },
            focus: () => {
              focusHandlerRef.current?.();
              return false;
            },
            blur: () => {
              blurHandlerRef.current?.();
              return false;
            },
            keydown: (event, currentView) =>
              keyDownHandlerRef.current?.(event, currentView) ?? false,
            paste: (event, currentView) =>
              pasteHandlerRef.current?.(event, currentView) ?? false,
          }),
          EditorView.updateListener.of((update) => {
            const isSynchronized = update.transactions.some((transaction) =>
              transaction.annotation(synchronizeDocument),
            );

            if (isSynchronized) {
              return;
            }

            if (update.docChanged) {
              changeHandlerRef.current(
                update.state.doc.toString(),
                readSelection(update.view),
              );
              return;
            }

            if (update.selectionSet && update.view.hasFocus) {
              selectHandlerRef.current?.(readSelection(update.view));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    viewReadyHandlerRef.current?.(view);

    return () => {
      viewReadyHandlerRef.current?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [ariaLabel, readOnly]);

  useEffect(() => {
    const view = viewRef.current;

    if (!view) {
      return;
    }

    const currentText = view.state.doc.toString();
    const nextSelection = toEditorSelection(selection, text.length);
    const currentSelection = view.state.selection;
    // 多段编辑器中只有当前聚焦的文本段拥有全局选区。未聚焦的段不能因为
    // 父组件把全局偏移钳制到本段端点而反过来覆盖 selectionRef。
    const selectionChanged =
      view.hasFocus &&
      (currentSelection.main.from !== nextSelection.main.from ||
        currentSelection.main.to !== nextSelection.main.to);

    if (currentText === text && !selectionChanged) {
      return;
    }

    view.dispatch({
      annotations: synchronizeDocument.of(true),
      changes:
        currentText === text
          ? undefined
          : { from: 0, insert: text, to: currentText.length },
      ...(selectionChanged ? { selection: nextSelection } : {}),
    });
  }, [selection, text]);

  return <div ref={hostRef} className={className} />;
}
