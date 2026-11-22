const {spawnSync}=require('node:child_process');
const path=require('node:path');

const suites=[
  'smoke','security-smoke','layout-smoke','appearance-smoke','graph-smoke',
  'workspace-smoke','knowledge-smoke','watcher-index-smoke','export-editor-smoke',
  'v12-sync-smoke','interaction-smoke','mobile-smoke','offline-auto-sync-smoke',
  'editor-index-smoke','pkm-foam-smoke'
];

for(const suite of suites){
  console.log('\nRunning '+suite);
  const result=spawnSync(process.execPath,[path.join(__dirname,suite+'.cjs')],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
