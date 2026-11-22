const desktopOnly=async()=>{throw Error('此操作需要在 Calcite 桌面应用中使用。');};
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
    window:{control:desktopOnly,discard:async()=>window.confirm('丢弃这篇文档的未保存修改？'),quit:desktopOnly,ready:empty,
      async external(url){if (/^https?:\/\//i.test(url)) window.open(url,'_blank','noopener,noreferrer');}},
    preferences:{saveSession:noop,saveFeatures:noop},
    events:{action:noop,externalChange:noop,focus:noop,windowState:noop,sync:noop}
  };
}
