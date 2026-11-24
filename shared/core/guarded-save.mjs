import {normalizeLineEndings} from '../text-files.mjs';
import {sameSnapshot} from './file-snapshot.mjs';

/**
 * @param {string} file
 * @param {{text: string, saved?: string, mtime?: number, snapshot?: import('./file-snapshot.mjs').FileSnapshot, resolution?: 'reload'|'overwrite'}} data
 * @param {{read: () => Promise<any>, write: (text: string, check: () => Promise<boolean>) => Promise<boolean>,
 *  archive: (text: string) => Promise<unknown>, chosen?: boolean}} host
 */
export async function guardedSave(file,data,{read,write,archive,chosen=false}) {
  const disk=await read();
  const failure=async()=>({conflict:true,...await read()});
  const matches=data.snapshot?sameSnapshot(disk?.snapshot,data.snapshot):
    disk&&disk.mtime===data.mtime&&disk.text===normalizeLineEndings(file,data.saved);
  if(!chosen&&!matches)return {conflict:true,...disk};
  if(data.resolution==='reload'){
    await archive(data.text);
    const latest=await read();
    return latest?{...latest,path:file,reloaded:true}:{conflict:true};
  }
  const text=normalizeLineEndings(file,data.text);
  if(disk&&(data.resolution==='overwrite'||disk.raw!==text))await archive(disk.raw);
  if(disk?.raw!==text){
    const written=await write(text,async()=>{
      const latest=await read();
      return disk?sameSnapshot(latest?.snapshot,disk.snapshot):!latest;
    });
    if(!written)return failure();
  }
  return {path:file,text,written:disk?.raw!==text};
}
