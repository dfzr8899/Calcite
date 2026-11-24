import {t as tr} from "./i18n/index.mjs";
import git from 'isomorphic-git';
import {remoteError} from './core/sync-config.mjs';

export async function syncRemote(engine,transport,branch,accept,{last,progress=()=>{},currentHead=()=>engine.head()}={}) {
  try {
    const before=await engine.head();
    const timings={};
    const measure=async(phase,task)=>{
      const start=performance.now();
      progress({phase,timings:{...timings}});
      const result=await task();
      timings[phase]=performance.now()-start;
      return result;
    };
    const ref='refs/heads/'+branch;
    const advertised=await measure('check',async()=>{
      const discovered=await git.getRemoteInfo2({...transport,protocolVersion:1});
      return discovered.refs.find(row=>row.ref===ref)?.oid??null;
    });
    if(advertised===last&&before===last&&await currentHead()===last)
      return {push:0,head:before,before,timings,upToDate:true};
    let fetched=advertised;
    if(advertised!==null&&advertised!==last&&advertised!==before) {
      fetched=await measure('fetch',async()=>{
        const localRef=await git.currentBranch(engine.args);
        const previous=last&&before&&(last===before||await git.isDescendent({...engine.args,oid:before,ancestor:last,depth:-1}));
        const refspec='+refs/heads/*:refs/remotes/calcite-sync/*';
        if(await git.getConfig({...engine.args,path:'remote.calcite-sync.fetch'})!==refspec)
          await git.setConfig({...engine.args,path:'remote.calcite-sync.fetch',value:refspec});
        const args={...engine.args,...transport,ref:localRef,remoteRef:ref,remote:'calcite-sync',singleBranch:true,tags:false};
        let result;
        try{result=await git.fetch({...args,...(previous?{}:{depth:1})});}
        catch(error){
          if(previous||error.code!=='RemoteCapabilityError')throw error;
          result=await git.fetch(args);
        }
        return result.fetchHead;
      });
    }
    if(fetched&&fetched!==before&&fetched!==last)await measure('merge',()=>accept(fetched,timings));
    const local=await currentHead(),pushed=local&&local!==fetched;
    let push=0;
    if(pushed) {
      await measure('push',async()=>{
        await engine.objects(local,fetched);
        const localRef=await git.currentBranch(engine.args);
        const result=await git.push({...engine.args,...transport,ref:localRef,remoteRef:ref,remote:'calcite-sync',
          onPrePush:({remoteRef})=>remoteRef.oid===(fetched||'0'.repeat(40))});
        if(!result.ok)throw Error(tr("syncRemote.theRemoteRejectedThePush"));
        const [baseline,final]=await Promise.all([engine.tracked(fetched),engine.tracked(local)]);
        for(const file of new Set([...final.keys(),...baseline.keys()]))if(final.get(file)!==baseline.get(file))push++;
      });
    }
    return {push,head:local,before,timings,upToDate:!pushed&&fetched===before};
  }catch(error){throw Error(remoteError(error),{cause:error});}
}

export async function pendingCommits(engine,last) {
  const head=await engine.head();
  if(!head||head===last)return 0;
  let count=0,oid=head;
  const boundaries=await engine.shallow();
  while(oid&&oid!==last&&count<10000) {
    count++;
    const {commit}=await git.readCommit({...engine.args,oid});
    oid=boundaries.has(oid)?null:commit.parent[0];
  }
  return count;
}
