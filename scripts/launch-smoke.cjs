const { _electron: electron } = require('playwright');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const runFile = promisify(execFile);
const root = path.resolve(__dirname,'..');

async function run() {
  const executablePath = path.resolve(process.argv[2] || path.join(root,'release','win-unpacked','Calcite.exe'));
  const testDir = path.join(root,'.test-data');
  await fs.mkdir(testDir,{recursive:true});
  const cwd = await fs.mkdtemp(path.join(testDir,'launch-'));
  const cold = '冷启动 测试.md';
  const warm = '运行中 打开.markdown';
  const another = '另一篇 笔记.mdown';
  const names = [cold,warm,another];
  await Promise.all(names.map(name=>fs.writeFile(path.join(cwd,name),`# ${name}\n\n用于验证文件打开。`)));
  const env = {...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:path.join(cwd,'profile')};
  delete env.ELECTRON_RUN_AS_NODE;

  const started = Date.now();
  const app = await electron.launch({executablePath,args:[path.join(cwd,cold)],env});
  try {
    const page = await app.firstWindow();
    const open = (...args)=>runFile(executablePath,args,{env,cwd,windowsHide:true,timeout:15000});
    const earlyRequests = Promise.all([open(warm),open(another)]);
    await page.locator('#app:not([inert])').waitFor();
    const readyMs = Date.now()-started;
    await earlyRequests;
    for (const name of names) {
      const tab = page.locator('#tabs .tab').getByText(name,{exact:true});
      await tab.waitFor();
      assert.equal(await tab.count(),1);
    }
    await open(cold);
    await page.waitForFunction(name=>document.querySelector('#document-name').textContent===name,cold);
    assert.equal(await page.locator('#tabs .tab').getByText(cold,{exact:true}).count(),1);
    assert.equal(await page.locator('#startup-status').isHidden(),true);
    console.log(`文件启动验证通过（${readyMs} ms）。中文及空格文件名、相对路径、多次唤起与重复标签均已检查。`);
  } finally {
    await app.close();
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
