import {t as tr} from "../i18n/index.mjs";
/** @param {string[]} parts */
export function posixPath(...parts) {
  const result = [];
  for (const part of parts.join('/').replaceAll('\\','/').split('/')) {
    if (!part || part==='.') continue;
    if (part==='..') {
      if (!result.length) throw fsError('EACCES',parts.join('/'));
      result.pop();
    } else {
      if (part.includes('\0')) throw fsError('EINVAL',part);
      result.push(part);
    }
  }
  return '/'+result.join('/');
}

/** @type {(dir: string, file: string) => boolean} */
export const withinPosix=(dir,file)=>file===dir||file.startsWith(dir==='/'?dir:dir+'/');

/**
 * @param {{relative(parent: string, child: string): string, isAbsolute(path: string): boolean, sep: string}} path
 * @param {string} parent
 * @param {string} child
 */
export function withinNativePath(path,parent,child) {
  const relative=path.relative(parent,child);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
}

/**
 * @param {string} code
 * @param {string} path
 * @param {{code?: string, message?: string}} [cause]
 */
export function fsError(code,path,cause) {
  const nativeCode=cause?.code;
  const detail=code==='EIO'&&cause?
    ` ${tr("vaultPaths.nativeFileError")}`+(nativeCode&&nativeCode!==code?' '+nativeCode:'')+'：'+String(cause.message||cause):'';
  return Object.assign(new Error(code+': '+path+detail,{cause}),{code,path,nativeCode});
}
