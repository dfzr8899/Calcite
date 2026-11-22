const normalized=(path,fileKey)=>fileKey(path).replaceAll('\\','/').replace(/\/$/,'');

export function updateTree(rows, root, changes, fileKey) {
  const normalize=path=>normalized(path,fileKey);
  const treeRoot=normalize(root);
  const index=new Map();
  function gather(list) {
    for (const row of list) {
      index.set(normalize(row.path),list);
      if (row.children) gather(row.children);
    }
  }
  gather(rows);
  for (const change of changes) {
    const id=normalize(change.path);
    if (change.row) continue;
    if (id===treeRoot) {rows.length=0;index.clear();continue;}
    const parent=index.get(id);
    if (!parent) continue;
    const at=parent.findIndex(row=>normalize(row.path)===id);
    if (at!==-1) parent.splice(at,1);
    index.delete(id);
  }
  for (const change of changes.filter(change=>change.row).sort((a,b)=>a.path.length-b.path.length)) {
    const id=normalize(change.path);
    if (id===treeRoot) continue;
    const parentId=id.slice(0,id.lastIndexOf('/'));
    const siblings=index.get(parentId);
    const parent=parentId===treeRoot?rows:siblings?.find(row=>normalize(row.path)===parentId)?.children;
    if (!parent) continue;
    const before=parent.find(row=>normalize(row.path)===id);
    if (before) Object.assign(before,change.row,change.row.children?{children:before.children||[]}:{});
    else {parent.push(change.row);index.set(id,parent);}
  }
}

export function containsPath(parent,child,fileKey) {
  const folder=normalized(parent,fileKey), target=normalized(child,fileKey);
  return target===folder||target.startsWith(folder+'/');
}
