const {spawnSync}=require('node:child_process');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const android=path.join(root,'android');
const windows=process.platform==='win32';

function run(command,args,{cwd=root,env=process.env}={}){
  const result=spawnSync(command,args,{cwd,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}

run(process.execPath,[path.join(__dirname,'package.cjs'),'--installer-only'],{
  env:{...process.env,CALCITE_RELEASE_DIR:process.env.CALCITE_RELEASE_DIR||'.test-data/verify-release'}
});
const cliManifest=require.resolve('@capacitor/cli/package.json');
const cli=path.resolve(path.dirname(cliManifest),require(cliManifest).bin.cap);
run(process.execPath,[cli,'sync','android']);

const tasks=[':app:assembleRelease',':app:assembleDebug',':app:testDebugUnitTest'];
if(process.env.CALCITE_GRADLE_OFFLINE==='1')tasks.push('--offline');
if(windows)run(process.env.ComSpec||'cmd.exe',['/d','/c','gradlew.bat',...tasks],{cwd:android});
else run('bash',['./gradlew',...tasks],{cwd:android});
