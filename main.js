const {
  MarkdownRenderChild, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile,
  TFolder, requestUrl,
} = require("obsidian");

const VAULT_FOLDER = "阅读追踪";
const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const KEY_PAGE = "https://weread.qq.com/r/weread-skills";
const BLOCK_NAME = "weread-tracker";
const STATE_BLOCK = /^```weread-tracker[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/m;
const VERSION = 1;

function readState(source) {
  const data = JSON.parse(source);
  if (
    data?.version !== VERSION || typeof data.bookId !== "string" ||
    !Array.isArray(data.chapters) || !Array.isArray(data.sessions)
  ) {
    throw new Error("阅读追踪数据格式无法识别。");
  }
  return data;
}

function writeState(data) {
  return [
    "```" + BLOCK_NAME,
    JSON.stringify(data, null, 2),
    "```",
  ].join("\n");
}

function cleanTitle(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function markdownText(value) {
  return value.replace(/[\\`*_{}\[\]()#+.!<>|~&]/g, "\\$&");
}

function filenamePart(value) {
  return Array.from(value.replace(/[\\/:*?"<>|#[\]^]/g, " ").trim())
    .slice(0, 90).join("").replace(/^[.\s]+|[.\s]+$/g, "");
}

function normalizeChapters(raw) {
  if (!Array.isArray(raw)) return [];
  const chapters = [];
  const seen = new Set();
  for (const chapter of raw) {
    const title = cleanTitle(chapter?.title);
    if (!title) continue;
    const id = "chapter:" + (chapter.chapterUid ?? chapter.chapterIdx ?? chapters.length);
    if (seen.has(id)) continue;
    seen.add(id);
    const level = Number(chapter.level);
    const depth = Number.isInteger(level) && level > 0 ? level - 1 : 0;
    chapters.push({ id, title, depth, doneAt: null });

    if (!Array.isArray(chapter.anchors)) continue;
    for (const [index, anchor] of chapter.anchors.entries()) {
      const subheading = cleanTitle(
        typeof anchor === "string" ? anchor : anchor?.title ?? anchor?.name ?? anchor?.label ?? anchor?.text
      );
      if (!subheading || subheading === title) continue;
      chapters.push({
        id: id + ":anchor:" + index,
        title: subheading,
        depth: depth + 1,
        doneAt: null,
      });
    }
  }
  return chapters;
}

function chapterDepths(chapters) {
  const ancestors = [];
  const byId = new Map();
  return chapters.map(chapter => {
    const anchorId = /^(chapter:.+):anchor:\d+$/.exec(chapter.id)?.[1];
    const parentId = chapter.parentId ?? anchorId;
    const number = /^(\d+(?:[.．]\d+)*)(?=$|[\s.．、:：)）])/.exec(chapter.title)?.[1]
      .replace(/．/g, ".");
    const numberedParent = number?.includes(".") &&
      ancestors.findLast(item => item.number && number.startsWith(item.number + "."));
    const explicitParent = byId.get(parentId);
    let depth = chapter.depth;
    if (explicitParent) depth = explicitParent.depth + 1;
    else if (numberedParent && chapter.parentId !== null) {
      depth = Math.max(depth, numberedParent.depth + 1);
    }
    while (ancestors.length && ancestors[ancestors.length - 1].depth >= depth) ancestors.pop();
    const entry = { depth, number };
    ancestors.push(entry);
    byId.set(chapter.id, entry);
    return depth;
  });
}

function endOfChapter(depths, start) {
  let end = start + 1;
  while (end < depths.length && depths[end] > depths[start]) end++;
  return end;
}

function dateText(date) {
  const pad = number => String(number).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function dateTimeText(ms) {
  const date = new Date(ms);
  return dateText(date) + " " + date.toTimeString().slice(0, 5);
}

function durationText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (!hours && !minutes) return seconds + " 秒";
  return [hours ? hours + " 小时" : "", minutes ? minutes + " 分钟" : "", remainder ? remainder + " 秒" : ""]
    .filter(Boolean).join(" ");
}

function clockText(seconds) {
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

function splitSession(start, end) {
  const sessions = [];
  for (let cursor = start; cursor < end;) {
    const date = new Date(cursor);
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(midnight.getTime(), end);
    const seconds = Math.floor((next - start) / 1000) - Math.floor((cursor - start) / 1000);
    if (seconds) sessions.push({ date: dateText(date), seconds });
    cursor = next;
  }
  return sessions;
}

function summarize(state) {
  const days = new Map();
  let seconds = 0;
  for (const session of state.sessions) {
    seconds += session.seconds;
    days.set(session.date, (days.get(session.date) ?? 0) + session.seconds);
  }
  const completed = state.chapters.filter(chapter => chapter.doneAt !== null);
  return {
    seconds,
    days: [...days.entries()].sort(([left], [right]) => right.localeCompare(left)),
    done: completed.length,
    finishedAt: completed.length && completed.length === state.chapters.length
      ? completed.reduce((latest, chapter) => Math.max(latest, chapter.doneAt), 0)
      : null,
  };
}

function positiveUnixTime(value) {
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null;
}

function progressSnapshot(response) {
  if (!response?.book || typeof response.book !== "object") {
    throw new Error("微信读书未返回这本书的阅读统计。");
  }
  const { book } = response;
  const progress = book.progress === null || book.progress === undefined ? NaN : Number(book.progress);
  const seconds = book.recordReadingTime == null ? NaN : Number(book.recordReadingTime);
  return {
    progress: Number.isInteger(progress) && progress >= 0 && progress <= 100 ? progress : null,
    seconds: Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null,
    lastReadAt: positiveUnixTime(book.updateTime),
    finishedAt: progress === 100 ? positiveUnixTime(book.finishTime) : null,
  };
}

function readerLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "weread.qq.com" && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // The official API can omit a web reader link.
  }
  return "";
}

function asBook(value) {
  const id = String(value?.bookId ?? "");
  const title = cleanTitle(value?.title);
  return id && title ? {
    id, title,
    author: cleanTitle(value.author),
    link: readerLink(value.readerLink),
    lastReadAt: positiveUnixTime(value.readUpdateTime),
  } : null;
}

function readBookInfo(data) {
  const info = {};
  for (const key of ["author", "publisher", "translator", "isbn", "category"]) {
    const value = cleanTitle(data[key]);
    if (value) info[key] = value;
  }
  const date = cleanTitle(data.publishTime);
  if (date && !/^0{4}(?:-|$)/.test(date)) {
    info.publishTime = /^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/.exec(date)?.[1] ?? date;
  }
  const wordCount = Number(data.wordCount);
  if (Number.isSafeInteger(wordCount) && wordCount > 0) info.wordCount = wordCount;
  const link = readerLink(data.readerLink);
  if (link) info.link = link;
  return info;
}

class TrackerSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const intro = containerEl.createEl("p");
    intro.createSpan({ text: "前往 " });
    intro.createEl("a", { text: "微信读书官方页面", href: KEY_PAGE });
    intro.createSpan({ text: "获取 API Key，然后在下方新建一个机密并保存它。" });
    new Setting(containerEl)
      .setName("微信读书 API Key")
      .setDesc("机密名称可填写 weread，再粘贴以 wrk- 开头的密钥。")
      .addComponent(element => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.secretName)
        .onChange(async name => {
          this.plugin.settings.secretName = name || "";
          try {
            await this.plugin.saveData(this.plugin.settings);
          } catch {
            new Notice("未能保存设置，请重新选择机密。");
          }
        }));
  }
}

class BookPicker extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.shelf = [];
    this.books = [];
    this.source = "shelf";
    this.isOpen = false;
    this.busy = false;
  }

  onOpen() {
    this.isOpen = true;
    this.setTitle("导入微信读书目录");
    const controls = this.contentEl.createDiv({ cls: "wrt-controls" });
    this.query = controls.createEl("input", {
      type: "search",
      placeholder: "输入书名或作者",
      attr: { "aria-label": "书名或作者" },
    });
    this.search = controls.createEl("button", { text: "搜书城" });
    this.back = controls.createEl("button", { text: "返回书架" });
    this.status = this.contentEl.createEl("p", { cls: "wrt-muted", attr: { "aria-live": "polite" } });
    this.list = this.contentEl.createDiv({ cls: "wrt-book-list" });
    this.query.addEventListener("input", () => this.renderBooks());
    this.query.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.searchStore();
      }
    });
    this.search.addEventListener("click", () => void this.searchStore());
    this.back.addEventListener("click", () => {
      this.source = "shelf";
      this.query.value = "";
      this.renderBooks();
    });
    this.query.focus();
    void this.loadShelf();
  }

  onClose() {
    this.isOpen = false;
    this.contentEl.empty();
  }

  async loadShelf() {
    await this.run("正在读取微信读书书架…", async () => {
      const response = await this.plugin.api("/shelf/sync");
      if (!Array.isArray(response.books)) throw new Error("微信读书未返回书架列表。");
      this.shelf = response.books.map(asBook).filter(Boolean)
        .sort((left, right) => (right.lastReadAt ?? 0) - (left.lastReadAt ?? 0));
    });
  }

  async searchStore() {
    const keyword = this.query.value.trim();
    if (!keyword || this.busy) return;
    await this.run("正在搜索书城…", async () => {
      const result = await this.plugin.api("/store/search", { keyword, context: keyword, scope: 10 });
      const rows = Array.isArray(result.results) ? result.results : [];
      this.books = rows.flatMap(group => (Array.isArray(group.books) ? group.books : []))
        .map(item => asBook(item.bookInfo ?? item)).filter(Boolean);
      this.source = "store";
    });
  }

  async run(message, action) {
    if (this.busy) return;
    this.busy = true;
    this.renderBooks(message);
    try {
      await action();
      if (this.isOpen) {
        this.busy = false;
        this.renderBooks();
      }
    } catch (error) {
      this.busy = false;
      if (this.isOpen) this.renderBooks(error.message);
    }
  }

  renderBooks(message) {
    if (!this.isOpen) return;
    this.search.disabled = this.busy;
    this.back.hidden = this.source === "shelf";
    this.back.disabled = this.busy;
    this.list.empty();
    if (this.busy) {
      this.status.setText(message || this.status.textContent);
      return;
    }
    const fromShelf = this.source === "shelf";
    const keyword = this.query.value.trim().toLocaleLowerCase();
    const books = fromShelf
      ? this.shelf.filter(book => (book.title + " " + book.author).toLocaleLowerCase().includes(keyword))
      : this.books;
    this.status.setText(message || (books.length
      ? (fromShelf ? "按最近阅读排序 · " : "书城搜索结果 · ") + books.length + " 本"
      : fromShelf ? "书架中暂无匹配的电子书。也可以搜索书城。" : "书城中暂无匹配的电子书。"));
    for (const book of books) {
      const button = this.list.createEl("button", { cls: "wrt-book-choice" });
      button.createSpan({ text: book.title });
      const details = [book.author];
      if (fromShelf && book.lastReadAt) details.push(dateText(new Date(book.lastReadAt)));
      const description = details.filter(Boolean).join(" · ");
      if (description) button.createSpan({ cls: "wrt-muted", text: description });
      button.addEventListener("click", () => void this.run("正在导入《" + book.title + "》…", async () => {
        await this.plugin.importBook(book);
        if (this.isOpen) this.close();
      }));
    }
  }
}

class ManualEntry extends Modal {
  constructor(panel, kind) {
    super(panel.plugin.app);
    this.panel = panel;
    this.kind = kind;
  }

  onOpen() {
    const chapter = this.kind === "chapter";
    this.setTitle(chapter ? "添加小节或小结" : "补记阅读时长");
    const form = this.contentEl.createEl("form", { cls: "wrt-form" });
    let parent, title, date, minutes;
    if (chapter) {
      parent = form.createEl("label", { text: "所属章节" }).createEl("select");
      parent.createEl("option", { text: "整本书", value: "" });
      const chapters = this.panel.state.chapters;
      const depths = chapterDepths(chapters);
      for (const [index, item] of chapters.entries()) {
        parent.createEl("option", { text: "　".repeat(Math.min(depths[index], 4)) + item.title, value: item.id });
      }
      title = form.createEl("label", { text: "标题" }).createEl("input", {
        type: "text", placeholder: "例如 本章小结", attr: { required: "", maxlength: "200" },
      });
    } else {
      date = form.createEl("label", { text: "阅读日期" }).createEl("input", {
        type: "date", value: dateText(new Date()), attr: { required: "" },
      });
      minutes = form.createEl("label", { text: "阅读时长（分钟）" }).createEl("input", {
        type: "number", attr: { required: "", min: "1", max: "1440", step: "1" },
      });
    }
    const save = form.createEl("button", { type: "submit", text: "保存", cls: "mod-cta" });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled) return;
      const label = chapter ? cleanTitle(title.value) : "";
      const parentId = chapter ? parent.value : "";
      const session = chapter ? null : { date: date.value, seconds: minutes.valueAsNumber * 60 };
      if (chapter && !label) {
        new Notice("请输入小节或小结的标题。");
        return;
      }
      save.disabled = true;
      try {
        await this.panel.plugin.change(this.panel.file, this.panel.state.bookId, state => {
          if (!chapter) {
            state.sessions.push(session);
            return;
          }
          const parentIndex = state.chapters.findIndex(item => item.id === parentId);
          const depths = chapterDepths(state.chapters);
          const depth = parentIndex === -1 ? 0 : depths[parentIndex] + 1;
          const index = parentIndex === -1 ? state.chapters.length : endOfChapter(depths, parentIndex);
          state.chapters.splice(index, 0, {
            id: "manual:" + crypto.randomUUID(), title: label, depth, doneAt: null, parentId: parentId || null,
          });
        });
        this.close();
      } catch (error) {
        new Notice(error.message);
        save.disabled = false;
      }
    });
    (chapter ? title : minutes).focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ReadingPanel {
  constructor(plugin, el, file, state) {
    this.plugin = plugin;
    this.el = el;
    this.file = file;
    this.state = state;
    this.refreshing = false;
    this.updatingBookInfo = false;
    el.addClass("wrt-panel");

    const bibliography = el.createDiv({ cls: "wrt-bibliography wrt-controls" });
    this.bookDetails = bibliography.createEl("p");
    this.infoButton = bibliography.createEl("button", { text: "更新书籍信息" });
    this.infoButton.addEventListener("click", () => void this.updateBookInfo());
    this.summary = el.createDiv({ cls: "wrt-summary" });
    const controls = el.createDiv({ cls: "wrt-controls" });
    this.timer = controls.createEl("button", { cls: "mod-cta" });
    this.timer.addEventListener("click", () => void this.toggleTimer());
    this.cancel = controls.createEl("button", { text: "取消计时" });
    this.cancel.addEventListener("click", () => {
      if (this.el.ownerDocument.defaultView.confirm("取消本次计时？本次时长将不计入记录。")) {
        const expected = this.state.startedAt;
        void this.update(state => {
          if (state.startedAt === expected) state.startedAt = null;
        });
      }
    });
    controls.createEl("button", { text: "补记时长" })
      .addEventListener("click", () => new ManualEntry(this, "session").open());
    this.clock = controls.createSpan({ cls: "wrt-clock" });
    this.remote = el.createDiv({ cls: "wrt-remote" });
    this.remoteStats = this.remote.createEl("p");
    this.refreshButton = this.remote.createEl("button", { text: "刷新微信读书统计" });
    this.refreshButton.addEventListener("click", () => void this.refresh());

    const directory = el.createDiv({ cls: "wrt-controls wrt-section-heading" });
    directory.createEl("h3", { text: "阅读目录" });
    directory.createEl("button", { text: "添加小节或小结" })
      .addEventListener("click", () => new ManualEntry(this, "chapter").open());
    this.chapterList = el.createDiv({ cls: "wrt-chapters" });
    const log = el.createEl("details", { cls: "wrt-log" });
    log.open = true;
    log.createEl("summary", { text: "每日阅读记录" });
    this.logBody = log.createDiv();
    this.rows = new Map();
    this.render();
  }

  async updateBookInfo() {
    if (this.updatingBookInfo) return;
    this.updatingBookInfo = true;
    this.infoButton.disabled = true;
    try {
      await this.plugin.fillBookInfo(this.file, this.state.bookId);
      new Notice("已更新书籍信息。");
    } catch (error) {
      new Notice(error.message);
    } finally {
      this.updatingBookInfo = false;
      this.infoButton.disabled = false;
    }
  }

  render() {
    const state = this.state;
    const stats = summarize(state);
    const info = state.bookInfo ?? {};
    const details = [
      ["出版社", info.publisher],
      ["出版时间", info.publishTime],
      ["译者", info.translator],
      ["ISBN", info.isbn],
      ["分类", info.category],
      ["字数", info.wordCount && new Intl.NumberFormat("zh-CN").format(info.wordCount)],
    ].filter(([, value]) => value);
    this.bookDetails.setText(details.map(([label, value]) => label + " " + value).join("  ·  ") ||
      (state.bookInfo ? "微信读书未提供出版信息" : "可更新书籍信息以补全出版资料"));
    this.summary.empty();
    this.summary.createSpan({ text: "已完成 " + stats.done + " / " + state.chapters.length + " 项" });
    this.summary.createSpan({ text: "累计计时 " + durationText(stats.seconds) });
    if (stats.days.length) {
      const dates = stats.days;
      const first = dates[dates.length - 1][0];
      this.summary.createSpan({ text: first === dates[0][0] ? "阅读于 " + first : "阅读日期 " + first + " 至 " + dates[0][0] });
    }
    if (stats.finishedAt) this.summary.createSpan({ text: "目录全部完成于 " + dateTimeText(stats.finishedAt) });

    this.timer.setText(state.startedAt ? "结束阅读" : "开始阅读");
    this.cancel.hidden = !state.startedAt;
    this.renderClock();

    const remote = state.weread;
    const remoteParts = [];
    if (remote?.progress != null) remoteParts.push("进度 " + remote.progress + "%");
    if (remote?.seconds != null) remoteParts.push("累计 " + durationText(remote.seconds));
    if (remote?.lastReadAt) remoteParts.push("最近阅读 " + dateTimeText(remote.lastReadAt));
    if (remote?.finishedAt) remoteParts.push("读完于 " + dateTimeText(remote.finishedAt));
    this.remoteStats.setText(remoteParts.length
      ? "微信读书  ·  " + remoteParts.join("  ·  ")
      : "暂无微信读书统计");
    this.renderChapters();
    this.logBody.empty();
    if (!stats.days.length) {
      this.logBody.createEl("p", { cls: "wrt-muted", text: "暂无阅读记录。可开始计时或补记时长。" });
      return;
    }
    const table = this.logBody.createEl("table");
    const headers = table.createEl("thead").createEl("tr");
    headers.createEl("th", { text: "日期", attr: { scope: "col" } });
    headers.createEl("th", { text: "阅读时长", attr: { scope: "col" } });
    const body = table.createEl("tbody");
    for (const [date, seconds] of stats.days) {
      const row = body.createEl("tr");
      row.createEl("td", { text: date });
      row.createEl("td", { text: durationText(seconds) });
    }
  }

  renderClock() {
    const started = this.state.startedAt;
    this.clock.hidden = !started;
    if (started) {
      const value = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const text = clockText(value);
      if (this.clock.textContent !== text) this.clock.setText(text);
    }
  }

  renderChapters() {
    const chapters = this.state.chapters;
    const depths = chapterDepths(chapters);
    const currentOrder = [...this.rows.keys()];
    if (chapters.length !== currentOrder.length || chapters.some((item, index) => item.id !== currentOrder[index])) {
      this.chapterList.empty();
      this.rows.clear();
      for (const item of chapters) {
        const label = this.chapterList.createEl("label", { cls: "wrt-chapter" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        label.createSpan({ text: item.title, cls: "wrt-chapter-title" });
        const stamp = label.createEl("time", { cls: "wrt-stamp" });
        checkbox.addEventListener("change", () => void this.setDone(item.id, checkbox.checked));
        this.rows.set(item.id, { label, checkbox, stamp });
      }
    }
    for (const [index, item] of chapters.entries()) {
      const { label, checkbox, stamp } = this.rows.get(item.id);
      label.style.setProperty("--wrt-depth", String(Math.min(depths[index], 10)));
      checkbox.checked = item.doneAt !== null;
      stamp.hidden = !item.doneAt;
      stamp.dateTime = item.doneAt ? new Date(item.doneAt).toISOString() : "";
      stamp.setText(item.doneAt ? "完成于 " + dateTimeText(item.doneAt) : "");
    }
  }

  async update(action) {
    try {
      await this.plugin.change(this.file, this.state.bookId, action);
    } catch (error) {
      this.render();
      new Notice(error.message);
    }
  }

  setDone(id, checked) {
    const now = Date.now();
    return this.update(state => {
      const start = state.chapters.findIndex(chapter => chapter.id === id);
      if (start === -1) throw new Error("找不到这个目录项，请重新打开笔记。");
      if (!checked) {
        state.chapters[start].doneAt = null;
        return;
      }
      const end = endOfChapter(chapterDepths(state.chapters), start);
      for (let index = start; index < end; index++) {
        state.chapters[index].doneAt ??= now;
      }
    });
  }

  toggleTimer() {
    const now = Date.now();
    const expected = this.state.startedAt;
    return this.update(state => {
      if (state.startedAt !== expected) return;
      if (!state.startedAt) {
        state.startedAt = now;
        return;
      }
      if (now < state.startedAt) throw new Error("系统时钟早于开始时间，请检查系统时间或取消计时。");
      state.sessions.push(...splitSession(state.startedAt, now));
      state.startedAt = null;
    });
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshButton.disabled = true;
    this.refreshButton.setText("刷新中…");
    try {
      const stats = await this.plugin.fetchProgress(this.state.bookId);
      await this.plugin.change(this.file, this.state.bookId, state => { state.weread = stats; });
      new Notice("已刷新微信读书统计。");
    } catch (error) {
      new Notice(error.message);
    } finally {
      this.refreshing = false;
      this.refreshButton.disabled = false;
      this.refreshButton.setText("刷新微信读书统计");
    }
  }
}

module.exports = class WereadTracker extends Plugin {
  async onload() {
    this.settings = { secretName: "", ...await this.loadData() };
    this.panels = new Set();
    this.importQueue = Promise.resolve();
    this.addSettingTab(new TrackerSettings(this.app, this));
    this.addCommand({
      id: "import-book",
      name: "导入微信读书目录",
      callback: () => this.openPicker(),
    });
    this.addRibbonIcon("book-open", "导入微信读书目录", () => this.openPicker());
    this.registerMarkdownCodeBlockProcessor(BLOCK_NAME, (source, element, context) => {
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      try {
        const panel = new ReadingPanel(this, element, file, readState(source));
        this.panels.add(panel);
        const child = new MarkdownRenderChild(element);
        child.register(() => this.panels.delete(panel));
        context.addChild(child);
      } catch {
        element.createEl("p", { text: "无法读取阅读追踪数据。请检查笔记中的 weread-tracker 区块。" });
      }
    });
    this.registerInterval(window.setInterval(() => {
      for (const panel of this.panels) panel.renderClock();
    }, 1000));
  }

  openPicker() {
    if (!this.secret()) {
      new Notice("请先到设置 → 微信读书阅读追踪，配置微信读书 API Key。", 6500);
      return;
    }
    new BookPicker(this).open();
  }

  secret() {
    const name = this.settings.secretName;
    const key = name ? this.app.secretStorage.getSecret(name)?.trim() : "";
    return key && /^wrk-[^\s]+$/.test(key) ? key : "";
  }

  async api(apiName, params = {}) {
    const key = this.secret();
    if (!key) throw new Error("请先在插件设置中配置微信读书 API Key。");
    let response;
    try {
      response = await requestUrl({
        url: GATEWAY,
        method: "POST",
        headers: { Authorization: "Bearer " + key },
        contentType: "application/json",
        body: JSON.stringify({ api_name: apiName, skill_version: "1.0.6", ...params }),
        throw: false,
      });
    } catch {
      throw new Error("无法连接微信读书，请检查网络后重试。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("微信读书没有通过认证，请检查 API Key 或重新获取。");
    }
    if (response.status === 429) throw new Error("微信读书访问频率过高，请稍后重试。");
    if (response.status < 200 || response.status >= 300) {
      throw new Error("微信读书服务返回 HTTP " + response.status + "，请稍后重试。");
    }
    let result;
    try {
      result = response.json;
    } catch {
      throw new Error("微信读书返回的数据无法读取。");
    }
    if (!result || typeof result !== "object") throw new Error("微信读书返回了空数据。");
    if (result.errcode != null && Number(result.errcode) !== 0) {
      throw new Error("微信读书请求失败（错误码 " + String(Number(result.errcode) || "未知") + "）。请检查 API Key，或稍后重试。");
    }
    return result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : result;
  }

  async fetchProgress(id) {
    return progressSnapshot(await this.api("/book/getprogress", { bookId: id }));
  }

  async fetchBookInfo(id) {
    const response = await this.api("/book/info", { bookId: id });
    const info = readBookInfo(response);
    if (!cleanTitle(response.title) && !Object.keys(info).length) {
      throw new Error("微信读书未返回这本书的详细信息。");
    }
    return info;
  }

  async fillBookInfo(file, id) {
    const info = await this.fetchBookInfo(id);
    await this.change(file, id, state => {
      state.bookInfo = { ...state.bookInfo, ...info };
    });
  }

  async change(file, bookId, action) {
    let updated;
    await this.app.vault.process(file, content => {
      const match = STATE_BLOCK.exec(content);
      if (!match) throw new Error("这份笔记里的阅读追踪区块已不存在。");
      updated = readState(match[1]);
      if (updated.bookId !== bookId) throw new Error("笔记的图书标识已改变，请重新打开笔记。");
      action(updated);
      const replacement = content.includes("\r\n") ? writeState(updated).replace(/\n/g, "\r\n") : writeState(updated);
      return content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);
    });
    for (const panel of this.panels) {
      if (panel.file === file && panel.state.bookId === bookId) {
        panel.state = updated;
        panel.render();
      }
    }
  }

  importBook(book) {
    const job = this.importQueue.then(() => this.createOrOpen(book));
    this.importQueue = job.catch(() => {});
    return job;
  }

  async createOrOpen(book) {
    const { vault, metadataCache, workspace } = this.app;
    const title = filenamePart(book.title) || "书籍";
    const id = filenamePart(book.id);
    const prefix = VAULT_FOLDER + "/" + title + "（" + id + "）";
    // The cache also finds imported notes after the user renames or moves them.
    let file = vault.getMarkdownFiles().find(candidate =>
      String(metadataCache.getFileCache(candidate)?.frontmatter?.weread_book_id ?? "") === book.id
    );
    let path = prefix + ".md";
    for (let suffix = 2; !file && vault.getAbstractFileByPath(path); suffix++) {
      const candidate = vault.getAbstractFileByPath(path);
      if (candidate instanceof TFile) {
        const block = STATE_BLOCK.exec(await vault.read(candidate));
        if (block) {
          try {
            if (readState(block[1]).bookId === book.id) file = candidate;
          } catch {
            // A file with an invalid block keeps its path; use a different filename.
          }
        }
      }
      if (!file) path = prefix + " (" + suffix + ").md";
    }
    if (file) {
      await workspace.getLeaf(false).openFile(file);
      new Notice("已打开这本书的阅读追踪笔记。");
      try {
        const block = STATE_BLOCK.exec(await vault.read(file));
        if (block && !readState(block[1]).bookInfo) await this.fillBookInfo(file, book.id);
      } catch {
        new Notice("暂时无法补全出版资料，可在笔记中点击“更新书籍信息”重试。");
      }
      return;
    }

    const params = { bookId: book.id };
    const [directory, info, progress] = await Promise.allSettled([
      this.api("/book/chapterinfo", params),
      this.fetchBookInfo(book.id),
      this.fetchProgress(book.id),
    ]);
    if (directory.status === "rejected") throw directory.reason;
    const chapters = normalizeChapters(directory.value.chapters);
    if (!chapters.length) throw new Error("微信读书没有返回这本书的目录，无法导入。");
    const metadata = info.status === "fulfilled" ? info.value : null;
    const link = metadata?.link || book.link;
    const content = [
      "---",
      "weread_book_id: " + JSON.stringify(book.id),
      "---",
      "",
      "# " + markdownText(book.title),
      "",
      (metadata?.author || book.author) ? "作者：" + markdownText(metadata?.author || book.author) : "",
      link ? "[在微信读书打开](<" + link + ">)" : "",
      "",
      writeState({
        version: VERSION, bookId: book.id, chapters, sessions: [], startedAt: null,
        bookInfo: metadata,
        weread: progress.status === "fulfilled" ? progress.value : null,
      }),
      "",
      "## 读书笔记",
      "",
    ].join("\n");

    const folder = vault.getAbstractFileByPath(VAULT_FOLDER);
    if (!folder) await vault.createFolder(VAULT_FOLDER);
    else if (!(folder instanceof TFolder)) throw new Error("已有同名文件“" + VAULT_FOLDER + "”，请将它改名后重试。");
    file = await vault.create(path, content);
    await workspace.getLeaf(false).openFile(file);
    new Notice("已导入 " + chapters.length + " 个目录项。");
  }
};
