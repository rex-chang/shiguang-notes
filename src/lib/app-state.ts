import { isNative } from "./fnos-client.js";
import sampleMarkdown from "../../example/程序员狠话Vol.5.md?raw";
import {
  createSmartisanWebTestWorkspace,
  SMARTISAN_WEB_TEST_DATA_ID,
  SMARTISAN_WEB_TEST_WORKSPACE_STORAGE_KEY,
} from "../fixtures/smartisan-web-test-workspace.js";
import type { NoteWorkspace } from "../types/app.js";
import { createNoteDocument, parseNoteWorkspace } from "./notes";
import { consumeTestDataResetFromCurrentUrl } from "./test-data-url";
import {
  DEFAULT_FOOTER_BRAND,
  DEFAULT_FOOTER_LOGO_URL,
  DEFAULT_FOOTER_VIA,
  FOOTER_BRAND_STORAGE_KEY,
  FOOTER_LOGO_STORAGE_KEY,
  FOOTER_LOGO_URL_MAX_LENGTH,
  FOOTER_TEXT_MAX_LENGTH,
  FOOTER_VIA_STORAGE_KEY,
  LEGACY_DEFAULT_FOOTER_BRAND,
  LEGACY_DEFAULT_FOOTER_VIA,
  LEGACY_FOOTER_LOGO_URLS,
  LEGACY_UPSTREAM_FOOTER_BRAND,
  LEGACY_UPSTREAM_FOOTER_VIA,
} from "./footer";

export {
  DEFAULT_FOOTER_BRAND,
  DEFAULT_FOOTER_LOGO_URL,
  DEFAULT_FOOTER_VIA,
  FOOTER_BRAND_STORAGE_KEY,
  FOOTER_LOGO_STORAGE_KEY,
  FOOTER_LOGO_URL_MAX_LENGTH,
  FOOTER_TEXT_MAX_LENGTH,
  FOOTER_VIA_STORAGE_KEY,
} from "./footer";

export const FALLBACK_CONTENT = "";
// 匿名工作区与登录账号的正文分开存放。登录态绝不写入这两个键，避免退出或换账号后
// 把上一个账号的正文留给下一个用户，甚至被当成新账号的初始工作区上传。
const ANONYMOUS_WORKSPACE_STORAGE_KEY = "notes.anonymous.workspace.v1";
const ANONYMOUS_ORIGIN_STORAGE_KEY = "notes.anonymous.workspace.origin.v1";
const LEGACY_ANONYMOUS_ORIGIN = "legacy";
const LEGACY_WORKSPACE_STORAGE_KEY = "notes.workspace.v1";
const LEGACY_DRAFT_STORAGE_KEY = "notes.markdownDraft";
let anonymousWorkspaceCameFromLegacy = false;
export const AI_ENABLED_STORAGE_KEY = "notes.aiEnabled";
export const SAMPLE_MARKDOWN_CONTENT = sampleMarkdown || FALLBACK_CONTENT;

export {
  getInitialNoteCardTheme,
  getInitialTheme,
  NOTE_CARD_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./themes";

export function isSmartisanWebTestDataMode(): boolean {
  if (isNative) return false;
  return readSearchParam("testData") === SMARTISAN_WEB_TEST_DATA_ID;
}

function getWorkspaceStorageKey(): string {
  return isSmartisanWebTestDataMode()
    ? SMARTISAN_WEB_TEST_WORKSPACE_STORAGE_KEY
    : ANONYMOUS_WORKSPACE_STORAGE_KEY;
}

function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 浏览器禁用存储或配额不足时不能阻断编辑；云端保存仍是登录账号的兜底。
  }
}

function removeStoredValue(key: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // 与写入一致：存储不可用时静默降级。
  }
}

function createWorkspaceFromMarkdown(markdown: string): NoteWorkspace {
  const note = createNoteDocument(markdown);

  return {
    activeNoteId: note.id,
    folders: [],
    notes: [note],
    version: 1,
  };
}

function readSearchParam(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get(key);
}

/**
 * 启动时的占位工作区。普通网页不再在会话确认前读取本地正文，避免共享设备上
 * 登录账号的旧内容在云端水合完成前闪现；匿名正文由 getAnonymousNoteWorkspace()
 * 在确认无登录会话后加载。
 */
export function getInitialNoteWorkspace(): NoteWorkspace {
  if (isNative) {
    return createWorkspaceFromMarkdown("");
  }
  if (getRenderMode() === "playwright") {
    return createWorkspaceFromMarkdown(FALLBACK_CONTENT);
  }

  if (isSmartisanWebTestDataMode()) {
    const shouldResetTestData = readSearchParam("resetTestData") === "1";

    if (shouldResetTestData) {
      consumeTestDataResetFromCurrentUrl();
    }

    const storedWorkspace = shouldResetTestData
      ? null
      : parseNoteWorkspace(readStoredValue(getWorkspaceStorageKey()));

    return storedWorkspace ?? createSmartisanWebTestWorkspace();
  }

  return createWorkspaceFromMarkdown(SAMPLE_MARKDOWN_CONTENT);
}

interface AnonymousWorkspaceOptions {
  /** 登录态下不要迁移旧版全局键，避免把旧版本遗留的账号正文当成匿名数据。 */
  allowLegacyMigration?: boolean;
}

/**
 * 读取仅属于匿名模式的工作区。旧版 `notes.workspace.v1` 只在匿名启动时迁移一次；
 * 登录账号的云端水合路径使用 allowLegacyMigration: false 并清理旧键。
 */
export function getAnonymousNoteWorkspace(
  options: AnonymousWorkspaceOptions = {},
): NoteWorkspace | null {
  if (
    typeof window === "undefined" ||
    isNative ||
    getRenderMode() === "playwright" ||
    isSmartisanWebTestDataMode()
  ) {
    return null;
  }

  const storedWorkspace = parseNoteWorkspace(
    readStoredValue(ANONYMOUS_WORKSPACE_STORAGE_KEY),
  );

  if (storedWorkspace) {
    anonymousWorkspaceCameFromLegacy =
      readStoredValue(ANONYMOUS_ORIGIN_STORAGE_KEY) === LEGACY_ANONYMOUS_ORIGIN;
    return storedWorkspace;
  }

  if (options.allowLegacyMigration === false) {
    return null;
  }

  const legacyWorkspace = parseNoteWorkspace(
    readStoredValue(LEGACY_WORKSPACE_STORAGE_KEY),
  );

  if (legacyWorkspace) {
    writeStoredValue(
      ANONYMOUS_WORKSPACE_STORAGE_KEY,
      JSON.stringify(legacyWorkspace),
    );
    writeStoredValue(ANONYMOUS_ORIGIN_STORAGE_KEY, LEGACY_ANONYMOUS_ORIGIN);
    anonymousWorkspaceCameFromLegacy = true;
    removeStoredValue(LEGACY_WORKSPACE_STORAGE_KEY);
    removeStoredValue(LEGACY_DRAFT_STORAGE_KEY);
    return legacyWorkspace;
  }

  const legacyDraft = readStoredValue(LEGACY_DRAFT_STORAGE_KEY);

  if (!legacyDraft) {
    return null;
  }

  const migratedWorkspace = createWorkspaceFromMarkdown(legacyDraft);
  writeStoredValue(
    ANONYMOUS_WORKSPACE_STORAGE_KEY,
    JSON.stringify(migratedWorkspace),
  );
  writeStoredValue(ANONYMOUS_ORIGIN_STORAGE_KEY, LEGACY_ANONYMOUS_ORIGIN);
  anonymousWorkspaceCameFromLegacy = true;
  removeStoredValue(LEGACY_WORKSPACE_STORAGE_KEY);
  removeStoredValue(LEGACY_DRAFT_STORAGE_KEY);
  return migratedWorkspace;
}

/** 旧版迁移来的匿名正文不能自动上传到新账号，避免把上一个账号的内容带过去。 */
export function isAnonymousWorkspaceFromLegacy(): boolean {
  return (
    anonymousWorkspaceCameFromLegacy ||
    readStoredValue(ANONYMOUS_ORIGIN_STORAGE_KEY) === LEGACY_ANONYMOUS_ORIGIN
  );
}

/** 只允许匿名工作区调用；登录账号必须只依赖服务端工作区。 */
export function persistAnonymousNoteWorkspace(workspace: NoteWorkspace): void {
  if (
    typeof window === "undefined" ||
    isNative ||
    getRenderMode() === "playwright"
  ) {
    return;
  }

  writeStoredValue(getWorkspaceStorageKey(), JSON.stringify(workspace));

  if (!isSmartisanWebTestDataMode()) {
    removeStoredValue(LEGACY_WORKSPACE_STORAGE_KEY);
    removeStoredValue(LEGACY_DRAFT_STORAGE_KEY);
  }
}

/** 登录成功后清理旧版本的全局正文键；匿名正文另有独立键，不受影响。 */
export function clearLegacyNoteStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  removeStoredValue(LEGACY_WORKSPACE_STORAGE_KEY);
  removeStoredValue(LEGACY_DRAFT_STORAGE_KEY);
}

export function getRenderMode(): string | null {
  return readSearchParam("renderMode");
}

export function getInitialAiEnabled(): boolean {
  return readStoredValue(AI_ENABLED_STORAGE_KEY) === "true";
}

export function persistAiEnabled(enabled: boolean): void {
  if (typeof window === "undefined" || getRenderMode() === "playwright") {
    return;
  }

  window.localStorage.setItem(AI_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
}

export function getInitialFooterBrand(): string {
  const searchParam = readSearchParam("footerBrand");
  if (searchParam !== null) {
    return searchParam.slice(0, FOOTER_TEXT_MAX_LENGTH);
  }

  const storedBrand = readStoredValue(FOOTER_BRAND_STORAGE_KEY);
  // 两个旧默认署名（含上游品牌名）都迁移到自己的默认署名。
  return (
    storedBrand === LEGACY_DEFAULT_FOOTER_BRAND ||
    storedBrand === LEGACY_UPSTREAM_FOOTER_BRAND
      ? DEFAULT_FOOTER_BRAND
      : (storedBrand ?? DEFAULT_FOOTER_BRAND)
  ).slice(0, FOOTER_TEXT_MAX_LENGTH);
}

export function getInitialFooterVia(): string {
  const searchParam = readSearchParam("footerVia");
  if (searchParam !== null) {
    return searchParam.slice(0, FOOTER_TEXT_MAX_LENGTH);
  }

  const storedVia = readStoredValue(FOOTER_VIA_STORAGE_KEY);
  return (
    storedVia === LEGACY_DEFAULT_FOOTER_VIA ||
    storedVia === LEGACY_UPSTREAM_FOOTER_VIA
      ? DEFAULT_FOOTER_VIA
      : (storedVia ?? DEFAULT_FOOTER_VIA)
  ).slice(0, FOOTER_TEXT_MAX_LENGTH);
}

export function getInitialFooterLogoUrl(): string {
  const value =
    readSearchParam("footerLogoUrl") ??
    readStoredValue(FOOTER_LOGO_STORAGE_KEY) ??
    DEFAULT_FOOTER_LOGO_URL;
  const normalized = value.replace(/^\/app\/fnnotes-m0/, "");

  return (
    LEGACY_FOOTER_LOGO_URLS.includes(normalized)
      ? DEFAULT_FOOTER_LOGO_URL
      : value
  ).slice(0, FOOTER_LOGO_URL_MAX_LENGTH);
}

export function persistFooterText(footerBrand: string, footerVia: string): void {
  if (typeof window === "undefined" || getRenderMode() === "playwright") {
    return;
  }

  window.localStorage.setItem(
    FOOTER_BRAND_STORAGE_KEY,
    footerBrand.slice(0, FOOTER_TEXT_MAX_LENGTH),
  );
  window.localStorage.setItem(
    FOOTER_VIA_STORAGE_KEY,
    footerVia.slice(0, FOOTER_TEXT_MAX_LENGTH),
  );
}

export function persistFooterLogoUrl(footerLogoUrl: string): void {
  if (typeof window === "undefined" || getRenderMode() === "playwright") {
    return;
  }

  window.localStorage.setItem(
    FOOTER_LOGO_STORAGE_KEY,
    footerLogoUrl.slice(0, FOOTER_LOGO_URL_MAX_LENGTH),
  );
}
