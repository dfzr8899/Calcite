import {t as tr} from "../../shared/i18n/index.mjs";
import {Capacitor,registerPlugin} from '@capacitor/core';

export const nativeSecureStore=registerPlugin('CalciteSecureStorage');

export function createMobileSecrets(nativeStore=Capacitor.isPluginAvailable('CalciteSecureStorage')?nativeSecureStore:null) {
  const memory=new Map();
  let available=false;
  return {
    get available(){return available;},
    async read(id) {
      try {available=Boolean(nativeStore&&(await nativeStore.available()).available);}
      catch {available=false;}
      const result={};
      for(const name of ['pat','peer']){
        const key=id+'.'+name;
        if(memory.has(key))result[name]=memory.get(key);
        else if(available){
          try{result[name]=(await nativeStore.get({key})).value||'';}
          catch{available=false;result[name]='';}
        }else result[name]='';
      }
      return result;
    },
    async write(id,secrets) {
      for(const name of ['pat','peer']){
        const value=secrets[name];
        if(value===undefined)continue;
        const key=id+'.'+name;
        // Deletion must reach native storage even when its last availability check failed.
        if(nativeStore&&(available||value==='')) {
          try {await nativeStore.set({key,value});memory.delete(key);continue;}
          catch(error) {
            available=false;
            if(value==='')throw new Error(tr("capacitorSecureStorage.couldNotClearCredentialsFromSecureStorage"),{cause:error});
          }
        }
        memory.set(key,value);
      }
    }
  };
}
