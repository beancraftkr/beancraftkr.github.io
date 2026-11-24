import {assertOwnedDraftKey,ownsDraftKey,editorClaimKey,editorScopeIdentity,recoverableDraftKey,legacyDraftEvidence} from './draft-keys.mjs';
export function openLocalDraftStore({indexedDB,uid,lane,instance}){
 const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('bc_studio_drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 async function transaction(mode,work){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('kv',mode),store=tx.objectStore('kv');let result;work(store,v=>{result=v},e=>{try{tx.abort()}catch{}reject(e)});tx.oncomplete=()=>{db.close();resolve(result)};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error||Error('초안 저장 실패'))};});}
 const scope={uid,lane},identity=editorScopeIdentity(uid,lane),claimKey=editorClaimKey(uid,lane);
 if(typeof instance!=='string'||!instance)throw Error('editor instance required');
 const validClaim=record=>record?.version===2&&record.identity===identity&&record.uid===uid&&record.lane===lane;
 const ownClaim=record=>validClaim(record)&&record.instance===instance;
 const writable=(key,record)=>assertOwnedDraftKey(key,{uid,lane},record);
 return{
 async get(key){if(key!==claimKey)writable(key);return transaction('readonly',(s,out)=>{const r=s.get(key);r.onsuccess=()=>out(r.result)});},
 readLegacy:key=>transaction('readonly',(s,out,fail)=>{const r=s.get(key);r.onsuccess=()=>{try{out(legacyDraftEvidence(key,scope,r.result));}catch(error){fail(error);}};}),
 list:prefix=>transaction('readonly',(s,out)=>{const rows=[],r=s.openCursor();r.onsuccess=()=>{const cur=r.result;if(cur){if(typeof cur.key==='string'&&cur.key.startsWith(prefix)&&ownsDraftKey(cur.key,scope))rows.push({key:cur.key,value:cur.value});cur.continue()}else out(rows)}}),
 listRecovery:prefix=>transaction('readonly',(s,out)=>{const rows=[],r=s.openCursor();r.onsuccess=()=>{const cur=r.result;if(cur){if(typeof cur.key==='string'&&cur.key.startsWith(prefix)&&recoverableDraftKey(cur.key,scope,cur.value))rows.push(legacyDraftEvidence(cur.key,scope,cur.value));cur.continue();}else out(rows);};}),
 set(key,value){writable(key,value);return transaction('readwrite',(s,out,fail)=>{const claim=s.get(claimKey);claim.onsuccess=()=>{if(!ownClaim(claim.result))return fail(Error('편집 세션 소유권을 확인하지 못했습니다.'));s.put(value,key);out(true)}})},
 deleteIf(key,check){writable(key);return transaction('readwrite',(s,out,fail)=>{const claim=s.get(claimKey);claim.onsuccess=()=>{if(!ownClaim(claim.result))return fail(Error('편집 세션 소유권이 다릅니다.'));const r=s.get(key);r.onsuccess=()=>{try{writable(key,r.result);}catch(error){fail(error);return;}if(!r.result||check(r.result)){s.delete(key);out(true)}else out(false)}}})},
 claim(){return transaction('readwrite',(s,out,fail)=>{const r=s.get(claimKey);r.onsuccess=()=>{if(r.result&&!ownClaim(r.result))return fail(Error('같은 편집 세션이 이미 열려 있습니다. 새 편집기에서 이전 초안을 비교·복구해 주세요.'));s.put({version:2,identity,uid,lane,instance},claimKey);out(true)}})},
 release(){return transaction('readwrite',(s,out,fail)=>{const r=s.get(claimKey);r.onsuccess=()=>{if(!r.result){out(true);return;}if(!ownClaim(r.result))return fail(Error('다른 세션의 소유권을 해제할 수 없습니다.'));s.delete(claimKey);out(true)}})}
 };
}
