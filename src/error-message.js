import {getLocale, knownDiagnostic, t as tr, translateDiagnostic} from "../shared/i18n/index.mjs";
export function errorMessage(error) {
  const message = String(error?.message ?? error ?? '').trim().replace(
    /^(?:(?:Error invoking remote method\s+['"][^'"]+['"]:\s*|(?:[A-Za-z]*Error|DOMException):\s*))+/, ''
  ).trim();
  if (knownDiagnostic(message)) return translateDiagnostic(message);
  if (/^(?:EIO:|LAN |Remote |The remote |Local Git |Could not initialize (?:local Git|sync))/i.test(message)) return message;
  if (getLocale()==='zh-CN'&&/^(?:局域网 |远程|远端|连接远程 Git|未找到 Git|无法初始化此知识库|本地 Git 初始化)/.test(message)) return message;
  if (/\bEADDRINUSE\b/.test(message)) return tr("errorMessage.thePortIsInUseChooseAnother");
  if (/\b(?:EPERM|EACCES)\b/.test(message)) return tr("errorMessage.accessDeniedCheckFileOrWorkspacePermissions");
  if (/\b(?:ENOENT|ENOTDIR)\b/.test(message)) return tr("errorMessage.theFileOrFolderNoLongerExists");
  if (/\b(?:ENOSPC|EDQUOT)\b/.test(message)) return tr("errorMessage.thereIsNotEnoughDiskSpaceFree");
  if (/\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH)\b/.test(message)) return tr("errorMessage.couldNotReachThePeerCheckIts")+message;
  if (getLocale()==='zh-CN'&&/\p{Script=Han}/u.test(message)) return message;
  return tr("errorMessage.theActionCouldNotBeCompletedCheck");
}
