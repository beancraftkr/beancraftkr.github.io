// One normal mutation boundary for browser drafts and the durable review program.
export const REVIEW_DRAFT_UID='review-guide';
export const encodeDraftUid=uid=>{if(typeof uid!=='string'||!uid)throw Error('nonempty scope identity required');return Array.from(uid).map(ch=>ch.codePointAt(0).toString(16).padStart(6,'0')).join('');};
export const editorScopeIdentity=(uid,lane)=>{if(typeof uid!=='string'||!uid||typeof lane!=='string'||!lane)throw Error('nonempty scope identity required');return 'v2:'+JSON.stringify([uid,lane]);};
export const editorFormKey=(uid,lane)=>'forms:'+editorScopeIdentity(uid,lane);
export const editorClaimKey=(uid,lane)=>'claim:'+editorScopeIdentity(uid,lane);
export const legacyFormKey=(uid,lane)=>'forms_'+uid+'_'+lane;
export const legacyClaimKey=(uid,lane)=>'claim_'+uid+'_'+lane;
export const editorDraftKey=(uid,lane)=>'draft_v2_'+encodeDraftUid(uid)+'_'+lane;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ownsDraftKey(key,{uid,lane},record){
 if(typeof key!=='string'||typeof uid!=='string'||!uid||typeof lane!=='string'||!lane||key.length>4096)return false;
 if(key===editorFormKey(uid,lane))return true;
 if(!/^[-A-Za-z0-9_]{1,4096}$/.test(key))return false;
 const base=editorDraftKey(uid,lane);
 if(key===base)return !record?.uid||record.uid===uid;
 // Publication journals carry the exact captured editor key and an independent UUID.
 if(key==='publish_'+base)return !record||(record.actor?.uid===uid&&record.capture?.key===base);
 const prefix='publish-intent_'+base+'_';
 if(key.startsWith(prefix)){const id=key.slice(prefix.length);return uuid.test(id)&&(!record||(record.id===id&&record.actor?.uid===uid&&record.capture?.key===base));}
 const commandPrefix='command_'+lane+'_';
 return uid===REVIEW_DRAFT_UID&&key.startsWith(commandPrefix)&&/^[0-9a-f]{2,16}$/.test(key.slice(commandPrefix.length));
}
export function assertOwnedDraftKey(key,scope,record){if(!ownsDraftKey(key,scope,record))throw Error('draft outside exact UID/editor lane');}

// Deliberate read-only recovery never grants mutation rights to old ambiguous keys.
export function recoverableDraftKey(key,{uid,lane},record){
 if(typeof key!=='string')return false;
 if(ownsDraftKey(key,{uid,lane})||key===editorClaimKey(uid,lane))return true;
 if(key===legacyFormKey(uid,lane)||key===legacyClaimKey(uid,lane)||key==='draft_'+uid)return true;
 if(key.startsWith('draft_v2_'+encodeDraftUid(uid)+'_'))return !record?.uid||record.uid===uid;
 if(key.startsWith('forms:v2:')){try{const pair=JSON.parse(key.slice('forms:v2:'.length));return Array.isArray(pair)&&pair.length===2&&pair[0]===uid&&typeof pair[1]==='string'&&editorFormKey(pair[0],pair[1])===key;}catch{return false;}}
 if((key.startsWith('publish_')||key.startsWith('publish-intent_'))&&record?.actor?.uid===uid)return true;
 return false;
}
export function legacyDraftEvidence(key,scope,record){
 if(!recoverableDraftKey(key,scope,record))throw Error('recovery outside UID/editor scope');
 return {key,value:record,readOnly:true,legacy:true,ambiguous:key===legacyFormKey(scope.uid,scope.lane)||key===legacyClaimKey(scope.uid,scope.lane)};
}
