const fs = require('node:fs/promises');
const path = require('node:path');
const {spawnSync}=require('node:child_process');
const installedPackage=require('./installed-package.cjs');
const {build,Platform,Arch} = require('electron-builder');
const manifest = require('../package.json');

async function stageRuntime(root,stage) {
  const direct=['chokidar','js-yaml','marked','mdast-util-from-markdown','fflate','isomorphic-git','diff3','bonjour-service','qrcode'];
  const dependencies=Object.fromEntries(direct.map(name=>[name,manifest.dependencies[name]]));
  const staged=new Set();
  async function copy(name,from) {
    const {directory:folder,manifest:pkg}=await installedPackage(name,from);
    const relative=path.relative(root,folder);
    if (!relative.startsWith('node_modules'+path.sep)) throw Error('无法定位桌面运行时依赖 '+name);
    if (staged.has(relative)) return;
    staged.add(relative);
    await fs.cp(folder,path.join(stage,relative),{recursive:true,filter:file=>file===folder||
      !path.relative(folder,file).split(path.sep).includes('node_modules')});
    for (const dependency of Object.keys(pkg.dependencies||{})) await copy(dependency,folder);
  }
  for (const name of direct) await copy(name,root);
  return dependencies;
}

async function packageApp() {
  const installerOnly = process.argv.includes('--installer-only');
  const requested=process.argv.find(arg=>arg.startsWith('--platform='))?.split('=')[1];
  const host={win32:'windows',darwin:'mac',linux:'linux'}[process.platform];
  if(!host||requested&&requested!==host)throw Error('请在对应平台运行打包。');
  const windows=host==='windows',mac=host==='mac';
  const platform=windows?Platform.WINDOWS:mac?Platform.MAC:Platform.LINUX;
  const arch=process.arch==='arm64'&&!windows?Arch.arm64:Arch.x64;
  const formats=windows?(installerOnly?['nsis']:['nsis','portable']):mac?['dmg','zip']:['AppImage'];
  const root = path.resolve(__dirname,'..');
  const release = path.resolve(root,process.env.CALCITE_RELEASE_DIR||'release');
  await fs.mkdir(release,{recursive:true});
  function run(executable,args) {
    const result=spawnSync(executable,args,{cwd:root,stdio:'inherit'});
    if (result.error) throw result.error;
    if (result.status!==0) throw Error('发布构建失败。');
  }
  const executableDirectory=path.dirname(require('electron'));
  const distribution=mac?path.resolve(executableDirectory,'../../..'):executableDirectory;
  const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js');
  run(process.execPath,[path.join(__dirname,'notices.cjs')]);
  run(process.execPath,[vite,'build']);
  const stage=await fs.mkdtemp(path.join(release,'.packaging-'));
  const output=path.join(stage,'output');
  try {
    for (const item of ['dist','electron','shared','assets','LICENSE']) {
      await fs.cp(path.join(root,item),path.join(stage,item),{recursive:true});
    }
    const {name,version,description,main,license} = manifest;
    const dependencies=await stageRuntime(root,stage);
    await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name,version,description,main,license,dependencies,author:'Calcite contributors'}));
    await build({
      projectDir:stage,
      publish:'never',
      targets:platform.createTarget(formats,arch),
      config:{
        ...manifest.build,
        executableName:'Calcite',
        directories:{output,buildResources:path.join(root,'assets')},
        electronDist:distribution,
        electronVersion:require('electron/package.json').version,
        npmRebuild:false,
        forceCodeSigning:process.env.CALCITE_REQUIRE_SIGNING==='1',
        win:{icon:path.join(root,'assets/icon.ico')},
        mac:{icon:path.join(root,'assets/icon.png'),category:'public.app-category.productivity',
          artifactName:'Calcite-${version}-${arch}.${ext}',...(process.env.CSC_LINK?{}:{identity:null})},
        linux:{icon:path.join(root,'assets/icon.png'),category:'Office',artifactName:'Calcite-${version}-${arch}.${ext}'},
        nsis:{
          artifactName:'Calcite-Setup.exe',
          include:path.join(__dirname,'installer.nsh'),
          oneClick:false,
          allowToChangeInstallationDirectory:true,
          uninstallDisplayName:'Calcite',
          differentialPackage:false,
          runAfterFinish:true
        },
        portable:{artifactName:'Calcite.exe',requestExecutionLevel:'user',unpackDirName:false}
      }
    });
    if(!windows){
      const files=(await fs.readdir(output)).filter(file=>/\.(?:dmg|zip|AppImage)$/.test(file));
      if(files.length!==formats.length)throw Error('发行产物不完整。');
      for(const file of files){
        await fs.copyFile(path.join(output,file),path.join(release,file));
        console.log(path.join(release,file));
      }
      return;
    }
    for (const name of ['LICENSE.electron.txt','LICENSES.chromium.html']) {
      const notice=await fs.stat(path.join(output,'win-unpacked',name));
      if (!notice.isFile()||!notice.size) throw Error('发行包缺少运行时许可 '+name);
    }
    await fs.copyFile(path.join(output,'Calcite-Setup.exe'),path.join(release,'Calcite-Setup.exe'));
    if (!installerOnly) {
      await fs.copyFile(path.join(output,'Calcite.exe'),path.join(release,'Calcite.exe'));
      await fs.cp(path.join(output,'win-unpacked'),path.join(release,'win-unpacked'),{recursive:true});
    }
    console.log('安装包：'+path.join(release,'Calcite-Setup.exe'));
  } finally {
    const stagingPath = await fs.realpath(stage);
    if (path.dirname(stagingPath) !== await fs.realpath(release)) throw Error('打包临时目录不在发行目录下');
    await fs.rm(stagingPath,{recursive:true,force:true});
  }
}

packageApp().catch(error=>{console.error(error);process.exitCode=1;});
