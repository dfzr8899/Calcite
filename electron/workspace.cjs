const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const {withinNativePath}=require('../shared/core/vault-paths.mjs');

const markdown = /\.(md|markdown|mdown)$/i;
const excluded = new Set(['node_modules', 'release', 'dist']);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (parent, child) => withinNativePath(path,parent,child);
const slash = value => value.split(path.sep).join('/');
const encode=value=>slash(value).split('/').map(part=>encodeURIComponent(part).replace(/[()]/g,c=>c==='('? '%28':'%29')).join('/');
const {linkDirectory:createLinkDirectory}=require('../shared/note-links.mjs');
const linkDirectory=(root,notes)=>createLinkDirectory(root,path,key,notes);

const resolver=(root,notes)=>linkDirectory(root,notes).resolve;

function validName(name) {
  if (typeof name !== 'string' || !name || /^[.]|[. ]$|[<>:"/\\|?*\x00-\x1f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || excluded.has(name.toLowerCase())) {
    throw Error('名称不可用，请换一个文件或文件夹名称。');
  }
  return name;
}

async function atomicWrite(target, data) {
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, data, { flag: 'wx' });
    await fs.rename(temp, target);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

function historyStore(root) {
  const dir = note => path.join(root, createHash('sha256').update(key(note)).digest('hex'));
  async function entries(note) {
    const folder = dir(note);
    const ids = await fs.readdir(folder).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    const results = ids.filter(id => /^\d{13}-[0-9a-f-]{36}\.md$/.test(id)).sort().reverse().map(id => ({id, time: Number(id.slice(0,13))}));
    const legacy = path.join(root, createHash('sha256').update(note).digest('hex') + '.md');
    const stat = await fs.stat(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat) results.push({id:'legacy',time:stat.mtimeMs});
    return { folder, legacy, results };
  }
  async function record(note, text, limit) {
    const { folder, results } = await entries(note);
    await fs.mkdir(folder, {recursive:true});
    await fs.writeFile(path.join(folder, Date.now() + '-' + randomUUID() + '.md'), text, {flag:'wx'});
    const keep = Math.max(1, Math.min(100, Number(limit) || 20));
    await Promise.all(results.filter(row => row.id !== 'legacy').slice(keep - 1).map(row => fs.unlink(path.join(folder, row.id))));
  }
  return {
    record,
    async list(note) { return (await entries(note)).results; },
    async read(note, id) {
      const {folder,legacy,results} = await entries(note);
      if (!results.some(row => row.id === id)) throw Error('找不到该历史快照。');
      return fs.readFile(id === 'legacy' ? legacy : path.join(folder,id), 'utf8');
    },
    async relocate(from, to, limit) {
      if (dir(from) === dir(to)) return;
      const previous = await entries(from);
      if (!previous.results.length) return;
      const next = await entries(to);
      await fs.mkdir(next.folder, {recursive:true});
      for (const row of previous.results) {
        const filename = row.id === 'legacy' ? Math.trunc(row.time) + '-' + randomUUID() + '.md' : row.id;
        await fs.copyFile(row.id === 'legacy' ? previous.legacy : path.join(previous.folder,row.id), path.join(next.folder,filename));
      }
      const keep = Math.max(1, Math.min(100, Number(limit) || 20));
      const updated = await entries(to);
      await Promise.all(updated.results.filter(row => row.id !== 'legacy').slice(keep).map(row => fs.unlink(path.join(next.folder,row.id))));
    }
  };
}

module.exports = { markdown, resolver, linkDirectory, validName, within, key, atomicWrite, historyStore, encode };
