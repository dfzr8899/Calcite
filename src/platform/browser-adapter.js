import {t as tr} from "../../shared/i18n/index.mjs";
const desktopOnly=async()=>{throw Error(tr("browserAdapter.thisActionIsAvailableInTheCalcite"));};
const empty=async()=>[];
const noop=()=>{};

export function browserAdapter() {
  return {
    type:'browser',os:'browser',
    fs:{open:desktopOnly,read:desktopOnly,save:desktopOnly,release:noop,reveal:desktopOnly,revealImage:desktopOnly,attachment:desktopOnly,history:desktopOnly},
    workspace:{bootstrap:async()=>({root:'',config:{},initialFiles:[]}),folder:desktopOnly,close:desktopOnly,tree:empty,edit:desktopOnly,
      listCanvases:desktopOnly,readCanvas:desktopOnly,saveCanvas:desktopOnly},
    index:{target:desktopOnly,backlinks:empty,graph:desktopOnly,notes:empty,search:empty,
      links:empty,health:async()=>({orphans:[],issues:[]}),
      searchSnapshot:async()=>({cursor:null,full:true,notes:[],removed:[]})},
    export:{pdf:desktopOnly,document:desktopOnly,image:desktopOnly,pandoc:desktopOnly,rich:desktopOnly,markdown:desktopOnly},
    attachments:{scan:desktopOnly,trash:desktopOnly},
    sync:{status:async()=>({status:'off'}),configure:desktopOnly,run:desktopOnly,test:desktopOnly,pair:desktopOnly,revoke:desktopOnly,clearConflict:desktopOnly},
    clipboard:{writeText:text=>navigator.clipboard.writeText(text)},
    window:{control:desktopOnly,discard:async()=>window.confirm(tr("browserAdapter.discardUnsavedChangesToThisNote")),quit:desktopOnly,ready:empty,
      async external(url){if (/^https?:\/\//i.test(url)) window.open(url,'_blank','noopener,noreferrer');}},
    preferences:{saveSession:noop,saveFeatures:noop},
    events:{action:noop,externalChange:noop,focus:noop,windowState:noop,sync:noop}
  };
}
