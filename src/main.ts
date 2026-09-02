import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { search } from "@codemirror/search";

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import githubLight from "highlight.js/styles/github.css?inline";
import githubDark from "highlight.js/styles/github-dark.css?inline";

import { invoke } from "@tauri-apps/api/core";
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// ---------- 应用状态 ----------
let currentFilePath: string | null = null; // 当前文件绝对路径，null = 未保存的新文件
let isDirty = false; // 是否有未保存的修改
let loadingContent = false; // 程序化写入内容时置 true，避免误判为"用户修改"
let mode: "edit" | "read" = "edit";

const RECENT_MAX = 10;
let recent: string[] = []; // 最近打开的文件路径列表（最新在前）

// ---------- 国际化 ----------
type Lang = "zh" | "en";
const I18N = {
  zh: {
    new: "新建",
    open: "打开",
    save: "保存",
    recentTitle: "最近打开",
    clearAll: "清空全部记录",
    collapse: "收起侧边栏",
    expand: "展开侧边栏",
    edit: "编辑",
    read: "阅读",
    editMode: "编辑模式",
    readMode: "阅读模式",
    outline: "大纲",
    untitled: "未命名",
    emptyRecent: "暂无最近打开的文档",
    removeRecent: "从最近列表移除",
    appName: "Markdown 编辑器",
    unsavedTitle: "未保存的修改",
    unsavedDiscard: "当前文件有未保存的修改，是否放弃并继续？",
    unsavedClose: "当前文件有未保存的修改，确定要关闭吗？",
    errorTitle: "错误",
    openFail: "打开文件失败：",
    saveFail: "保存文件失败：",
    mdFilter: "Markdown",
    switchTo: "Switch to English",
    langLabel: "EN",
  },
  en: {
    new: "New",
    open: "Open",
    save: "Save",
    recentTitle: "Recent",
    clearAll: "Clear all",
    collapse: "Collapse sidebar",
    expand: "Expand sidebar",
    edit: "Edit",
    read: "Read",
    editMode: "Edit mode",
    readMode: "Reading mode",
    outline: "Outline",
    untitled: "Untitled",
    emptyRecent: "No recent documents",
    removeRecent: "Remove from recent",
    appName: "Markdown Editor",
    unsavedTitle: "Unsaved changes",
    unsavedDiscard: "This file has unsaved changes. Discard and continue?",
    unsavedClose: "This file has unsaved changes. Close anyway?",
    errorTitle: "Error",
    openFail: "Failed to open file: ",
    saveFail: "Failed to save file: ",
    mdFilter: "Markdown",
    switchTo: "切换为中文",
    langLabel: "中",
  },
} as const;

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 忽略 */
  }
  return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang: Lang = detectLang();
const t = () => I18N[lang];

// CodeMirror 查找/替换面板的中文文案（英文用其默认值）
const SEARCH_PHRASES_ZH: Record<string, string> = {
  "Find": "查找",
  "Replace": "替换",
  "next": "下一个",
  "previous": "上一个",
  "all": "全部",
  "match case": "区分大小写",
  "by word": "全字匹配",
  "regexp": "正则",
  "replace": "替换",
  "replace all": "全部替换",
  "close": "关闭",
  "Go to line": "跳转到行",
  "go": "跳转",
  "current match": "当前匹配",
};

// ---------- Markdown 渲染器 ----------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new MarkdownIt({
  html: false, // 出于安全，禁用原始 HTML
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang }).value +
          "</code></pre>"
        );
      } catch {
        /* 回退到转义 */
      }
    }
    return '<pre class="hljs"><code>' + escapeHtml(str) + "</code></pre>";
  },
}).use(taskLists, { label: true });

// ---------- CodeMirror 编辑器 ----------
const themeCompartment = new Compartment();
const searchPhrasesCompartment = new Compartment(); // 查找/替换面板文案（随语言切换）

function searchPhrasesExt() {
  return EditorState.phrases.of(lang === "zh" ? SEARCH_PHRASES_ZH : {});
}

const editorParent = document.getElementById("editor")!;
const readViewEl = document.getElementById("read-view")!;
const previewEl = document.getElementById("preview")!;
const outlineEl = document.getElementById("outline")!;
const recentListEl = document.getElementById("recent-list")!;
const recentClearBtn = document.getElementById("recent-clear")!;
const appEl = document.querySelector<HTMLElement>(".app")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;
const saveBtn = document.getElementById("btn-save")!;
const langToggle = document.getElementById("lang-toggle")!;
const sidebarTitle = document.getElementById("sidebar-title")!;

// 安全获取当前窗口：非 Tauri 环境（浏览器预览）下 getCurrentWindow() 会同步抛错
let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
try {
  appWindow = getCurrentWindow();
} catch {
  appWindow = null;
}

const editor = new EditorView({
  parent: editorParent,
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      search({ top: true }), // 查找/替换面板置顶（含"全部替换"批量替换）
      searchPhrasesCompartment.of(searchPhrasesExt()),
      themeCompartment.of([]), // 主题由 applyTheme 动态注入
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !loadingContent) {
          setDirty(true);
        }
      }),
      // 让 ⌘S 在编辑器聚焦时也能触发保存
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            saveFile();
            return true;
          },
        },
      ]),
    ],
  }),
});

// ---------- 内容读写 ----------
function getContent(): string {
  return editor.state.doc.toString();
}

function setContent(text: string) {
  loadingContent = true;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
  loadingContent = false;
}

// ---------- 脏标记 ----------
function setDirty(dirty: boolean) {
  isDirty = dirty;
  saveBtn.classList.toggle("is-dirty", dirty); // 保存按钮随未保存状态点亮
  updateWindowTitle();
}

function fileDisplayName(): string {
  if (!currentFilePath) return t().untitled;
  return currentFilePath.split("/").pop() || currentFilePath;
}

function updateWindowTitle() {
  const name = fileDisplayName();
  document.getElementById("filename")!.textContent = name;
  const title = `${isDirty ? "• " : ""}${name} — ${t().appName}`;
  document.title = title;
  appWindow?.setTitle(title).catch(() => {});
}

// ---------- 阅读预览 ----------
function renderPreview() {
  previewEl.innerHTML = md.render(getContent());
  buildOutline();
}

// 手动平滑滚动（WKWebView 对 scrollIntoView smooth 支持不稳，自己实现更可靠）
function smoothScrollTo(container: HTMLElement, target: number, duration = 300) {
  const start = container.scrollTop;
  const dist = target - start;
  if (Math.abs(dist) < 2) {
    container.scrollTop = target;
    return;
  }
  const t0 = performance.now();
  function step(now: number) {
    const p = Math.min(1, (now - t0) / duration);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
    container.scrollTop = start + dist * ease;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// 根据渲染后的标题生成左侧大纲
function buildOutline() {
  const headings = previewEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4");
  outlineEl.innerHTML = "";

  if (headings.length === 0) {
    outlineEl.classList.add("empty");
    return;
  }
  outlineEl.classList.remove("empty");

  const title = document.createElement("div");
  title.className = "outline-title";
  title.textContent = t().outline;
  outlineEl.appendChild(title);

  headings.forEach((h, i) => {
    h.id = `heading-${i}`;
    const link = document.createElement("a");
    link.textContent = h.textContent || "";
    link.className = `lvl-${h.tagName[1]}`;
    link.dataset.target = h.id;
    link.addEventListener("click", () => {
      const target =
        previewEl.scrollTop +
        (h.getBoundingClientRect().top - previewEl.getBoundingClientRect().top) -
        16; // 顶部留一点呼吸空间
      smoothScrollTo(previewEl, Math.max(0, target));
      outlineEl
        .querySelectorAll("a.active")
        .forEach((a) => a.classList.remove("active"));
      link.classList.add("active");
    });
    outlineEl.appendChild(link);
  });
}

// ---------- 模式切换 ----------
function switchMode(next: "edit" | "read") {
  mode = next;
  const isRead = next === "read";
  if (isRead) renderPreview();

  readViewEl.classList.toggle("hidden", !isRead);
  editorParent.classList.toggle("hidden", isRead);

  // 新显示的面板淡入（重启动画：先移除再强制重排再加）
  const showEl = isRead ? readViewEl : editorParent;
  showEl.classList.remove("pane-enter");
  void showEl.offsetWidth;
  showEl.classList.add("pane-enter");

  document.getElementById("mode-edit")!.classList.toggle("active", !isRead);
  document.getElementById("mode-read")!.classList.toggle("active", isRead);

  if (!isRead) editor.focus();
}

function toggleMode() {
  switchMode(mode === "edit" ? "read" : "edit");
}

// ---------- 未保存守卫 ----------
async function guardUnsaved(): Promise<boolean> {
  if (!isDirty) return true;
  return await ask(t().unsavedDiscard, {
    title: t().unsavedTitle,
    kind: "warning",
  });
}

// ---------- 文件操作 ----------
async function newFile() {
  if (!(await guardUnsaved())) return;
  currentFilePath = null;
  setContent("");
  setDirty(false);
  switchMode("edit");
}

async function openFile() {
  if (!(await guardUnsaved())) return;
  const selected = await open({
    multiple: false,
    filters: [{ name: t().mdFilter, extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof selected !== "string") return; // 用户取消
  await loadPath(selected);
}

async function loadPath(path: string) {
  try {
    const text = await invoke<string>("read_file", { path });
    currentFilePath = path;
    setContent(text);
    setDirty(false);
    switchMode("read"); // 打开文件默认进入阅读模式
    addRecent(path);
  } catch (e) {
    removeRecent(path); // 文件读取失败（可能已被删/移走），从最近列表移除
    await message(t().openFail + e, { title: t().errorTitle, kind: "error" });
  }
}

async function saveFile() {
  if (!currentFilePath) {
    await saveFileAs();
    return;
  }
  await writePath(currentFilePath);
}

async function saveFileAs() {
  const path = await save({
    defaultPath: currentFilePath ?? `${t().untitled}.md`,
    filters: [{ name: t().mdFilter, extensions: ["md", "markdown"] }],
  });
  if (!path) return; // 用户取消
  currentFilePath = path;
  await writePath(path);
}

async function writePath(path: string) {
  try {
    await invoke("write_file", { path, contents: getContent() });
    setDirty(false);
    addRecent(path);
  } catch (e) {
    await message(t().saveFail + e, { title: t().errorTitle, kind: "error" });
  }
}

// ---------- 最近打开 ----------
async function loadRecent() {
  try {
    recent = await invoke<string[]>("load_recent");
  } catch {
    // 非 Tauri 环境（如浏览器预览）回退到 localStorage，方便调试
    recent = JSON.parse(localStorage.getItem("recent") || "[]");
  }
  renderRecent();
}

async function persistRecent() {
  try {
    await invoke("save_recent", { list: recent });
  } catch {
    localStorage.setItem("recent", JSON.stringify(recent));
  }
}

function addRecent(path: string) {
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
  persistRecent();
  renderRecent();
}

function removeRecent(path: string) {
  const before = recent.length;
  recent = recent.filter((p) => p !== path);
  if (recent.length !== before) {
    persistRecent();
    renderRecent();
  }
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

// 文件所在目录（去掉文件名和开头的 /，配合 rtl 左省略保留最深目录）
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  const dir = i > 0 ? path.slice(0, i) : path;
  return dir.replace(/^\//, "");
}

function renderRecent() {
  recentListEl.innerHTML = "";
  recentClearBtn.classList.toggle("hidden", recent.length === 0);

  if (recent.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = t().emptyRecent;
    recentListEl.appendChild(empty);
    return;
  }

  recent.forEach((path) => {
    const item = document.createElement("div");
    item.className = "recent-item";
    if (path === currentFilePath) item.classList.add("active");
    item.title = path; // 悬停显示完整路径

    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = baseName(path);

    const dir = document.createElement("span");
    dir.className = "recent-path";
    dir.textContent = parentDir(path);

    const remove = document.createElement("button");
    remove.className = "recent-remove";
    remove.textContent = "×";
    remove.title = t().removeRecent;
    remove.addEventListener("click", (e) => {
      e.stopPropagation(); // 不要触发打开
      removeRecent(path);
    });

    item.append(name, dir, remove);
    item.addEventListener("click", () => openRecent(path));
    recentListEl.appendChild(item);
  });
}

// 从最近列表打开：先做未保存守卫，再加载
async function openRecent(path: string) {
  if (path === currentFilePath) return; // 已是当前文件
  if (!(await guardUnsaved())) return;
  await loadPath(path);
}

// ---------- 侧边栏收起/展开 ----------
function setSidebarCollapsed(collapsed: boolean) {
  appEl.classList.toggle("sidebar-collapsed", collapsed);
  const label = collapsed ? t().expand : t().collapse;
  sidebarToggle.title = `${label} (⌘\\)`;
  sidebarToggle.setAttribute("aria-label", label);
  try {
    localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
  } catch {
    /* 忽略存储不可用 */
  }
}

function toggleSidebar() {
  setSidebarCollapsed(!appEl.classList.contains("sidebar-collapsed"));
}

// ---------- 语言应用 ----------
function applyLang() {
  const s = t();
  const setText = (id: string, text: string, title?: string) => {
    const el = document.getElementById(id)!;
    el.textContent = text;
    if (title) el.title = title;
  };
  setText("btn-new", s.new, `${s.new} (⌘N)`);
  setText("btn-open", s.open, `${s.open} (⌘O)`);
  setText("btn-save", s.save, `${s.save} (⌘S)`);
  setText("mode-edit", s.edit, `${s.editMode} (⌘E)`);
  setText("mode-read", s.read, `${s.readMode} (⌘E)`);
  sidebarTitle.textContent = s.recentTitle;
  recentClearBtn.title = s.clearAll;
  recentClearBtn.setAttribute("aria-label", s.clearAll);
  langToggle.textContent = s.langLabel;
  langToggle.title = s.switchTo;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  // 依赖语言的动态区一并刷新
  setSidebarCollapsed(appEl.classList.contains("sidebar-collapsed")); // 刷新收起按钮 title
  updateWindowTitle();
  renderRecent();
  if (mode === "read") renderPreview();
}

function setLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem("lang", next);
  } catch {
    /* 忽略 */
  }
  applyLang();
  // 刷新查找/替换面板文案
  editor.dispatch({
    effects: searchPhrasesCompartment.reconfigure(searchPhrasesExt()),
  });
}

function toggleLang() {
  setLang(lang === "zh" ? "en" : "zh");
}

// ---------- 明暗主题 ----------
const hljsStyle = document.createElement("style");
document.head.appendChild(hljsStyle);

function applyTheme(dark: boolean) {
  editor.dispatch({
    effects: themeCompartment.reconfigure(dark ? oneDark : []),
  });
  hljsStyle.textContent = dark ? githubDark : githubLight;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
applyTheme(darkQuery.matches);
darkQuery.addEventListener("change", (e) => applyTheme(e.matches));

// ---------- 事件绑定 ----------
document.getElementById("btn-new")!.addEventListener("click", newFile);
document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("mode-edit")!.addEventListener("click", () => switchMode("edit"));
document.getElementById("mode-read")!.addEventListener("click", () => switchMode("read"));

// 清空全部最近记录
recentClearBtn.addEventListener("click", () => {
  recent = [];
  persistRecent();
  renderRecent();
});

// 侧边栏收起/展开
sidebarToggle.addEventListener("click", toggleSidebar);

// 语言切换（中 / EN）
langToggle.addEventListener("click", toggleLang);

// 全局快捷键
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "n") {
    e.preventDefault();
    newFile();
  } else if (k === "o") {
    e.preventDefault();
    openFile();
  } else if (k === "s") {
    e.preventDefault();
    saveFile();
  } else if (k === "e") {
    e.preventDefault();
    toggleMode();
  } else if (k === "\\") {
    e.preventDefault();
    toggleSidebar();
  }
});

// 关闭窗口时提醒未保存
appWindow
  ?.onCloseRequested(async (event) => {
    if (!isDirty) return;
    const discard = await ask(t().unsavedClose, {
      title: t().unsavedTitle,
      kind: "warning",
    });
    if (!discard) event.preventDefault();
  })
  .catch(() => {});

// ---------- 文件关联：从 Finder 双击打开 ----------
// 运行中被要求打开文件（app 已开着）；非 Tauri 环境 listen 会 reject，忽略即可
listen<string>("open-file", async (e) => {
  if (e.payload) await loadPath(e.payload);
}).catch(() => {});

// 冷启动：取出启动时挂起的待打开文件
async function loadPendingFileOnStartup() {
  try {
    const pending = await invoke<string | null>("take_pending_file");
    if (pending) await loadPath(pending);
  } catch {
    /* 忽略：非 Tauri 环境或无待打开文件 */
  }
}

// 正文滚动时，高亮大纲中当前所在的标题
previewEl.addEventListener("scroll", () => {
  const headings = previewEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4");
  if (!headings.length) return;
  const containerTop = previewEl.getBoundingClientRect().top;
  let current: HTMLElement | null = null;
  headings.forEach((h) => {
    if (h.getBoundingClientRect().top - containerTop <= 12) current = h;
  });
  outlineEl.querySelectorAll("a.active").forEach((a) => a.classList.remove("active"));
  if (current) {
    const link = outlineEl.querySelector<HTMLElement>(
      `a[data-target="${(current as HTMLElement).id}"]`
    );
    link?.classList.add("active");
  }
});

// 初始化
try {
  setSidebarCollapsed(localStorage.getItem("sidebarCollapsed") === "1");
} catch {
  /* 忽略 */
}
// 初始状态就位后再开启过渡动画，避免启动闪动
setTimeout(() => appEl.classList.add("anim-ready"), 60);
applyLang(); // 应用语言（内部会刷新标题/最近列表/收起按钮）
editor.focus();
loadRecent();
loadPendingFileOnStartup();
