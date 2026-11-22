export function errorMessage(error) {
  const message = String(error?.message ?? error ?? '').trim().replace(
    /^(?:(?:Error invoking remote method\s+['"][^'"]+['"]:\s*|(?:[A-Za-z]*Error|DOMException):\s*))+/, ''
  ).trim();
  if (/^(?:局域网 |EIO:|远程|远端|连接远程 Git|未找到 Git|无法初始化此知识库|本地 Git 初始化)/.test(message)) return message;
  if (/\bEADDRINUSE\b/.test(message)) return '监听端口已被占用，请更换端口或设为 0 自动选择。';
  if (/\b(?:EPERM|EACCES)\b/.test(message)) return '权限不足，请检查文件或工作区权限。';
  if (/\b(?:ENOENT|ENOTDIR)\b/.test(message)) return '文件或目录已不存在，请刷新后重试。';
  if (/\b(?:ENOSPC|EDQUOT)\b/.test(message)) return '磁盘可用空间不足，释放空间后请重试。';
  if (/\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH)\b/.test(message)) return '无法连接对端，请检查连接地址、同网段与防火墙。'+message;
  if (/\p{Script=Han}/u.test(message)) return message;
  return '操作未能完成，请检查当前设置后重试。';
}
