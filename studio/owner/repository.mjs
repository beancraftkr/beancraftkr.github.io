import {assertOwnedDraftKey,ownsDraftKey,recoverableDraftKey,legacyDraftEvidence,REVIEW_DRAFT_UID} from './draft-keys.mjs';
import {clone,execute,safeId,same} from './model.mjs';
const valueAt=(root,path)=>path.split('/').filter(Boolean).reduce((v,k)=>v?.[k],root)??null;
export function createReviewRepository({store,program,editorId,instanceId,journal}){
 if(!store?.read||!store?.compareAndSwap||!program?.execute)throw Error('durable GUIDE review store and fixed source program required');
 let snapshot=null,queue=Promise.resolve(),closed=false,unknown=false;const callbacks=new Set(),urlToRef=new Map(),refToUrl=new Map();
 const read=async()=>{snapshot=await store.read();return snapshot;};
 async function run(command){if(closed)throw Error('repository disposed');const key=JSON.stringify(command);let intent=await journal?.get(key);if(intent&&JSON.stringify(intent.command)!==key)throw Error('command journal identity mismatch');if(unknown&&!intent)throw Error('미확인 저장 결과를 같은 작업으로 먼저 확인해 주세요.');if(!intent){const s=await read();intent={commandId:crypto.randomUUID(),expectedRevision:s.revision,command};await journal?.set(key,intent);}let result;
  try{result=await program.execute(intent);}catch(e){if(e.status>=400&&e.status<500){await journal?.delete(key);unknown=false;}else unknown=true;throw e;}
  const response=result?.normalResponse;if(!response||!Number.isInteger(response.status)){unknown=true;throw Error('저장 결과 미확인: 같은 작업으로 다시 확인해 주세요.');}if(response.status>=400){await journal?.delete(key);throw Error(response.body?.message||'정상 프로그램이 저장을 거절했습니다.');}await journal?.delete(key);unknown=false;await read();for(const cb of callbacks)cb();return response;
 }
 const command=c=>{const promise=queue.then(()=>run(c));queue=promise.catch(()=>{});return promise;};
 async function hydrate(v){if(typeof v==='string'&&/^guide-asset:[a-f0-9]{64}$/.test(v)){if(refToUrl.has(v))return refToUrl.get(v);const hash=v.slice(12),owner=Object.keys(snapshot.root?.assets?.[hash]?.owners||{})[0];if(!owner)throw Error('asset owner missing');const r=await command({action:'asset.read',sha256:hash,owner});const url='data:'+r.headers['Content-Type']+';base64,'+r.bodyBase64;refToUrl.set(v,url);urlToRef.set(url,v);return url;}if(v&&typeof v==='object'){const out=Array.isArray(v)?[]:{};for(const[k,x]of Object.entries(v))out[k]=await hydrate(x);return out;}return v;}
 async function dehydrate(v,owner=editorId){if(typeof v==='string'&&v.startsWith('data:')){if(urlToRef.has(v))return urlToRef.get(v);const m=/^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(v);if(!m)throw Error('지원하지 않는 등록 자료 형식입니다.');const r=await command({action:'asset.register',mime:m[1],bodyBase64:m[2],owner});const ref=r.body.assetRef;urlToRef.set(v,ref);refToUrl.set(ref,v);return ref;}if(v&&typeof v==='object'){const out=Array.isArray(v)?[]:{};for(const[k,x]of Object.entries(v))out[k]=await dehydrate(x,owner);return out;}return v;}
 async function state(){await read();return hydrate(snapshot.root||{});}
 const draftStore={
 async claim(){await command({action:'lane.claim',lane:editorId,instance:instanceId});},
 async release(){await command({action:'lane.release',lane:editorId,instance:instanceId});},
 async get(key){assertOwnedDraftKey(key,{uid:REVIEW_DRAFT_UID,lane:editorId});const s=await state();return clone(s.drafts?.[key]);},
 async list(prefix){const s=await state();return Object.entries(s.drafts||{}).filter(([key])=>key.startsWith(prefix)&&ownsDraftKey(key,{uid:REVIEW_DRAFT_UID,lane:editorId})).map(([key,value])=>({key,value:clone(value)}));},
 async readLegacy(key){const s=await state();return legacyDraftEvidence(key,{uid:REVIEW_DRAFT_UID,lane:editorId},clone(s.drafts?.[key]));},
 async listRecovery(prefix){const s=await state();return Object.entries(s.drafts||{}).filter(([key,value])=>key.startsWith(prefix)&&recoverableDraftKey(key,{uid:REVIEW_DRAFT_UID,lane:editorId},value)).map(([key,value])=>legacyDraftEvidence(key,{uid:REVIEW_DRAFT_UID,lane:editorId},clone(value)));},
 async set(key,value){await command({action:'draft.save',lane:editorId,instance:instanceId,key,value:await dehydrate(value)});},
 async deleteIf(key,predicate){const s=await state(),v=s.drafts?.[key];if(v&&!predicate(v))return false;if(!v)return true;await command({action:'draft.delete',lane:editorId,instance:instanceId,key,base:await dehydrate(v)});return true;}
 };
 // These are the original Studio SDK-shaped calls, with domain-specific normal commands.
 function ref(path='',expectedBase){const callbacksByFn=new Map(),supplied=expectedBase!==undefined;let observed=clone(expectedBase??null);
  async function get(){const s=await state();const value=valueAt(s,path);if(!supplied)observed=clone(value);return{val:()=>clone(value)};}
  async function set(value){const parts=path.split('/');if(parts[0]==='posts'&&parts.length===2){safeId(parts[1]);const base=observed;return command({action:'post.save',id:parts[1],base:await dehydrate(base),value:await dehydrate(value)});}if(parts[0]==='posts'&&parts.length===3&&parts[2]==='status'){const s=await state(),base=s.posts?.[parts[1]];if(!base)throw Error('post missing');return command({action:'post.save',id:parts[1],base:await dehydrate(base),value:await dehydrate({...base,status:value})});}if(parts[0]==='agreements'&&parts.length===2)return command({action:'agreement.prepare',id:parts[1],base:await dehydrate(observed),value:await dehydrate(value)});throw Error('검토에서는 게시·공개 링크·서명·무효화·개인정보 파기를 실행하지 않습니다.');}
  return{once:get,on(event,fn,error){const cb=()=>get().then(fn).catch(error);callbacks.add(cb);callbacksByFn.set(fn,cb);cb();},off(event,fn){const cb=callbacksByFn.get(fn);if(cb)callbacks.delete(cb);},set,remove:async()=>{const parts=path.split('/'),base=clone(observed);if(parts.length!==2||!['posts','agreements'].includes(parts[0]))throw Error('invalid normal delete');return command({action:parts[0]==='posts'?'post.delete':'agreement.delete',id:parts[1],base:await dehydrate(base)});},transaction:async()=>{throw Error('검토 자료는 실제 공개 원장에 배포되지 않습니다.');},update:async()=>{throw Error('검토에서는 실제 개인정보 파기를 실행하지 않습니다.');}};
 }
 const db={ref};
 const unsubscribe=store.subscribe?.(()=>{read().then(()=>{for(const cb of callbacks)cb();}).catch(()=>{});});
 return{db,async resumePending(){const rows=await journal.list();for(const intent of rows)await command(intent.command);return{reconciled:rows.length,commands:rows.map(intent=>clone(intent.command))};},recordRef:(path,base)=>ref(path,base),draftStore,command,dehydrate,async saveTeam(team,base){return command({action:'team.save',base:await dehydrate(base),value:await dehydrate(team)});},async flush(){await queue;if(unknown)throw Error('저장 결과를 먼저 확인해 주세요.');},get unknown(){return unknown;},async dispose(){await this.flush();unsubscribe?.();closed=true;callbacks.clear();}};
}
// Native adapter only scopes subscriptions and exact-record CAS; safe marketing publisher stays intact.
export function scopeNativeDatabase(db,{verify=async()=>{}}={}){const listeners=new Set(),observed=new Map();let active=true;
 const wrap=(path,expectedBase)=>{const original=db.ref(path),recordPath=path?.match(/^(posts|agreements)\/([^/]+)/)?.[0],callbacks=new Map();return{
 once:async(...args)=>{const s=await original.once(...args);observed.set(path,clone(s.val()));return s;},
 on(event,fn,error){
  const cb=s=>{if(!active)return;const v=s.val();if(path==='posts'||path==='agreements')for(const[id,item]of Object.entries(v||{}))observed.set(path+'/'+id,clone(item));observed.set(path,clone(v));fn(s);};
  original.on(event,cb,e=>{if(active)error?.(e)});
  const stop=()=>{original.off(event,cb);listeners.delete(stop);callbacks.get(event)?.delete(fn);};
  if(!callbacks.has(event))callbacks.set(event,new Map());
  callbacks.get(event).set(fn,stop);listeners.add(stop);
 },
 off(event,fn){callbacks.get(event)?.get(fn)?.();},async set(value){if(!active)throw Error('editor disposed');await verify();if(!recordPath)return original.set(value);let conflict=false;const recordRef=db.ref(recordPath),suffix=path.slice(recordPath.length+1),base=clone(expectedBase===undefined?(observed.get(recordPath)??null):expectedBase);const result=await recordRef.transaction(current=>{if(!same(current,base)){conflict=true;return;}if(!suffix)return value;const next=clone(current);if(!next)return;let target=next;const keys=suffix.split('/'),last=keys.pop();for(const k of keys)target=target[k]??={};if(value==null)delete target[last];else target[last]=value;return next;},undefined,false);if(!result.committed)throw Error(conflict?'다른 작업자가 먼저 수정했습니다. 현재 입력을 유지했습니다.':'저장되지 않았습니다.');observed.set(recordPath,clone(result.snapshot.val()));return result;},
 remove(){return this.set(null);},transaction:async(...args)=>{if(!active)throw Error('editor disposed');await verify();return original.transaction(...args)},update:async(...args)=>{if(!active)throw Error('editor disposed');await verify();return original.update(...args)}};};return{db:{ref:wrap},recordRef:(path,base)=>wrap(path,base),dispose(){active=false;for(const fn of listeners)fn();}};
}
