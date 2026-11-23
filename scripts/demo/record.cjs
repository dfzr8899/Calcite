const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { encode } = require('./encode.cjs');

const root = path.resolve(__dirname, '../..');
const localBrowserCache = path.join(root, '.test-data', 'demo-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowserCache)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowserCache;
}
const { _electron: electron } = require('playwright');

const size = { width: 1280, height: 720 };
const duration = 38;
const sourceName = '夜空观测手册.md';
const sourceTitle = '周末银河观测计划';
const oldName = '月相窗口';
const newName = '无月观测窗口';
const label = '月落后的观测窗口';
const section = '出发条件';

async function installOverlay(page) {
  await page.addStyleTag({ path: path.join(__dirname, 'overlay.css') });
  await page.evaluate(() => {
    const caption = document.createElement('div');
    caption.id = 'calcite-demo-caption';
    const lines = ['demo-kicker', 'demo-title', 'demo-translation'].map(className => {
      const line = document.createElement('div');
      line.className = className;
      caption.append(line);
      return line;
    });
    const cursor = document.createElement('span');
    cursor.id = 'calcite-demo-cursor';
    cursor.ariaHidden = 'true';
    document.body.append(caption, cursor);

    window.setCalciteDemoCaption = (kicker, title, translation) => {
      const graph = document.querySelector('.graph-dialog:modal');
      (graph ?? document.body).append(caption, cursor);
      lines[0].textContent = kicker;
      lines[1].textContent = title;
      lines[2].textContent = translation;
    };

    document.addEventListener('pointermove', event => {
      cursor.style.display = 'block';
      cursor.style.transform = 'translate(' + (event.clientX - 8) + 'px,' + (event.clientY - 8) + 'px)';
    }, { passive: true });
    document.addEventListener('pointerdown', () => cursor.classList.add('is-pressed'), { passive: true });
    document.addEventListener('pointerup', () => {
      window.setTimeout(() => cursor.classList.remove('is-pressed'), 110);
    }, { passive: true });
  });
}

async function record(page, raw, vault) {
  const stamp = (kicker, title, translation) =>
    page.evaluate(args => window.setCalciteDemoCaption(...args), [kicker, title, translation]);
  const tree = page.locator('#side-content');
  const reader = page.locator('#reading');
  const link = reader.getByRole('link', { name: label, exact: true });
  const openedSource = page.locator('#tabs').getByText(sourceName, { exact: true });
  const tabTitle = page.locator('#document-name');
  const mode = value => page.locator('footer [data-mode="' + value + '"]');
  const file = name => tree.locator('[data-file]').getByText(name + '.md', { exact: true });

  async function point(locator) {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    assert(bounds, 'Expected a visible demo control');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  }

  async function click(locator, options) {
    await point(locator);
    await locator.click(options);
  }

  await tree.locator('[data-folder]').getByText('01 观测规划', { exact: true }).click();
  await openedSource.click();
  await mode('read').click();
  await reader.getByRole('heading', { name: sourceTitle, exact: true }).waitFor();
  await link.waitFor();
  await installOverlay(page);
  await stamp('CALCITE  /  MARKDOWN', '笔记一改名，旧链接会断吗？', 'What happens to links when you rename a note?');
  await page.evaluate(async () => { await document.fonts.ready; });

  await page.screencast.start({ path: raw, size, fps: 30, quality: 90 });
  const start = performance.now();
  const at = seconds => sleep(Math.max(0, seconds * 1000 - (performance.now() - start)));

  try {
    await at(4.4);
    await stamp('01  /  FOLLOW A LINK', '从计划跳到观测条件', 'Follow a link directly to a section.');
    await point(link);
    await page.locator('.hover-preview:visible').getByText(/计划在/).waitFor({ timeout: 3000 });
    await at(7.2);
    await click(link);
    await reader.getByRole('heading', { name: section, exact: true }).waitFor();
    assert.equal(await tabTitle.textContent(), oldName + '.md');

    await at(11);
    await stamp('02  /  RENAME A NOTE', '在文件树中重命名笔记', 'Rename the linked note in the file tree.');
    await click(file(oldName), { button: 'right' });
    await at(12.8);
    await click(page.getByRole('menuitem', { name: '重命名', exact: true }));
    const dialog = page.locator('dialog:is(:modal, [open])').last();
    const field = dialog.locator('[name=name]');
    await stamp('02  /  RENAME A NOTE', '把笔记改名为「无月观测窗口」', 'Give the file a more specific name.');
    await field.focus();
    await field.press('ControlOrMeta+a');
    for (const character of newName) {
      await page.keyboard.insertText(character);
      await sleep(135);
    }
    await at(16.5);
    await click(dialog.getByRole('button', { name: '确定', exact: true }));
    await page.locator('#toast').getByText(/已自动更新/).waitFor();
    await file(newName).waitFor();
    const updatedSource = await fs.readFile(path.join(vault, sourceName), 'utf8');
    const newReference = '[[' + newName + '#' + section + '|' + label + ']]';
    assert(updatedSource.includes(newReference), 'Renaming must update the real Markdown file');

    await at(19);
    await stamp('03  /  LINKS UPDATED', '原 Markdown 文件里的引用已改写', 'Calcite updates the link in the Markdown file.');
    await click(openedSource);
    await click(mode('source'));
    const editor = page.locator('#source-editor .cm-content');
    await editor.waitFor();
    assert((await editor.innerText()).includes(newReference));
    const updatedLine = editor.locator('.cm-line').filter({ hasText: newReference });
    await updatedLine.evaluate(line => line.classList.add('calcite-demo-proof'));
    await point(updatedLine);

    await at(25);
    await stamp('04  /  OPEN IT AGAIN', '原来的链接依然直达同一节', 'The same label still opens the same section.');
    await click(mode('read'));
    await at(26.4);
    await click(link);
    await reader.getByRole('heading', { name: section, exact: true }).waitFor();
    assert.equal(await tabTitle.textContent(), newName + '.md');

    await at(31.2);
    await click(page.getByRole('button', { name: '全库图谱', exact: true }));
    const graph = page.locator('.graph-dialog[open]');
    await graph.locator('.graph-count').getByText('17 篇笔记', { exact: true }).waitFor();
    await stamp('CALCITE  /  WINDOWS + ANDROID', '本地 Markdown，双链知识库', 'Local Markdown files. A connected vault.');
    await page.mouse.move(size.width - 35, size.height - 50, { steps: 12 });
    await at(duration + 0.35);
  } finally {
    await page.screencast.stop();
  }
}

async function main() {
  await fs.access(path.join(root, 'dist', 'index.html')).catch(() => {
    throw new Error('Build Calcite first with npm run build.');
  });
  const scratch = path.join(root, '.test-data');
  await fs.mkdir(scratch, { recursive: true });
  const job = await fs.mkdtemp(path.join(scratch, 'demo-capture-'));
  const vault = path.join(job, '银河观测笔记');
  const profile = path.join(job, 'profile');
  const raw = path.join(job, 'capture.webm');
  await fs.cp(path.join(root, 'docs', 'demo-vault'), vault, { recursive: true });
  await fs.cp(path.join(__dirname, 'notes'), vault, { recursive: true });
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ root: vault }));
  console.log('Recording a disposable vault in ' + job);

  const env = { ...process.env, CALCITE_TEST: '1', CALCITE_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root, path.join(vault, sourceName)], env });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(9000);
    await app.evaluate(({ BrowserWindow }, dimensions) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(dimensions.width, dimensions.height);
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    }, size);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, mobile: false, deviceScaleFactor: 1 });
    await page.locator('#app:not([inert])').waitFor();
    await page.evaluate(() => {
      window.calciteAppearance.set('theme', 'dark');
      window.calciteAppearance.set('material', 'solid');
    });
    await page.locator('html[data-theme=dark]:not([data-appearance-switching])').waitFor({ state: 'attached' });
    await record(page, raw, vault);
  } finally {
    await app.close();
  }

  await encode(raw);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
