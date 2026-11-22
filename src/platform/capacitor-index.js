import {basename,dirname,posixPath} from './capacitor-git-fs.js';
import {VaultIndex,CACHE_LIMIT,CACHE_DIRECTORY,CACHE_FILE,fileSignature} from '../../shared/core/vault-index.mjs';
import {withinPosix as within} from '../../shared/core/vault-paths.mjs';
import {markdown} from '../../shared/note-links.mjs';
import {randomId} from '../random-id.js';

export {markdown,within};
const path={basename,dirname,sep:'/',relative(root,file){
    const from=root.split('/').filter(Boolean),to=file.split('/').filter(Boolean);
    let common=0;
    while(common<from.length&&from[common]===to[common])common++;
    return [...Array(from.length-common).fill('..'),...to.slice(common)].join('/');
  },
  resolve(...parts){
    try{return posixPath(...parts);}catch{return '/';}
  }};
const key=file=>file;

export const indexEntry=(file,stat)=>({row:{path:file,modified:stat.mtimeMs},size:stat.size,signature:fileSignature(stat)});

export function createCapacitorIndex(root,io,atomicWrite,signal) {
  const folder=posixPath(root,CACHE_DIRECTORY),cache=posixPath(folder,CACHE_FILE);
  return new VaultIndex(root,{path,key,within,signal,generation:randomId(),searchLimit:Infinity,
    async read(file,item){
      try{
        const current=item??indexEntry(file,await io.stat(file));
        const text=await io.readFile(file,'utf8');
        return {item:current,text};
      }catch(error){if(error.code!=='ENOENT')throw error;}
    },
    async readCache(){
      if(!root)return '';
      const stat=await io.stat(cache);
      return stat.isFile()&&stat.size<=CACHE_LIMIT?io.readFile(cache,'utf8'):'';
    },
    async writeCache(text){
      if(signal?.aborted||!root)return;
      await io.mkdir(folder).catch(error=>{if(error.code!=='EEXIST')throw error;});
      await io.writeFile(posixPath(folder,'.gitignore'),'*\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      if(!signal?.aborted)await atomicWrite(cache,text);
    }
  });
}
