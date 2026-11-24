import {getLocale, renderMessage, t as tr} from "../shared/i18n/index.mjs";
import {errorMessage} from './error-message.js';

export const remotePhaseLabels=()=>({check:tr("syncSettings.checkRemote"),fetch:tr("syncSettings.fetch"),merge:tr("syncSettings.mergeWrite"),push:tr("syncSettings.push")});
export const phaseTimes=timings=>Object.entries(remotePhaseLabels()).map(([phase,label])=>label+' '+Math.round(timings[phase]||0)+' ms').join(' · ');

const syncLabels=()=>({off:tr("main.off"),pending:tr("mobileVaultManager.pending"),working:tr("syncSettings.syncing"),synced:tr("mobileVaultManager.synced"),offline:tr("syncSettings.offline"),conflict:tr("syncSettings.conflicts"),error:tr("mobileVaultManager.syncError")});
export function syncLabel(state, compact=false) {
  const count=state.status==='conflict'?state.conflicts?.length:state.pendingCount;
  const numbered=['offline','pending','conflict'].includes(state.status);
  const labels=syncLabels();
  if(compact&&getLocale()==='en-US')return (labels[state.status]||labels.off)+(numbered&&count?' ('+count+')':'');
  if(state.status==='working'&&state.progress) {
    const {phase,done,total,timings}=state.progress;
    const phases={snapshot:tr("syncSettings.committingLocalChanges"),connect:tr("syncSettings.connectingToPeer"),negotiate:tr("syncSettings.negotiatingGitObjects"),
      pull:tr("syncSettings.fetchingObjects"),push:tr("syncSettings.pushingObjects"),write:tr("syncSettings.writingWorkspaceFiles"),index:tr("syncSettings.updatingIndex")};
    if(timings){
      const names=remotePhaseLabels();
      const completed=Object.keys(timings).map(key=>names[key]+' '+Math.round(timings[key])+' ms');
      return [...completed,names[phase]?names[phase]+tr("syncSettings.label"):phases[phase]].filter(Boolean).join(' · ')+
        (total?' '+done+'/'+total:'');
    }
    if(phases[phase])return phases[phase]+(total?' '+done+'/'+total:'');
  }
  if(state.status==='synced'&&(state.logs?.[0]?.detail?.key==='gitSync.alreadyUpToDate'||state.logs?.[0]?.message===tr("gitSync.alreadyUpToDate")))return tr("syncSettings.upToDate");
  return (labels[state.status]||labels.off)+(numbered&&count?' ('+count+')':'');
}
export const syncMessage=row=>row&&(row.detail&&typeof row.detail==='object'?renderMessage(row.detail):errorMessage(row.message));
