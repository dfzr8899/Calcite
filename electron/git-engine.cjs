const fs=require('node:fs/promises');
const path=require('node:path');
const {atomicWrite,within}=require('./workspace.cjs');
const {createGitEngine,FILE_LIMIT,OID}=require('../shared/core/git-engine.mjs');

const GitEngine=createGitEngine({fs,path,atomicWrite,within,caseInsensitive:process.platform==='win32'});
module.exports={GitEngine,FILE_LIMIT,OID};
