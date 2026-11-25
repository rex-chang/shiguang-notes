// 浏览器级回归：登录账号的正文不能残留到 localStorage，也不能在退出后
// 被另一个账号当成初始工作区上传。测试使用真实构建产物和内存 API。
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { NoteWorkspace } from "../../src/types/app.js";

const ANONYMOUS_KEY = "notes.anonymous.workspace.v1";
const LEGACY_KEY = "notes.workspace.v1";
const LEGACY_DRAFT_KEY = "notes.markdownDraft";
const DIST_ENTRY = path.resolve("dist/index.html");
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

type MockUser = "A" | "B" | "C";

function workspace(markdown: string, noteId: string): NoteWorkspace {
  return {
    activeNoteId: noteId,
    folders: [],
    notes: [
      {
        id: noteId,
        markdown,
        createdAt: 1,
        updatedAt: 1,
        normalOrder: 0,
        pinnedAt: null,
        folderId: null,
        isStarred: false,
        deletedAt: null,
      },
    ],
    version: 1,
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function cookieUser(request: http.IncomingMessage): MockUser | null {
  const cookie = request.headers.cookie || "";
  const match = /(?:^|;\s*)test-user=([ABC])(?:;|$)/.exec(cookie);
  return match ? (match[1] as MockUser) : null;
}

interface MockState {
  clouds: Map<MockUser, NoteWorkspace | null>;
  puts: Array<{ markdown: string; user: MockUser }>;
  revisions: Map<MockUser, number>;
}

function createMockServer(state: MockState): http.Server {
  const dist = path.resolve("dist");
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      const user = cookieUser(request);

      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/health") {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/auth/session") {
          sendJson(response, 200, {
            requireLogin: false,
            user: user
              ? { id: `user-${user}`, role: "user", username: user }
              : null,
          });
          return;
        }
        if (url.pathname === "/api/auth/logout") {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/ai/status") {
          sendJson(response, 200, { available: false });
          return;
        }
        if (url.pathname === "/api/workspace") {
          if (!user) {
            sendJson(response, 401, { error: "请先登录账号。" });
            return;
          }
          if (request.method === "GET") {
            sendJson(response, 200, {
              updatedAt: state.revisions.get(user) ?? null,
              workspace: state.clouds.get(user) ?? null,
            });
            return;
          }
          if (request.method === "PUT") {
            const body = JSON.parse(await readRequestBody(request)) as {
              workspace?: NoteWorkspace;
            };
            const nextWorkspace = body.workspace ?? null;
            state.clouds.set(user, nextWorkspace);
            state.revisions.set(user, (state.revisions.get(user) ?? 0) + 1);
            state.puts.push({
              markdown: nextWorkspace?.notes[0]?.markdown ?? "",
              user,
            });
            sendJson(response, 200, {
              updatedAt: state.revisions.get(user),
              workspace: nextWorkspace,
            });
            return;
          }
        }
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const indexPath = path.join(dist, "index.html");
      let filePath =
        url.pathname === "/"
          ? indexPath
          : path.join(dist, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(dist)) {
        response.writeHead(403);
        response.end();
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        filePath = indexPath;
        body = await readFile(filePath);
      }
      response.writeHead(200, {
        "Content-Type":
          CONTENT_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream",
      });
      response.end(body);
    })().catch((error) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "server error");
    });
  });
}

async function waitForEditorValue(
  page: Page,
  expected: string,
  timeoutMs = 15_000,
): Promise<string> {
  await page.waitForSelector("#markdown-editor", { timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await page
      .locator("#markdown-editor")
      .inputValue()
      .catch(() => "");
    if (value.includes(expected)) {
      return value;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`编辑器内容未在超时内包含：${expected}`);
}

async function readLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

function addSeedScript(
  context: BrowserContext,
  entries: Array<[string, string]>,
): Promise<void> {
  return context.addInitScript((seedEntries) => {
    if (localStorage.getItem("account-storage-isolation.seeded")) {
      return;
    }
    for (const [key, value] of seedEntries) {
      localStorage.setItem(key, value);
    }
    localStorage.setItem("account-storage-isolation.seeded", "1");
  }, entries);
}

async function launchBrowser(): Promise<Browser | null> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return null;
  }
}

test("登录账号正文不写入本地，退出和换账号都不会继承", async (context) => {
  try {
    await access(DIST_ENTRY);
  } catch {
    context.skip("dist 未构建，跳过浏览器回归");
    return;
  }

  const browser = await launchBrowser();
  if (!browser) {
    context.skip("未安装 Playwright Chromium，跳过浏览器回归");
    return;
  }

  const state: MockState = {
    clouds: new Map([
      ["A", workspace("CLOUD-A", "cloud-a")],
      ["B", null],
      ["C", null],
    ]),
    puts: [],
    revisions: new Map([
      ["A", 100],
      ["B", 0],
      ["C", 0],
    ]),
  };
  const server = createMockServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const browserContext = await browser.newContext();
    await browserContext.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      return requestUrl.hostname === "127.0.0.1"
        ? route.continue()
        : route.abort();
    });
    await addSeedScript(browserContext, [
      [ANONYMOUS_KEY, JSON.stringify(workspace("ANON-CONTENT", "anon"))],
      [LEGACY_KEY, JSON.stringify(workspace("LEGACY-A-SECRET", "legacy"))],
      [LEGACY_DRAFT_KEY, "LEGACY-DRAFT"],
    ]);
    await browserContext.addCookies([
      { name: "test-user", value: "A", url: baseUrl },
    ]);

    const page = await browserContext.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForEditorValue(page, "CLOUD-A");

    assert.equal(await readLocalStorage(page, LEGACY_KEY), null);
    assert.equal(await readLocalStorage(page, LEGACY_DRAFT_KEY), null);
    const anonymousStorage = await readLocalStorage(page, ANONYMOUS_KEY);
    assert.ok(anonymousStorage?.includes("ANON-CONTENT"));
    assert.equal(anonymousStorage?.includes("CLOUD-A"), false);

    await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await page.waitForTimeout(150);
    assert.equal((await readLocalStorage(page, ANONYMOUS_KEY))?.includes("CLOUD-A"), false);
    assert.equal(
      (await readLocalStorage(page, LEGACY_KEY))?.includes("CLOUD-A") ?? false,
      false,
    );

    // 退出后只恢复匿名正文。
    await browserContext.clearCookies();
    await page.reload({ waitUntil: "domcontentloaded" });
    const anonymousValue = await waitForEditorValue(page, "ANON-CONTENT");
    assert.equal(anonymousValue.includes("CLOUD-A"), false);

    // 空账号 B 首次登录时只迁移新的匿名工作区，不会拿到 A 的云端正文。
    state.puts.length = 0;
    await browserContext.addCookies([
      { name: "test-user", value: "B", url: baseUrl },
    ]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForEditorValue(page, "ANON-CONTENT");
    const bPuts = state.puts.filter((entry) => entry.user === "B");
    assert.ok(bPuts.length > 0);
    assert.ok(bPuts.every((entry) => !entry.markdown.includes("CLOUD-A")));

    // 旧版全局键迁移来的匿名正文不能自动上传到新账号 C。
    const legacyContext = await browser.newContext();
    await legacyContext.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      return requestUrl.hostname === "127.0.0.1"
        ? route.continue()
        : route.abort();
    });
    await addSeedScript(legacyContext, [
      [LEGACY_KEY, JSON.stringify(workspace("LEGACY-A-SECRET", "legacy-only"))],
    ]);
    const legacyPage = await legacyContext.newPage();
    await legacyPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForEditorValue(legacyPage, "LEGACY-A-SECRET");

    state.puts.length = 0;
    await legacyContext.addCookies([
      { name: "test-user", value: "C", url: baseUrl },
    ]);
    await legacyPage.reload({ waitUntil: "domcontentloaded" });
    await legacyPage.waitForSelector("#markdown-editor");
    await legacyPage.waitForTimeout(500);
    const cPuts = state.puts.filter((entry) => entry.user === "C");
    assert.ok(cPuts.length > 0);
    assert.ok(cPuts.every((entry) => !entry.markdown.includes("LEGACY-A-SECRET")));

    await legacyContext.close();
    await browserContext.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await browser.close();
  }
});
