const path=require('node:path');
const fs=require('node:fs/promises');
const {createRequire}=require('node:module');

module.exports=async function installedPackage(name,from) {
  const requireFrom=createRequire(path.join(from,'package.json'));
  const locations=requireFrom.resolve.paths(name)||requireFrom.resolve.paths('calcite-package-lookup');
  for(const entry of locations) {
    const directory=path.join(entry,name);
    const manifest=await fs.readFile(path.join(directory,'package.json'),'utf8').then(JSON.parse,error=>{
      if(error.code!=='ENOENT')throw error;
      return null;
    });
    if(manifest?.name===name)return {directory,manifest};
  }
  throw Error('Cannot locate installed package '+name);
};
