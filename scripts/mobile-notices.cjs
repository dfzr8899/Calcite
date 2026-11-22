const fs=require('node:fs/promises');
const path=require('node:path');

async function copyNotices() {
  const root=path.resolve(__dirname,'..');
  const destinations={android:'android/app/src/main/assets/public',ios:'ios/App/App/public'};
  const target=destinations[process.env.CAPACITOR_PLATFORM_NAME];
  if(!target)return;
  await Promise.all(['LICENSE','assets/THIRD-PARTY-NOTICES.txt'].map(source=>
    fs.copyFile(path.join(root,source),path.join(root,target,path.basename(source)))));
}

copyNotices().catch(error=>{console.error(error);process.exitCode=1;});
