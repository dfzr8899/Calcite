import {getLocale, t as tr} from "../i18n/index.mjs";
import {Buffer} from 'buffer';
import {syncUrl} from '../sync-url.mjs';

/** @import {SyncConfig, VaultRecord} from './types.mjs' */
/** @typedef {Partial<SyncConfig> & {pat?: string, peerToken?: string, pairing?: string}} SyncSettingsInput */
/** @typedef {{pat?: string, peer?: string}} SyncSecrets */
/** @typedef {{vaultId: string, token: string, url: string, peerName?: string, endpoints?: string[]}} PairingPacket */

export const vaultIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const peerTokenPattern=/^[0-9a-f]{64}$/;
/** @type {SyncConfig} */
export const defaults={enabled:false,conflictStrategy:'lww-history',mode:'lan',auto:true,wifiOnly:null,listen:false,port:0,remoteUrl:'',
  remoteUser:'',branch:'main',name:'Calcite',email:'calcite@local',peerUrl:'',peerVaultId:'',peerName:'',endpoints:[],deviceName:'Calcite'};
const branch=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

export function repositoryUrl(value,testLoopback=false) {
  const url=syncUrl(value,{testLoopback});
  url.pathname=url.pathname.replace(/\/+$/,'');
  if(url.hostname==='github.com'&&/^\/[^/]+\/[^/]+$/.test(url.pathname)&&!/\.git$/i.test(url.pathname))
    url.pathname+='.git';
  return url.href.replace(/\/$/,'');
}

export function readPacket(text,prefix) {
  if(typeof text!=='string'||text.length>8192||!text.startsWith(prefix))throw Error(tr("syncConfig.invalidPairingCode"));
  const input=text.slice(prefix.length);
  if(!/^[A-Za-z0-9_-]+$/.test(input))throw Error(tr("syncConfig.invalidPairingCode"));
  try{return JSON.parse(Buffer.from(input.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));}
  catch{throw Error(tr("syncConfig.invalidPairingCode"));}
}
export function writePacket(prefix,payload) {
  return prefix+Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
/**
 * @param {Partial<SyncConfig>} previous
 * @param {SyncSettingsInput} input
 * @param {SyncSecrets} priorSecrets
 * @param {{testLoopback?: boolean, mobile?: boolean}} [options]
 */
export function applySettings(previous,input,priorSecrets,{testLoopback=false,mobile=false}={}) {
  const next={...defaults,...previous},secrets={...priorSecrets};
  const fields=/** @type {(keyof SyncConfig)[]} */ (Object.keys(defaults));
  for(const name of fields)if(name!=='endpoints'&&name!=='peerName'&&Object.hasOwn(input,name))Object.assign(next,{[name]:input[name]});
  if(next.conflictStrategy!=='conflict-copy')next.conflictStrategy='lww-history';
  if(input.pat!==undefined)secrets.pat=input.pat;
  if(input.peerToken!==undefined)secrets.peer=input.peerToken;
  if(next.remoteUrl)next.remoteUrl=repositoryUrl(next.remoteUrl,testLoopback);
  let previousUrl=previous.remoteUrl;
  if(previousUrl)try{previousUrl=repositoryUrl(previousUrl,testLoopback);}catch{}
  if(next.remoteUrl!==previousUrl&&input.pat===undefined)secrets.pat='';
  if(!branch.test(next.branch)||next.branch.includes('..')||next.branch.endsWith('/')||
    next.branch.split('/').some(name=>!name||name.startsWith('.')||name.endsWith('.lock')))
    throw Error(tr("syncConfig.invalidGitBranchName"));
  if(!/^[^\s<>@]+@[^\s<>@]+$/.test(next.email))throw Error(tr("syncConfig.enterAValidCommitterEmail"));
  if(input.pairing) {
    /** @type {PairingPacket} */
    const row=readPacket(input.pairing,'calcite-sync:');
    if(!row||!vaultIdPattern.test(row.vaultId)||!peerTokenPattern.test(row.token)||typeof row.url!=='string')throw Error(tr("syncConfig.invalidPairingCode"));
    next.peerUrl=row.url;
    next.peerVaultId=row.vaultId;
    next.peerName=String(row.peerName||'').slice(0,80);
    next.endpoints=Array.isArray(row.endpoints)?row.endpoints.slice(0,12):[];
    secrets.peer=row.token;
  } else if(next.peerVaultId!==previous.peerVaultId||next.peerUrl!==previous.peerUrl) {
    next.endpoints=[];
    if(input.peerToken===undefined&&(next.peerVaultId!==previous.peerVaultId||!next.peerUrl))secrets.peer='';
    if(next.peerVaultId!==previous.peerVaultId||!next.peerUrl)next.peerName='';
  }
  if(secrets.peer&&!peerTokenPattern.test(secrets.peer))throw Error(tr("syncConfig.thePairingTokenMustBe64Hexadecimal"));
  if(input.peerToken===''&&!input.pairing) {
    next.peerUrl='';next.peerVaultId='';next.peerName='';next.endpoints=[];
  }
  if(next.peerUrl) {
    if(!vaultIdPattern.test(next.peerVaultId)||next.mode==='lan'&&!secrets.peer)throw Error(tr("syncConfig.lanSyncRequiresThePeerVaultId"));
    next.peerUrl=syncUrl(next.peerUrl,{lan:true}).href.replace(/\/$/,'');
    next.endpoints=[...new Set([next.peerUrl,...next.endpoints.map(value=>syncUrl(value,{lan:true}).href.replace(/\/$/,''))])];
  }else next.endpoints=[];
  if(mobile)next.listen=false;
  return {next,secrets};
}

/**
 * Stores the public configuration separately from credential storage. Desktop
 * callers can attach their existing encrypted values to the returned object.
 * @param {SyncConfig} settings
 * @param {Omit<VaultRecord, 'settings'|'encrypted'>} metadata
 * @returns {VaultRecord}
 */
export function vaultRecord(settings,metadata) {
  return {settings,...metadata};
}

/** @param {Pick<SyncConfig, 'wifiOnly'>} settings */
export const wifiOnly=settings=>settings.wifiOnly??false;
/** @param {Pick<SyncConfig, 'mode'|'peerUrl'|'remoteUrl'>} settings */
export const configured=settings=>Boolean(settings.mode==='lan'?settings.peerUrl:settings.remoteUrl);

export function remoteError(error) {
  const causes=[error,error.cause,error.cause?.cause].filter(Boolean);
  const code=causes.map(cause=>cause.code).find(Boolean)||'';
  const status=causes.map(cause=>cause.data?.statusCode).find(Boolean);
  const details=[...new Set(causes.flatMap(cause=>[cause.code,cause.message]).filter(Boolean))]
    .join(' · ').replace(/https?:\/\/[^\s<>"']+/gi,tr("syncConfig.repositoryUrl"))
    .replace(/(?:bearer|basic)\s+[\w+/.=-]+|\b(?:github_pat_|gh[pousr]_)[\w]+/gi,tr("syncConfig.credential"))
    .replace(/\s+/g,' ').slice(0,420);
  const reason=causes.some(cause=>cause.name==='TimeoutError')||/tim(e|ed)out|超时/i.test(details)?tr("syncConfig.theRemoteGitConnectionTimedOut"):
    status===401||status===403||/auth/i.test(code)?tr("syncConfig.remoteAuthenticationFailedOrTheTokenLacks"):
    status===404?tr("syncConfig.theGitRepositoryWasNotFoundOr"):
    code==='PushRejectedError'||code==='MergeNotSupportedError'?tr("syncConfig.theRemoteBranchChangedSyncAgain"):
    code==='NotFoundError'?tr("syncConfig.theRemoteBranchOrCommitDoesNot"):
    tr("syncConfig.remoteGitOperationFailed");
  const httpStatus=status?(getLocale()==='zh-CN'?'（HTTP '+status+'）':' (HTTP '+status+')'):'';
  return reason+httpStatus+(details?' · '+details:'');
}
