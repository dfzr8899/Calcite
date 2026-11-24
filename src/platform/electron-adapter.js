export function electronAdapter() {
  const bridge=window.desktop;
  if (!bridge) return null;
  return {
    type:'electron',os:bridge.platform,
    fs:{open:bridge.open,read:bridge.read,save:bridge.save,release:bridge['release-file'],reveal:bridge.reveal,
      attachment:bridge.attachment,history:bridge.history,revealImage:bridge.revealImage},
    workspace:{bootstrap:bridge.bootstrap,folder:bridge.folder,close:bridge['close-vault'],tree:bridge.tree,edit:bridge['workspace-edit'],
      recentVaults:bridge['recent-vaults'],switchVault:bridge['switch-vault'],
      listCanvases:bridge['canvas-files'],readCanvas:bridge['canvas-read'],saveCanvas:bridge['canvas-save']},
    activity:{list:bridge['activity:list'],undo:bridge['activity:undo'],empty:bridge['activity:empty']},
    index:{target:bridge['note-target'],backlinks:bridge.backlinks,graph:bridge['workspace-graph'],
      links:bridge['workspace-links'],health:bridge['workspace-health'],
      notes:bridge['workspace-notes'],search:bridge.search,searchSnapshot:bridge['search-index']},
    export:{pdf:bridge.pdf,document:bridge['export-document'],image:bridge['export-image'],pandoc:bridge['pandoc-export'],rich:bridge['export-rich'],markdown:bridge['export-markdown']},
    attachments:{scan:bridge['attachments:scan'],trash:bridge['attachments:trash']},
    sync:{status:bridge['sync:status'],configure:bridge['sync:configure'],run:bridge['sync:run'],test:bridge['sync:test'],
      pair:bridge['sync:pair'],revoke:bridge['sync:revoke'],clearConflict:bridge['sync:clear-conflict'],resolve:bridge['sync:resolve'],
      conflictFiles:bridge['sync:conflict-files'],archiveConflicts:bridge['sync:archive-conflicts'],restoreVersion:bridge['sync:restore-version'],
      remotePair:bridge['sync:remote-pair'],cancelRemotePair:bridge['sync:cancel-remote-pair'],network:bridge['sync:network']},
    clipboard:{writeText:bridge.writeClipboardText,paste:bridge.pasteClipboard},
    window:{control:bridge.windowControl,setAppearance:bridge.setWindowAppearance,external:bridge.external,
      discard:bridge.discard,quit:bridge.quit,ready:bridge.rendererReady},
    preferences:{saveSession:bridge.session,saveFeatures:bridge.features,saveLanguage:bridge.setLanguage},
    events:{action:bridge.onAction,externalChange:bridge.onExternalChange,focus:bridge.onWindowFocus,windowState:bridge.onWindowState,sync:bridge.onSync}
  };
}
