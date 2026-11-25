import { appPath } from "../lib/fnos-client.js";
import {
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import {
  MarkdownCodeMirror,
  type MarkdownCodeMirrorSelection,
} from "./MarkdownCodeMirror";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImageCropDialog } from "./ImageCropDialog";
import { importImageFile, importImageUrl } from "../lib/images";
import {
  isLikelyImageUrl,
  moveEditorImage,
  replaceEditorImageAlt,
  replaceEditorImageSource,
  splitEditorContent,
  type EditorImageBlock,
  type EditorTextBlock,
} from "../lib/editor-images";
import {
  applyMarkdownShortcut,
  continueMarkdownBlock,
  type MarkdownEditResult,
  type MarkdownShortcut,
} from "../lib/markdown-shortcuts";

interface EditorPanelProps {
  readOnly?: boolean;
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  onImageImportingChange: (isImporting: boolean) => void;
}

export interface EditorPanelHandle {
  openImagePicker: () => void;
}

const MARKDOWN_SHORTCUTS: Array<{
  action: MarkdownShortcut;
  label: string;
  accessibleLabel: string;
}> = [
  // 与官方移动端一致：Markdown 模式下这条工具栏显示语法本身。
  { action: "title", label: "# 标题", accessibleLabel: "切换当前行标题级别" },
  { action: "center", label: "[ 居中 ]", accessibleLabel: "居中当前行" },
  { action: "list", label: "- 列表", accessibleLabel: "将当前行设为列表" },
  { action: "todo", label: "- [ ] 待办", accessibleLabel: "将当前行设为待办事项" },
  {
    action: "bold",
    label: "**粗体**",
    accessibleLabel: "插入加粗标记或加粗所选文字",
  },
  { action: "quote", label: "> 引用", accessibleLabel: "将当前行设为引用" },
  { action: "strike", label: "~~删除线~~", accessibleLabel: "给所选文字加删除线" },
  { action: "code", label: "`代码`", accessibleLabel: "设置行内代码" },
  { action: "hr", label: "— 分隔线", accessibleLabel: "插入分隔线" },
  { action: "clear", label: "清除格式", accessibleLabel: "清除当前选区格式" },
];

const MOBILE_MARKDOWN_PRIMARY_ACTIONS: MarkdownShortcut[] = [
  "title",
  "center",
  "list",
  "bold",
  "quote",
];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function findImageUrlFromHtml(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const image = doc.querySelector("img");
  const src = image?.getAttribute("src")?.trim();

  if (!src || !isHttpUrl(src)) {
    return null;
  }

  return src;
}

function extractImageFile(files: FileList | File[]): File | null {
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) {
      return file;
    }
  }

  return null;
}

function getEditorImageKey(image: EditorImageBlock): string {
  return `${image.markerStart}:${image.source}`;
}


export const EditorPanel = forwardRef<EditorPanelHandle, EditorPanelProps>(function EditorPanel(
  {
    markdown,
    readOnly = false,
    onMarkdownChange,
    onImageImportingChange,
  },
  ref,
) {
  const editorFrameRef = useRef<HTMLDivElement | null>(null);
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const editorRefs = useRef(new Map<number, EditorView>());
  const captionInputRefs = useRef(new Map<string, HTMLInputElement>());
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imageDragCleanupRef = useRef<(() => void) | null>(null);
  const isComposingRef = useRef(false);
  const keyboardBaselineHeightRef = useRef<number | null>(null);
  const selectionRef = useRef({
    start: markdown.length,
    end: markdown.length,
  });
  const [isImportingImage, setIsImportingImage] = useState(false);
  const [imageImportError, setImageImportError] = useState("");
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [isQuickInputVisible, setIsQuickInputVisible] = useState(false);
  const [isMarkdownMoreOpen, setIsMarkdownMoreOpen] = useState(false);
  const [activeImageKey, setActiveImageKey] = useState<string | null>(null);
  const [captionImageKey, setCaptionImageKey] = useState<string | null>(null);
  const [pendingImageDeletion, setPendingImageDeletion] = useState<{
    focusOffset: number;
    imageKey: string;
  } | null>(null);
  const [draggingImageKey, setDraggingImageKey] = useState<string | null>(null);
  const [imageDropIndicatorTop, setImageDropIndicatorTop] = useState<number | null>(
    null,
  );
  const [previewImage, setPreviewImage] = useState<{
    alt: string;
    source: string;
  } | null>(null);
  const [cropSession, setCropSession] = useState<{
    alt: string;
    imageKey: string;
    source: string;
  } | null>(null);
  const editorContent = useMemo(
    () => splitEditorContent(markdown),
    [markdown],
  );
  const primaryMarkdownShortcuts = MARKDOWN_SHORTCUTS.filter((shortcut) =>
    MOBILE_MARKDOWN_PRIMARY_ACTIONS.includes(shortcut.action),
  );
  const advancedMarkdownShortcuts = MARKDOWN_SHORTCUTS.filter(
    (shortcut) => !MOBILE_MARKDOWN_PRIMARY_ACTIONS.includes(shortcut.action),
  );
  function localSelectionForBlock(
    block: EditorTextBlock,
  ): MarkdownCodeMirrorSelection {
    return {
      start: Math.max(0, Math.min(block.text.length, selectionRef.current.start - block.start)),
      end: Math.max(0, Math.min(block.text.length, selectionRef.current.end - block.start)),
    };
  }

  function absoluteSelectionForBlock(
    block: EditorTextBlock,
    selection: MarkdownCodeMirrorSelection,
  ): { end: number; start: number } {
    const start = Math.max(0, Math.min(block.text.length, selection.start));
    const end = Math.max(start, Math.min(block.text.length, selection.end));
    return { end: block.start + end, start: block.start + start };
  }

  function getEditorView(blockIndex: number): EditorView | null {
    return editorRefs.current.get(blockIndex) ?? null;
  }


  function updateBlockSelection(
    block: EditorTextBlock,
    selection: MarkdownCodeMirrorSelection,
  ): void {
    selectionRef.current = absoluteSelectionForBlock(block, selection);
  }


  useEffect(() => {
    const imageKeys = new Set(
      editorContent
        .filter((block): block is EditorImageBlock => block.kind === "image")
        .map(getEditorImageKey),
    );

    if (activeImageKey && !imageKeys.has(activeImageKey)) {
      setActiveImageKey(null);
    }

    if (captionImageKey && !imageKeys.has(captionImageKey)) {
      setCaptionImageKey(null);
    }

    if (
      pendingImageDeletion &&
      !imageKeys.has(pendingImageDeletion.imageKey)
    ) {
      setPendingImageDeletion(null);
    }
  }, [
    activeImageKey,
    captionImageKey,
    editorContent,
    pendingImageDeletion,
  ]);

  useEffect(
    () => () => {
      imageDragCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!previewImage) {
      return;
    }

    const handlePreviewKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreviewImage(null);
      }
    };

    window.addEventListener("keydown", handlePreviewKeyDown);
    return () => window.removeEventListener("keydown", handlePreviewKeyDown);
  }, [previewImage]);

  useImperativeHandle(
    ref,
    () => ({
      openImagePicker: () => {
        imageInputRef.current?.click();
      },
    }),
    [],
  );


  const syncEditorPaperScroll = useCallback((): void => {
    const scroller = editorScrollRef.current;

    if (scroller) {
      editorFrameRef.current?.style.setProperty(
        "--editor-paper-scroll-y",
        `${-scroller.scrollTop}px`,
      );
    }
  }, []);

  useEffect(() => {
    syncEditorPaperScroll();
  }, [markdown, syncEditorPaperScroll]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 640px)");
    const viewport = window.visualViewport;

    const getViewportHeight = (): number =>
      Math.max(1, viewport?.height ?? window.innerHeight);

    const syncQuickInputVisibility = (): void => {
      if (!mobileQuery.matches) {
        keyboardBaselineHeightRef.current = null;
        setIsQuickInputVisible(false);
        return;
      }

      const viewportHeight = getViewportHeight();
      const isEditorFocused = Boolean(
        document.activeElement?.closest(".markdown-editor"),
      );

      if (!isEditorFocused) {
        keyboardBaselineHeightRef.current = viewportHeight;
        setIsQuickInputVisible(false);
        return;
      }

      const baselineHeight = Math.max(
        keyboardBaselineHeightRef.current ?? viewportHeight,
        viewportHeight,
      );
      keyboardBaselineHeightRef.current = baselineHeight;

      if (baselineHeight - viewportHeight > 80) {
        setIsQuickInputVisible(true);
        return;
      }

      setIsQuickInputVisible(false);
    };

    keyboardBaselineHeightRef.current = getViewportHeight();
    mobileQuery.addEventListener("change", syncQuickInputVisibility);
    viewport?.addEventListener("resize", syncQuickInputVisibility);
    window.addEventListener("resize", syncQuickInputVisibility);
    window.addEventListener("orientationchange", syncQuickInputVisibility);

    return () => {
      mobileQuery.removeEventListener("change", syncQuickInputVisibility);
      viewport?.removeEventListener("resize", syncQuickInputVisibility);
      window.removeEventListener("resize", syncQuickInputVisibility);
      window.removeEventListener("orientationchange", syncQuickInputVisibility);
    };
  }, []);

  const resizeEditorContent = useCallback((): void => {
    const scroller = editorScrollRef.current;

    if (!scroller || scroller.clientWidth === 0) {
      return;
    }

    const scrollTop = scroller.scrollTop;

    for (const view of editorRefs.current.values()) {
      view.requestMeasure();
    }

    for (const imageBlock of scroller.querySelectorAll<HTMLElement>(
      ".editor-image-block",
    )) {
      snapImageBlockToLineGrid(imageBlock);
    }

    scroller.scrollTop = scrollTop;
    editorFrameRef.current?.style.setProperty(
      "--editor-paper-scroll-y",
      `${-scroller.scrollTop}px`,
    );
  }, [editorContent]);

  useLayoutEffect(() => {
    resizeEditorContent();
    const animationFrame = window.requestAnimationFrame(resizeEditorContent);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [resizeEditorContent]);

  useEffect(() => {
    const scroller = editorScrollRef.current;

    if (!scroller) {
      return;
    }

    let animationFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      resizeEditorContent();
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(resizeEditorContent);
    });

    resizeObserver.observe(scroller);
    window.addEventListener("resize", resizeEditorContent);

    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resizeEditorContent);
    };
  }, [resizeEditorContent]);

  useEffect(() => {
    const syncImageGrid = (): void => {
      for (const imageBlock of editorScrollRef.current?.querySelectorAll<HTMLElement>(
        ".editor-image-block",
      ) ?? []) {
        snapImageBlockToLineGrid(imageBlock);
      }
    };

    window.addEventListener("resize", syncImageGrid);

    return () => {
      window.removeEventListener("resize", syncImageGrid);
    };
  }, [editorContent]);

  function snapImageBlockToLineGrid(imageBlock: HTMLElement | null): void {
    if (!imageBlock) {
      return;
    }

    imageBlock.style.setProperty("--editor-image-grid-spacer", "0px");
    const computedStyle = getComputedStyle(imageBlock);
    const lineHeight =
      Number.parseFloat(
        computedStyle.getPropertyValue("--editor-line-height"),
      ) || 42;
    const occupiedHeight =
      imageBlock.getBoundingClientRect().height +
      Number.parseFloat(computedStyle.marginTop) +
      Number.parseFloat(computedStyle.marginBottom);
    const remainder = occupiedHeight % lineHeight;
    const spacer =
      remainder < 0.25 || lineHeight - remainder < 0.25
        ? 0
        : lineHeight - remainder;

    imageBlock.style.setProperty(
      "--editor-image-grid-spacer",
      `${spacer}px`,
    );
  }

  function syncSelection(): void {
    const activeElement = document.activeElement?.closest(".cm-editor");

    if (!activeElement) {
      return;
    }

    for (const [blockIndex, view] of editorRefs.current) {
      if (view.dom !== activeElement && !view.dom.contains(activeElement)) {
        continue;
      }

      const block = editorContent[blockIndex];
      if (!block || block.kind !== "text") {
        return;
      }

      const selection = view.state.selection.main;
      updateBlockSelection(block, { end: selection.to, start: selection.from });
      return;
    }
  }

  function focusGlobalSelection(
    nextMarkdown: string,
    selectionStart: number,
    selectionEnd = selectionStart,
  ): void {
    const nextContent = splitEditorContent(nextMarkdown);
    let targetBlockIndex = nextContent.findIndex(
      (block) =>
        block.kind === "text" &&
        selectionStart >= block.start &&
        selectionStart <= block.end,
    );

    if (targetBlockIndex < 0) {
      for (let index = nextContent.length - 1; index >= 0; index -= 1) {
        if (nextContent[index]?.kind === "text") {
          targetBlockIndex = index;
          break;
        }
      }
    }

    const targetBlock = nextContent[targetBlockIndex];

    if (!targetBlock || targetBlock.kind !== "text") {
      return;
    }

    const localStart = Math.max(
      0,
      Math.min(targetBlock.text.length, selectionStart - targetBlock.start),
    );
    const localEnd = Math.max(
      localStart,
      Math.min(targetBlock.text.length, selectionEnd - targetBlock.start),
    );

    window.requestAnimationFrame(() => {
      const view = getEditorView(targetBlockIndex);

      if (!view) {
        return;
      }

      view.dispatch({
        effects: EditorView.scrollIntoView(localStart, { y: "nearest" }),
      });
    });
  }

  function commitMarkdownEdit(edit: MarkdownEditResult): void {
    if (edit.markdown !== markdown) {
      onMarkdownChange(edit.markdown);
    }

    selectionRef.current = {
      start: edit.selectionStart,
      end: edit.selectionEnd,
    };
    focusGlobalSelection(
      edit.markdown,
      edit.selectionStart,
      edit.selectionEnd,
    );
  }

  function handleMarkdownShortcut(shortcut: MarkdownShortcut): void {
    syncSelection();
    const { start: selectionStart, end: selectionEnd } = selectionRef.current;

    commitMarkdownEdit(
      applyMarkdownShortcut(markdown, selectionStart, selectionEnd, shortcut),
    );
  }

  function focusAfterImage(markerEnd: number): void {
    selectionRef.current = {
      end: markerEnd,
      start: markerEnd,
    };
    focusGlobalSelection(markdown, markerEnd);
  }

  function removeAdjacentImage(
    markerStart: number,
    markerEnd: number,
  ): void {
    const nextMarkdown = `${markdown.slice(0, markerStart)}${markdown.slice(
      markerEnd,
    )}`;

    onMarkdownChange(nextMarkdown);
    setActiveImageKey(null);
    setCaptionImageKey(null);
    selectionRef.current = {
      end: markerStart,
      start: markerStart,
    };
    focusGlobalSelection(nextMarkdown, markerStart);
  }

  function requestImageDeletion(
    image: EditorImageBlock,
    focusOffset: number,
  ): void {
    const imageKey = getEditorImageKey(image);

    if (activeImageKey !== imageKey) {
      setCaptionImageKey(null);
      setActiveImageKey(imageKey);
      return;
    }

    setPendingImageDeletion({ focusOffset, imageKey });
  }

  function closeImageDeletionConfirmation(): void {
    const focusOffset = pendingImageDeletion?.focusOffset;
    setPendingImageDeletion(null);

    if (focusOffset !== undefined) {
      focusGlobalSelection(markdown, focusOffset);
    }
  }

  function confirmImageDeletion(): void {
    const image = editorContent.find(
      (block): block is EditorImageBlock =>
        block.kind === "image" &&
        getEditorImageKey(block) === pendingImageDeletion?.imageKey,
    );

    setPendingImageDeletion(null);

    if (image) {
      removeAdjacentImage(image.markerStart, image.markerEnd);
    }
  }

  function updateImageAlt(image: EditorImageBlock, nextAlt: string): void {
    const nextMarkdown = replaceEditorImageAlt(markdown, image, nextAlt);

    if (nextMarkdown !== markdown) {
      onMarkdownChange(nextMarkdown);
    }
  }

  function openImageCaption(image: EditorImageBlock): void {
    const imageKey = getEditorImageKey(image);
    setActiveImageKey(null);
    setCaptionImageKey(imageKey);
    window.requestAnimationFrame(() => {
      const input = captionInputRefs.current.get(imageKey);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
      input?.scrollIntoView({ block: "nearest" });
      snapImageBlockToLineGrid(
        input?.closest<HTMLElement>(".editor-image-block") ?? null,
      );
    });
  }

  async function downloadEditorImage(image: EditorImageBlock): Promise<void> {
    const fallbackName = image.alt.trim() || "note-image";

    try {
      const response = await fetch(image.source);

      if (!response.ok) {
        throw new Error(`图片下载失败（${response.status}）`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${fallbackName.replace(/[\\/:*?"<>|]/g, "-")}.${extension}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setImageImportError("");
    } catch (error) {
      const anchor = document.createElement("a");
      anchor.href = image.source;
      anchor.download = fallbackName;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setImageImportError(
        error instanceof Error
          ? `${error.message}，已在新窗口打开原图。`
          : "图片下载失败，已在新窗口打开原图。",
      );
    }
  }

  async function openImageCrop(image: EditorImageBlock): Promise<void> {
    try {
      setActiveImageKey(null);
      setIsImportingImage(true);
      onImageImportingChange(true);
      setImageImportError("");
      const imageUrl = new URL(image.source, window.location.href);
      let cropSource = imageUrl.href;

      if (
        (imageUrl.protocol === "http:" || imageUrl.protocol === "https:") &&
        imageUrl.origin !== window.location.origin
      ) {
        const imported = await importImageUrl(image.source);
        cropSource = new URL(
          imported.path || imported.url,
          window.location.href,
        ).href;
      }

      setCropSession({
        alt: image.alt,
        imageKey: getEditorImageKey(image),
        source: cropSource,
      });
    } catch (error) {
      setImageImportError(
        error instanceof Error ? error.message : "无法打开图片裁剪。",
      );
    } finally {
      setIsImportingImage(false);
      onImageImportingChange(false);
    }
  }

  async function saveCroppedImage(file: File): Promise<void> {
    const session = cropSession;
    const currentImage = editorContent.find(
      (block): block is EditorImageBlock =>
        block.kind === "image" && getEditorImageKey(block) === session?.imageKey,
    );

    if (!session || !currentImage) {
      throw new Error("图片内容已变化，请重新打开裁剪。");
    }

    try {
      setIsImportingImage(true);
      onImageImportingChange(true);
      setImageImportError("");
      const imported = await importImageFile(file);
      const nextMarkdown = replaceEditorImageSource(
        markdown,
        currentImage,
        imported.path || imported.url,
      );

      if (nextMarkdown === markdown) {
        throw new Error("裁剪后的图片无法替换原图。");
      }

      onMarkdownChange(nextMarkdown);
      setCropSession(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片裁剪失败。";
      setImageImportError(message);
      throw new Error(message);
    } finally {
      setIsImportingImage(false);
      onImageImportingChange(false);
    }
  }

  function getImageDropTargets(): Array<{ offset: number; y: number }> {
    const targets: Array<{ offset: number; y: number }> = [];

    for (const [blockIndex, view] of editorRefs.current) {
      const block = editorContent[blockIndex];

      if (!block || block.kind !== "text") {
        continue;
      }

      const lineHeight = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 42;

      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        const coords = view.coordsAtPos(line.from);

        if (coords) {
          targets.push({
            offset: block.start + line.from,
            y: coords.top + lineHeight / 2,
          });
        }
      }
    }

    return targets;
  }

  function beginImageDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    image: EditorImageBlock,
  ): void {
    if (event.button !== 0) {
      return;
    }

    const flow = editorScrollRef.current;

    if (!flow) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let hasMoved = false;
    let targetOffset: number | null = null;

    const cleanup = (): void => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      imageDragCleanupRef.current = null;
      setDraggingImageKey(null);
      setImageDropIndicatorTop(null);
    };

    const handlePointerMove = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) {
        return;
      }

      if (!hasMoved && Math.abs(pointerEvent.clientY - startY) < 6) {
        return;
      }

      hasMoved = true;
      pointerEvent.preventDefault();
      setActiveImageKey(null);
      setDraggingImageKey(getEditorImageKey(image));

      const flowRect = flow.getBoundingClientRect();
      const edgeSize = Math.min(72, flowRect.height * 0.16);

      if (pointerEvent.clientY < flowRect.top + edgeSize) {
        flow.scrollTop -= 18;
      } else if (pointerEvent.clientY > flowRect.bottom - edgeSize) {
        flow.scrollTop += 18;
      }

      const targets = getImageDropTargets();
      const nearest = targets.reduce<
        { offset: number; y: number } | undefined
      >((current, candidate) =>
        !current ||
        Math.abs(candidate.y - pointerEvent.clientY) <
          Math.abs(current.y - pointerEvent.clientY)
          ? candidate
          : current,
      undefined);

      if (!nearest) {
        return;
      }

      targetOffset = nearest.offset;
      setImageDropIndicatorTop(
        nearest.y - flowRect.top + flow.scrollTop - 1,
      );
      syncEditorPaperScroll();
    };

    const handlePointerUp = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) {
        return;
      }

      cleanup();

      if (!hasMoved || targetOffset === null) {
        focusAfterImage(image.markerEnd);
        return;
      }

      const nextMarkdown = moveEditorImage(markdown, image, targetOffset);

      if (nextMarkdown !== markdown) {
        onMarkdownChange(nextMarkdown);
      }
    };

    imageDragCleanupRef.current?.();
    imageDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  function handleEditorKeyDown(
    event: globalThis.KeyboardEvent,
    view: EditorView,
    block: EditorTextBlock,
    blockIndex: number,
  ): boolean {
    const selectionStart = view.state.selection.main.from;
    const selectionEnd = view.state.selection.main.to;
    const previousBlock = editorContent[blockIndex - 1];
    const nextBlock = editorContent[blockIndex + 1];

    if (
      event.key === "Backspace" &&
      selectionStart === 0 &&
      selectionEnd === 0 &&
      previousBlock?.kind === "image"
    ) {
      event.preventDefault();
      requestImageDeletion(previousBlock, block.start);
      return true;
    }

    if (
      event.key === "Delete" &&
      selectionStart === block.text.length &&
      selectionEnd === block.text.length &&
      nextBlock?.kind === "image"
    ) {
      event.preventDefault();
      requestImageDeletion(nextBlock, block.end);
      return true;
    }

    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isComposingRef.current
    ) {
      return false;
    }

    const edit = continueMarkdownBlock(
      markdown,
      block.start + selectionStart,
      block.start + selectionEnd,
    );

    if (!edit) {
      return false;
    }

    event.preventDefault();
    commitMarkdownEdit(edit);
    return true;
  }

  function insertImageMarkdown(imageUrl: string): void {
    syncSelection();
    const selectionStart = selectionRef.current.start;
    const selectionEnd = selectionRef.current.end;
    const before = markdown.slice(0, selectionStart);
    const after = markdown.slice(selectionEnd);
    const imageMarkdown = `![](${imageUrl})`;
    const leadingBreak = before && !before.endsWith("\n") ? "\n" : "";
    const trailingBreak = after && !after.startsWith("\n") ? "\n" : "";
    const inserted = `${leadingBreak}${imageMarkdown}${trailingBreak}`;
    const nextMarkdown = `${before}${inserted}${after}`;
    const nextCursorPosition = before.length + inserted.length;

    onMarkdownChange(nextMarkdown);
    setImageImportError("");
    selectionRef.current = {
      start: nextCursorPosition,
      end: nextCursorPosition,
    };
    focusGlobalSelection(nextMarkdown, nextCursorPosition);
  }

  async function handleImportedSource(source: File | string): Promise<void> {
    try {
      setIsImportingImage(true);
      onImageImportingChange(true);
      setImageImportError("");
      const result =
        typeof source === "string"
          ? await importImageUrl(source)
          : await importImageFile(source);
      insertImageMarkdown(result.path || result.url);
    } catch (error) {
      console.error("Image import failed", error);
      setImageImportError(
        error instanceof Error ? error.message : "图片导入失败，请稍后重试。",
      );
    } finally {
      setIsImportingImage(false);
      onImageImportingChange(false);
    }
  }

  function pickUrlFromTransfer(html: string, text: string): string | null {
    const htmlUrl = html ? findImageUrlFromHtml(html) : null;

    if (htmlUrl) {
      return htmlUrl;
    }

    const trimmedText = text.trim();
    return isLikelyImageUrl(trimmedText) ? trimmedText : null;
  }

  function handleMarkdownPaste(
    event: globalThis.ClipboardEvent,
    _view: EditorView,
  ): boolean {
    const fileFromItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .find((file): file is File => Boolean(file?.type.startsWith("image/")));

    if (fileFromItems) {
      event.preventDefault();
      void handleImportedSource(fileFromItems);
      return true;
    }

    const clipboardUrl = pickUrlFromTransfer(
      event.clipboardData?.getData("text/html") ?? "",
      event.clipboardData?.getData("text/plain") ?? "",
    );

    if (!clipboardUrl) {
      return false;
    }

    event.preventDefault();
    void handleImportedSource(clipboardUrl);
    return true;
  }

  function handleTextBlockChange(
    block: EditorTextBlock,
    nextValue: string,
    selection: MarkdownCodeMirrorSelection,
  ): void {
    const nextMarkdown = `${markdown.slice(0, block.start)}${nextValue}${markdown.slice(
      block.end,
    )}`;
    selectionRef.current = absoluteSelectionForBlock(block, selection);
    onMarkdownChange(nextMarkdown);
  }

  async function importFromDrop(event: DragEvent<HTMLElement>): Promise<void> {
    const imageFile = extractImageFile(event.dataTransfer.files);

    if (imageFile) {
      await handleImportedSource(imageFile);
      return;
    }

    const droppedUrl = pickUrlFromTransfer(
      event.dataTransfer.getData("text/html"),
      event.dataTransfer.getData("text/uri-list") ||
        event.dataTransfer.getData("text/plain"),
    );

    if (droppedUrl) {
      await handleImportedSource(droppedUrl);
    }
  }

  async function handleImageInputChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    await handleImportedSource(file);
  }

  function handleDragEnter(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsDropTargetActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTargetActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>): void {
    event.preventDefault();

    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDropTargetActive(false);
  }

  return (
    <>
      <aside className="editor-panel">
      {imageImportError ? <p className="image-import-status error">{imageImportError}</p> : null}
      {isImportingImage ? <p className="image-import-status">正在导入图片...</p> : null}
      <div
        ref={editorFrameRef}
        className={`markdown-editor-frame${
          isDropTargetActive ? " drag-active" : ""
        }`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => {
          event.preventDefault();
          setIsDropTargetActive(false);
          void importFromDrop(event);
        }}
      >
        {isDropTargetActive ? (
          <div className="markdown-drop-indicator">松手即可导入图片</div>
        ) : null}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            void handleImageInputChange(event);
          }}
        />
        <div
          ref={editorScrollRef}
          className="markdown-editor-flow"
          onScroll={syncEditorPaperScroll}
          onPointerDown={(event) => {
            if (!(event.target as HTMLElement).closest(".editor-image-block")) {
              setActiveImageKey(null);
            }
          }}
        >
          {imageDropIndicatorTop !== null ? (
            <span
              className="editor-image-drop-line"
              style={{ top: `${imageDropIndicatorTop}px` }}
              aria-hidden="true"
            />
          ) : null}
          {editorContent.map((block, blockIndex) =>
            block.kind === "text" ? (
              <MarkdownCodeMirror
                ariaLabel={
                  editorContent.length === 1
                    ? "便签正文"
                    : `便签正文第 ${Math.floor(blockIndex / 2) + 1} 段`
                }
                className={`markdown-editor editor-text-segment${
                  blockIndex === editorContent.length - 1
                    ? " is-last-text-segment"
                    : ""
                }`}
                key={`text-${blockIndex}`}
                onBlur={() => {
                  setIsQuickInputVisible(false);
                }}
                onChange={(nextText, selection) =>
                  handleTextBlockChange(block, nextText, selection)
                }
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onFocus={() => {
                  if (window.matchMedia("(max-width: 640px)").matches) {
                    keyboardBaselineHeightRef.current = Math.max(
                      keyboardBaselineHeightRef.current ??
                        window.visualViewport?.height ??
                        window.innerHeight,
                      window.visualViewport?.height ?? window.innerHeight,
                    );
                  }
                }}
                onKeyDown={(event, view) =>
                  handleEditorKeyDown(event, view, block, blockIndex)
                }
                onPaste={handleMarkdownPaste}
                onSelect={(selection) => updateBlockSelection(block, selection)}
                onViewReady={(view) => {
                  if (view) {
                    editorRefs.current.set(blockIndex, view);
                  } else {
                    editorRefs.current.delete(blockIndex);
                  }
                }}
                readOnly={readOnly}
                selection={localSelectionForBlock(block)}
                text={block.text}
              />
            ) : (
              <figure
                key={`image-${block.markerStart}-${block.source}`}
                className={`editor-image-block${
                  activeImageKey === getEditorImageKey(block) ? " is-active" : ""
                }${
                  draggingImageKey === getEditorImageKey(block)
                    ? " is-dragging"
                    : ""
                }`}
                data-editor-image="true"
                data-image-key={getEditorImageKey(block)}
              >
                <div
                  className="editor-image-visual"
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveImageKey((currentKey) =>
                      currentKey === getEditorImageKey(block)
                        ? null
                        : getEditorImageKey(block),
                    );
                  }}
                >
                  <img
                    className="editor-image-main"
                    src={block.source}
                    alt={block.alt || `正文图片 ${Math.floor(blockIndex / 2) + 1}`}
                    loading="lazy"
                    draggable={false}
                    onLoad={(event) => {
                      snapImageBlockToLineGrid(
                        event.currentTarget.closest(".editor-image-block"),
                      );
                    }}
                    onError={(event) => {
                      snapImageBlockToLineGrid(
                        event.currentTarget.closest(".editor-image-block"),
                      );
                    }}
                  />

                  {activeImageKey === getEditorImageKey(block) ? (
                    <div
                      className="editor-image-actions"
                      role="toolbar"
                      aria-label="图片操作"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-label="删除这张图片"
                        data-diag-action="image.remove"
                        onClick={() =>
                          requestImageDeletion(block, block.markerEnd)
                        }
                      >
                        <img
                          src={appPath("/smartisan/mobile/item_image_btn_unbrella_delete.png")}
                          alt=""
                        />
                      </button>
                      <button
                        type="button"
                        aria-label="编辑图片标注"
                        data-diag-action="image.caption"
                        onClick={() => openImageCaption(block)}
                      >
                        <img
                          src={appPath("/smartisan/mobile/item_image_btn_unbrella_edit_detail.png")}
                          alt=""
                        />
                      </button>
                      <button
                        type="button"
                        aria-label="下载这张图片"
                        data-diag-action="image.download"
                        onClick={() => void downloadEditorImage(block)}
                      >
                        <img
                          src={appPath("/smartisan/mobile/item_image_btn_unbrella_download_image.png")}
                          alt=""
                        />
                      </button>
                      <button
                        type="button"
                        aria-label="放大查看这张图片"
                        data-diag-action="image.preview"
                        onClick={() => {
                          setActiveImageKey(null);
                          setPreviewImage({ alt: block.alt, source: block.source });
                        }}
                      >
                        <img
                          src={appPath("/smartisan/mobile/item_image_btn_unbrella_preview_image.png")}
                          alt=""
                        />
                      </button>
                      <button
                        type="button"
                        aria-label="裁剪这张图片"
                        data-diag-action="image.crop"
                        onClick={() => void openImageCrop(block)}
                      >
                        <img
                          src={appPath("/smartisan/mobile/item_image_btn_unbrella_edit_image.png")}
                          alt=""
                        />
                      </button>
                    </div>
                  ) : null}
                </div>

                {captionImageKey === getEditorImageKey(block) || block.alt ? (
                  <input
                    ref={(input) => {
                      const imageKey = getEditorImageKey(block);

                      if (input) {
                        captionInputRefs.current.set(imageKey, input);
                      } else {
                        captionInputRefs.current.delete(imageKey);
                      }
                    }}
                    className="editor-image-caption"
                    aria-label="图片标注"
                    maxLength={240}
                    placeholder="图片描述"
                    value={block.alt}
                    onChange={(event) => updateImageAlt(block, event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onFocus={() => {
                      setActiveImageKey(null);
                    }}
                  />
                ) : null}

                <button
                  type="button"
                  className="editor-image-handle"
                  aria-label="拖动图片位置"
                  data-diag-action="image.move"
                  onPointerDown={(event) => {
                    beginImageDrag(event, block);
                  }}
                >
                  <img
                    src={appPath("/smartisan/mobile/detail_note_item_image_move.png")}
                    alt=""
                    draggable={false}
                  />
                </button>
              </figure>
            ),
          )}
        </div>
      </div>
      {isQuickInputVisible ? (
        <div
          className="markdown-quick-input"
          role="toolbar"
          aria-label="Markdown 快速输入"
        >
          {primaryMarkdownShortcuts.map((shortcut) => (
            <button
              key={shortcut.action}
              type="button"
              aria-label={shortcut.accessibleLabel}
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => handleMarkdownShortcut(shortcut.action)}
            >
              {shortcut.label}
            </button>
          ))}
          <button
            type="button"
            className={`markdown-quick-more-trigger${isMarkdownMoreOpen ? " is-active" : ""}`}
            aria-label="更多 Markdown 排版"
            aria-expanded={isMarkdownMoreOpen}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setIsMarkdownMoreOpen((isOpen) => !isOpen)}
          >
            ⋯
          </button>
          {isMarkdownMoreOpen ? (
            <div className="markdown-quick-more-menu" role="menu" aria-label="更多 Markdown 排版">
              {advancedMarkdownShortcuts.map((shortcut) => (
                <button
                  key={shortcut.action}
                  type="button"
                  role="menuitem"
                  aria-label={shortcut.accessibleLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    handleMarkdownShortcut(shortcut.action);
                    setIsMarkdownMoreOpen(false);
                  }}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      </aside>

      {previewImage
        ? createPortal(
            <div
              className="editor-image-preview"
              role="dialog"
              aria-modal="true"
              aria-label="图片放大预览"
            >
              <button
                type="button"
                className="editor-image-preview-close"
                aria-label="关闭图片预览"
                onClick={() => setPreviewImage(null)}
              >
                ×
              </button>
              <strong className="editor-image-preview-count">1 / 1</strong>
              <img
                className="editor-image-preview-main"
                src={previewImage.source}
                alt={previewImage.alt || "图片预览"}
              />
              <button
                type="button"
                className="editor-image-preview-save"
                onClick={() => {
                  const image = editorContent.find(
                    (block): block is EditorImageBlock =>
                      block.kind === "image" &&
                      block.source === previewImage.source &&
                      block.alt === previewImage.alt,
                  );

                  if (image) {
                    void downloadEditorImage(image);
                  }
                }}
              >
                保存图片
              </button>
            </div>,
            document.body,
          )
        : null}

      {cropSession ? (
        <ImageCropDialog
          alt={cropSession.alt}
          source={cropSession.source}
          onCancel={() => setCropSession(null)}
          onConfirm={saveCroppedImage}
        />
      ) : null}

      <ConfirmDialog
        pendingAction={
          pendingImageDeletion
            ? {
                confirmLabel: "删除图片",
                description: "删除后将无法恢复，是否确认删除这张图片？",
                title: "删除图片",
              }
            : null
        }
        onClose={closeImageDeletionConfirmation}
        onConfirm={confirmImageDeletion}
      />
    </>
  );
});
