const fs = require('node:fs/promises');
const path = require('node:path');
const installedPackage=require('./installed-package.cjs');

const root=path.resolve(__dirname,'..');
const bundles=new Map();
const filenamePattern=/^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i;
const electronVersion=require('electron/package.json').version;
const stageTwo=['@replit/codemirror-vim','isomorphic-git','diff3','bonjour-service','qrcode','fflate'];
const manifest=require('../package.json');
const stageThree=[...Object.keys({...manifest.dependencies,...manifest.devDependencies}).filter(name=>name.startsWith('@capacitor/')),
  'buffer','typescript'];

async function children(folder) {
  try { return await fs.readdir(folder,{withFileTypes:true}); }
  catch(error) { if(error.code==='ENOENT')return []; throw error; }
}

async function walk(folder,scope=false) {
  for (const record of await children(folder)) {
    if (!record.isDirectory()||record.name.startsWith('.')) continue;
    const directory=path.join(folder,record.name);
    if (!scope&&record.name.startsWith('@')) {
      await walk(directory,true);
      continue;
    }
    let manifest;
    try { manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8')); }
    catch(error) { if (error.code!=='ENOENT')throw error; }
    if (manifest?.name&&manifest.version) {
      const id=manifest.name+' '+manifest.version;
      const previous=bundles.get(id)??{manifest,files:new Map()};
      for (const file of await children(directory)) {
        if (!file.isFile()||!filenamePattern.test(file.name)) continue;
        const content=(await fs.readFile(path.join(directory,file.name),'utf8')).trim();
        if (content&&!previous.files.has(content)) previous.files.set(content,file.name);
      }
      bundles.set(id,previous);
    }
    await walk(path.join(directory,'node_modules'));
  }
}

function license({manifest,files}) {
  if (manifest.name==='dompurify') return 'Apache-2.0 (selected from the upstream MPL-2.0 OR Apache-2.0 offer)';
  if (manifest.license) return typeof manifest.license==='string'?manifest.license:JSON.stringify(manifest.license);
  if (manifest.licenses) return JSON.stringify(manifest.licenses);
  for (const text of files.keys()) {
    if (/^(?:the )?mit license/i.test(text)) return 'MIT (identified in the included license text)';
    if (/^apache license/i.test(text)) return 'Apache-2.0 (identified in the included license text)';
  }
  return files.size?'See included license text':'Review required (no license metadata or text found)';
}

async function checkLicenses(roots,stage,strictDirect=false) {
  const visited=new Set();
  const permissive=/^(?:MIT|BSD-(?:2|3)-Clause|ISC|Apache-2\.0|0BSD|CC0-1\.0|BlueOak-1\.0\.0|Unlicense|Zlib)(?:\s*\(identified|$)/;
  async function inspect(name,from,direct=false) {
    const {directory,manifest}=await installedPackage(name,from);
    const item=bundles.get(manifest.name+' '+manifest.version);
    const statement=item&&license(item);
    const terms=statement?.trim().replace(/^\((.*)\)$/,'$1').split(/\s+(?:AND|OR)\s+/);
    if(!terms?.every(term=>(strictDirect&&direct?/^(MIT|Apache-2\.0)$/:permissive).test(term)))
      throw Error('Review required for '+stage+' license: '+name+' '+statement);
    if(visited.has(directory))return;
    visited.add(directory);
    for(const child of Object.keys(manifest.dependencies||{}))await inspect(child,directory);
  }
  for(const name of roots)await inspect(name,root,true);
  return visited.size;
}

async function generate() {
  await walk(path.join(root,'node_modules'));
  const checked=await checkLicenses(stageTwo,'stage 2');
  const mobile=await checkLicenses(stageThree,'stage 3',true);
  await checkLicenses(['jsqr'],'stage 4 QR decoding',true);
  for(const [id,item] of bundles) {
    const declared=license(item);
    if(/\b(?:A?GPL|GNU (?:Affero )?General Public License)(?![A-Za-z])/i.test(declared))
      throw Error('GPL/AGPL dependency: '+id+' ('+declared+')');
  }
  const header=[
    'Calcite third-party notices',
    '',
    'Calcite application code is licensed under MIT. The following notices cover',
    'installed third-party dependencies, including nested and build dependencies.',
    'Inclusion in this inventory does not imply that a package ships at runtime.',
    'DOMPurify is redistributed under its Apache-2.0 license option.',
    'KaTeX fonts are distributed under MIT (https://github.com/KaTeX/katex-fonts/blob/master/LICENSE).',
    'The stage 2 editor, export and sync packages and their dependency chains were checked for permissive licenses.',
    'The stage 3 Capacitor packages, Buffer and TypeScript use MIT or Apache-2.0.',
    'Their npm dependencies were checked separately for permissive licenses.',
    'jsQR is used for on-device QR decoding under Apache-2.0.',
    '',
    'The desktop packages include upstream Electron '+electronVersion+' and its native components.',
    'See LICENSE.electron.txt and LICENSES.chromium.html beside the application executable.',
    'Electron release and source: https://github.com/electron/electron/releases/tag/v'+electronVersion,
    'Electron Chromium dependency revisions: https://github.com/electron/electron/blob/v'+electronVersion+'/DEPS',
    'Pandoc, if installed by the user, is an external tool and is not in this installer.',
    ''
  ];
  const records=[...bundles].sort(([first],[second])=>first.localeCompare(second));
  for (const [id,item] of records) {
    header.push('='.repeat(70),id,'License: '+license(item),'');
    for (const [content,name] of item.files) header.push('--- '+name+' ---',content,'');
  }
  await fs.writeFile(path.join(root,'assets','THIRD-PARTY-NOTICES.txt'),header.join('\n')+'\n');
  console.log('Third-party notices generated for '+records.length+' package versions.');
  console.log('Stage 2 permissive license check passed for '+checked+' dependency locations.');
  console.log('Stage 3 direct MIT/Apache-2.0 and transitive permissive check passed for '+mobile+' dependency locations.');
  console.log('jsQR license is Apache-2.0. No GPL or AGPL npm license declarations found.');
}

generate().catch(error=>{console.error(error);process.exitCode=1;});
