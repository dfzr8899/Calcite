const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');

const fields=['dependencies','devDependencies','optionalDependencies','peerDependencies'];

function declaredLicense(value){
  const expression=String(value??'').trim().replace(/^\(([^()]*)\)$/,'$1');
  if(/[()]/.test(expression))return false;
  return expression.split(/\s+OR\s+/).some(part=>part.split(/\s+AND\s+/)
    .every(term=>/^(MIT|Apache-2\.0)$/.test(term.trim())));
}

function describe(location,entry,root){
  const direct=fields.filter(field=>Object.hasOwn(root[field]||{},location.replace(/^node_modules\//,'')));
  const fingerprint=createHash('sha256').update(JSON.stringify([
    location,entry.version,entry.license??null,entry.integrity??entry.resolved??null,direct
  ])).digest('hex');
  return {fingerprint,location,version:entry.version,license:entry.license??null};
}

function checkLicenses(manifest,lock,baseline){
  if(!lock.packages?.[''])throw Error('A complete npm lockfile is required.');
  const root=lock.packages[''];
  for(const field of fields){
    const declared=manifest[field]||{}, locked=root[field]||{};
    if(Object.keys(declared).length!==Object.keys(locked).length||
      Object.keys(declared).some(name=>declared[name]!==locked[name]))throw Error('package.json and package-lock.json disagree on '+field);
  }
  const exceptions=new Map(baseline.map(entry=>[entry.location,entry.fingerprint]));
  let accepted=0;
  const violations=[];
  for(const [location,entry] of Object.entries(lock.packages)){
    if(!location||declaredLicense(entry.license))continue;
    const record=describe(location,entry,root);
    if(exceptions.get(location)===record.fingerprint)accepted++;
    else violations.push(record);
  }
  return {accepted,violations};
}

function main(){
  const root=path.resolve(__dirname,'..');
  const manifest=require(path.join(root,'package.json'));
  const lock=require(path.join(root,'package-lock.json'));
  const baseline=require('./license-baseline.json');
  const {accepted,violations}=checkLicenses(manifest,lock,baseline);
  if(violations.length){
    for(const {location,version,license} of violations)
      console.error(location+'@'+version+' uses '+(license||'an unspecified license'));
    throw Error('New or changed npm packages require MIT or Apache-2.0.');
  }
  // Verify installed metadata when available. Other platform variants are audited
  // from the lockfile even when npm omits them on this host.
  for(const [location,entry] of Object.entries(lock.packages)){
    if(!location)continue;
    const installed=path.join(root,location,'package.json');
    if(!fs.existsSync(installed))continue;
    const found=JSON.parse(fs.readFileSync(installed,'utf8'));
    if(found.version!==entry.version||found.license!==entry.license)
      throw Error('Installed package metadata differs from package-lock.json: '+location);
  }
  console.log('Dependency license gate passed. '+accepted+' exact legacy entries accepted.');
}

if(require.main===module){
  try{main();}catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={checkLicenses,declaredLicense,describe};
