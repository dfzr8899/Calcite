const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname,'..');
async function run() {
  const dataRoot=path.join(root,'.test-data');
  await fs.mkdir(dataRoot,{recursive:true});
  const profile=await fs.mkdtemp(path.join(dataRoot,'knowledge-'));
  const vault=path.join(profile,'vault');
  const a=path.join(vault,'题单.md');
  const b=path.join(vault,'专题','树状数组.md');
  const template=path.join(vault,'模板','模板.md');
  await Promise.all([path.dirname(b),path.dirname(template)].map(folder=>fs.mkdir(folder,{recursive:true})));
  await fs.writeFile(a,'---\nstatus: todo\n---\n# 题单\n\n[toc]\n\n阅读[^first]。\n\n[^first]: 这是脚注。\n\n$$\nx=1\\label{test}\n$$\n\n引用 $\\eqref{test}$。\n\n## 练习\n\n正文内容。\n\n![[专题/树状数组#操作]]\n\n[[专题/树状数组#^example]]\n');
  await fs.writeFile(b,'---\ntags: [算法/数据结构]\n---\n# 树状数组\n\n## 操作\n\n更新一项并求前缀和。 ^example\n\n参见 [[题单]]。\n\n另一个场景是离线查询。\n');
  await fs.writeFile(template,'---\nkind: 模板\n---\n\n## 复盘 {{title}}\n\n今天的记录。\n');
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_DATA_DIR:profile,CALCITE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[root],env});
  const page=await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const dialog=()=>page.locator('dialog[open]').last();
  async function command(query) {
    await page.locator('.command-hint').click();
    await page.locator('#command-input').fill('>'+query);
    await page.locator('#command-results button').first().click();
  }
  async function closeView() {
    await page.locator('.workspace-view-heading button').click();
    await page.locator('dialog.workspace-view').waitFor({state:'hidden'});
  }
  try {
    await page.locator('.milkdown .ProseMirror h1').waitFor();
    await page.locator('[data-file]').filter({hasText:'题单.md'}).click();
    await page.locator('[data-mode=read]').click();
    await page.locator('.note-toc a').filter({hasText:'练习'}).waitFor();
    await page.locator('.note-footnotes li').getByText('这是脚注。').waitFor();
    await page.locator('#reading .katex-display .tag').waitFor();
    await page.locator('#reading .note-embed-content').getByText('更新一项并求前缀和。',{exact:true}).waitFor();
    await page.locator('#outline-filter').fill('练习');
    assert.equal(await page.locator('#outline [data-heading]').count(),1);
    await page.locator('#outline .outline-fold').click();
    await page.locator('#reading').getByText('正文内容。').waitFor({state:'hidden'});
    await page.locator('#outline .outline-fold').click();
    await page.locator('#reading').getByText('正文内容。').waitFor();
    await page.locator('#outline-filter').clear();
    await page.locator('#reading a[data-wiki]').filter({hasText:'#^example'}).click();
    await page.locator('#reading [data-block-id=example]').waitFor();

    await page.locator('[data-pane=search]').click();
    await page.locator('#workspace-search').fill('path:专题 tag:算法 前缀和 离线');
    await page.locator('#search-results summary').getByText('树状数组.md').waitFor();
    assert.equal(await page.locator('#search-results .search-result').count(),2);
    await page.locator('#search-regex').click();
    await page.locator('#workspace-search').fill('前缀和|离线');
    await page.locator('#search-results .search-result').first().waitFor();
    await page.locator('[data-pane=files]').click();

    await page.locator('[data-action=autosave]').click();
    await page.locator('[data-mode=source]').click();
    await page.locator('#source-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n\n[[题');
    await page.locator('.link-completion button').filter({hasText:'题单'}).waitFor();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#source-editor .cm-content').innerText(),/\[\[题单\]\]/);
    await page.keyboard.insertText('\n\n[[/题单#练');
    await page.locator('.link-completion button').getByText('练习',{exact:true}).waitFor();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#source-editor .cm-content').innerText(),/\[\[\/题单#练习\]\]/);

    await command('编辑笔记属性');
    await dialog().locator('[name=key]').fill('难度');
    await dialog().locator('[name=type]').selectOption('number');
    await dialog().locator('[name=value]').fill('7');
    await dialog().getByRole('button',{name:'保存属性'}).click();
    await page.locator('#source-editor .cm-content').getByText('难度:',{exact:false}).first().waitFor();

    await command('插入笔记模板');
    await dialog().getByRole('button',{name:'插入',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#source-editor .cm-content').innerText.includes('复盘 树状数组'));
    await command('打开今日笔记');
    await page.waitForFunction(()=>/^\d{4}-\d{2}-\d{2}\.md$/.test(document.querySelector('#document-name').textContent));
    assert.equal((await fs.readdir(path.join(vault,'Daily'))).length,1);
    await command('打开今日笔记');
    assert.equal((await fs.readdir(path.join(vault,'Daily'))).length,1);

    await page.locator('.tab').filter({hasText:'题单.md'}).click({button:'right'});
    await page.getByRole('menuitem',{name:'固定标签',exact:true}).click();
    await page.locator('.tab').filter({hasText:'题单.md'}).locator('svg.lucide-pin').waitFor();
    await page.locator('.tab').filter({hasText:'题单.md'}).click({button:'right'});
    await page.getByRole('menuitem',{name:'在右侧分栏打开',exact:true}).click();
    await page.locator('#split-pane article h1').getByText('题单').waitFor();
    await page.locator('#split-pane [data-split-mode]').selectOption('source');
    assert.match(await page.locator('#split-pane textarea').inputValue(),/\[toc\]/);
    await page.locator('[data-split-close]').click();
    await page.locator('.tab').filter({hasText:'题单.md'}).click();
    await command('收藏当前笔记或标题');
    await dialog().locator('[name=heading]').selectOption('练习');
    await dialog().getByRole('button',{name:'添加书签'}).click();
    await command('打开书签');
    await page.locator('.bookmark-list [data-bookmark]').getByText('题单.md · 练习').waitFor();
    await closeView();

    await command('打开全库图谱');
    const graph=page.locator('.graph-dialog[open]');
    const graphSearch=graph.getByRole('searchbox',{name:'筛选图谱'});
    await graphSearch.fill('树状数组');
    await graph.getByText(/^1 \/ \d+ 篇笔记$/).waitFor();
    await graphSearch.press('Enter');
    await graph.waitFor({state:'hidden'});
    await page.locator('.tab.active').getByText('树状数组.md',{exact:true}).waitFor();
    await page.locator('.tab').filter({hasText:'题单.md'}).click();
    await command('打开局部图谱');
    await graph.getByRole('button',{name:'1 跳'}).waitFor();
    await graphSearch.fill('树状数组');
    await graph.getByText(/^1 \/ \d+ 篇笔记$/).waitFor();
    await page.keyboard.press('Escape');
    await graph.waitFor({state:'hidden'});
    await command('打开属性视图');
    await dialog().locator('[name=property]').selectOption('难度');
    await dialog().locator('[name=filter]').fill('7');
    await page.locator('.bases-results').getByRole('button',{name:'树状数组.md'}).waitFor();
    await dialog().locator('[name=layout]').selectOption('cards');
    await page.locator('.base-cards article').waitFor();
    await closeView();

    await command('打开 Canvas');
    const canvasDialog=()=>page.locator('dialog[open]:not(.workspace-view)');
    await page.locator('[data-canvas-action=text]').click();
    await canvasDialog().locator('textarea').fill('知识地图');
    await canvasDialog().getByRole('button',{name:'确定'}).click();
    await page.locator('[data-canvas-action=file]').click();
    await canvasDialog().locator('[name=file]').selectOption('专题/树状数组.md');
    await canvasDialog().getByRole('button',{name:'确定'}).click();
    await page.locator('[data-canvas-action=connect]').click();
    await page.locator('.canvas-card').filter({hasText:'知识地图'}).click();
    await page.locator('[data-canvas-action=save]').click();
    await canvasDialog().locator('[name=name]').fill('测试画布');
    await canvasDialog().getByRole('button',{name:'保存',exact:true}).click();
    await page.locator('.canvas-status').getByText('已保存',{exact:true}).waitFor();
    const canvas=JSON.parse(await fs.readFile(path.join(vault,'测试画布.canvas'),'utf8'));
    assert.equal(canvas.nodes.length,2);
    assert.equal(canvas.edges.length,1);
    await closeView();
    assert.deepEqual(errors,[]);
    console.log('Knowledge workspace smoke passed.');
  } catch(error) {
    console.error(await page.locator('#toast').textContent().catch(()=>''),errors);
    await page.screenshot({path:path.join(profile,'failure.png')}).catch(()=>{});
    throw error;
  } finally {
    await app.evaluate(({app})=>app.exit()).catch(()=>{});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
