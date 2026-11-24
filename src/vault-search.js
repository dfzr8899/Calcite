import {t as tr} from "../shared/i18n/index.mjs";
import SearchWorker from './search-worker.js?worker&inline';

export function createVaultSearch(snapshot) {
  let worker, cursor, pending, request=0;
  function cancel() {
    request++;
    if (pending) pending(null,true);
  }
  function reset() {
    cancel();
    worker?.terminate();
    worker=undefined;
    cursor=undefined;
  }
  async function query(options) {
    cancel();
    const id=request;
    const update=await snapshot(cursor);
    if (id!==request) return null;
    worker??=new SearchWorker();
    return new Promise(resolve=>{
      const running=worker;
      const timer=setTimeout(()=>finish({error:tr("vaultSearch.searchTimedOutNarrowTheSearchOr")},true),5000);
      function finish(result,restart=false) {
        clearTimeout(timer);
        pending=undefined;
        if (restart) {
          running.terminate();
          worker=undefined;
          cursor=undefined;
        } else cursor=update.cursor??undefined;
        resolve(result);
      }
      pending=finish;
      running.onmessage=event=>finish(event.data);
      running.onerror=()=>finish({error:tr("vaultSearch.couldNotCompleteTheSearch")},true);
      running.postMessage({...options,update});
    });
  }
  return {cancel,reset,query};
}
