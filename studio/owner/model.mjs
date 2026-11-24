import {assertOwnedDraftKey,REVIEW_DRAFT_UID} from './draft-keys.mjs';
// Normal GUIDE review repository. No provider credentials, SDK or external effects.
export const SOURCE='beancraft-guides';
export const MAX_ROOT_BYTES=2*1024*1024;
export const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
export function canonical(value){if(value==null)return 'null';if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
export const same=(a,b)=>canonical(a)===canonical(b);
export function safeId(id){if(typeof id!=='string'||!/^[-A-Za-z0-9_]{1,180}$/.test(id))throw Error('invalid identifier');return id;}
export function validateRoot(root){
 if(root===null)return null;
 if(!root||Array.isArray(root)||root.source!==SOURCE||root.schemaVersion!==1)throw Error('invalid GUIDE root');
 const allowed=new Set(['source','schemaVersion','marketing','posts','agreements','drafts','lanes','assets']);
 for(const key of Object.keys(root))if(!allowed.has(key))throw Error('unexpected root field '+key);
 const walk=(v,depth=0)=>{if(depth>80)throw Error('root depth');if(typeof v==='number'&&!Number.isFinite(v))throw Error('invalid number');if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k)||/[\u0000-\u001f]/.test(k))throw Error('invalid key');walk(x,depth+1);}}};walk(root);
 if(new TextEncoder().encode(JSON.stringify(root)).length>MAX_ROOT_BYTES)throw Error('root capacity');
 for(const branch of ['posts','agreements','drafts','lanes','assets'])if(root[branch]&&(Array.isArray(root[branch])||typeof root[branch]!=='object'))throw Error('invalid '+branch);

 for(const[id,p]of Object.entries(root.posts||{})){safeId(id);if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.title!=='string'||p.title.length>80||typeof(p.caption||'')!=='string'||(p.caption||'').length>2200||typeof(p.hashtags||'')!=='string'||(p.hashtags||'').length>500||!['draft','ready','claimed','published','error'].includes(p.status||'draft'))throw Error('invalid post schema');const fields=new Set(['title','caption','hashtags','igOn','ytOn','thumbUrl','videoUrl','status','createdAt','createdBy','error','publishedAt','claimedAt']);for(const key of Object.keys(p))if(!fields.has(key))throw Error('unexpected post field');}
 for(const[id,a]of Object.entries(root.agreements||{})){safeId(id);if(!a||typeof a!=='object'||!a.doc||!a.reviewOnly)throw Error('review agreement schema required');for(const key of Object.keys(a))if(!['doc','private','reviewOnly'].includes(key))throw Error('review agreement cannot contain real submissions');}
 for(const[id,l]of Object.entries(root.lanes||{})){safeId(id);safeId(l?.instance);if(Object.keys(l).length!==1)throw Error('invalid lane schema');}
 for(const[hash,a]of Object.entries(root.assets||{})){if(!/^[a-f0-9]{64}$/.test(hash)||a.sha256!==hash||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>8*1024*1024||!['image/png','image/jpeg','image/webp','application/pdf'].includes(a.mime)||!a.owners||Array.isArray(a.owners))throw Error('invalid asset descriptor');for(const[owner,value]of Object.entries(a.owners)){safeId(owner);if(value!==true)throw Error('invalid asset owner');}for(const key of Object.keys(a))if(!['sha256','mime','bytes','owners'].includes(key))throw Error('unexpected asset field');}
 if(root.marketing&&(Array.isArray(root.marketing)||typeof root.marketing!=='object'))throw Error('invalid marketing schema');
 if(root.marketing?.data){const team=root.marketing.data;if(!Array.isArray(team.categories))throw Error('invalid categories');const ids=new Set();for(const c of team.categories){safeId(c.id);if(!Array.isArray(c.items))throw Error('invalid items');for(const it of c.items){safeId(it.id);if(ids.has(it.id))throw Error('duplicate item ID');ids.add(it.id);if(typeof it.title!=='string')throw Error('invalid item title');}}}

 return clone(root);
}
function fresh(root){return root?clone(root):{source:SOURCE,schemaVersion:1};}
function guarded(root,branch,id,base){safeId(id);if(!same(root[branch]?.[id],base))throw Error('revision conflict');root[branch]??={};}
function lane(root,c){safeId(c.lane);safeId(c.instance);if(root.lanes?.[c.lane]?.instance!==c.instance)throw Error('editor lane owned by another session');}
export function execute(input,c){
 validateRoot(input);if(!c||typeof c.action!=='string')throw Error('invalid normal command');let root=fresh(input),body;
 const response=(readOnly,value,status=200)=>({source:SOURCE,schemaVersion:1,authority:'review',readOnly,root:readOnly?clone(input):validateRoot(root),response:{status,body:value}});
 if(c.action==='read')return response(true,{marketing:clone(root.marketing??null),posts:clone(root.posts||{}),agreements:clone(root.agreements||{})});
 if(c.action==='draft.list'){const rows=Object.entries(root.drafts||{}).filter(([key])=>key.startsWith(c.prefix||'')).map(([key,value])=>({key,value}));return response(true,rows);}
 if(c.action==='lane.claim'){safeId(c.lane);safeId(c.instance);root.lanes??={};if(root.lanes[c.lane]&&root.lanes[c.lane].instance!==c.instance)throw Error('editor lane already active; recover the saved draft into a fresh editor');root.lanes[c.lane]={instance:c.instance};body={claimed:true};}
 else if(c.action==='lane.release'){safeId(c.lane);safeId(c.instance);if(!root.lanes?.[c.lane])return response(true,{released:true});lane(root,c);delete root.lanes[c.lane];body={released:true};}
 else if(c.action==='draft.save'||c.action==='draft.delete'){
  lane(root,c);assertOwnedDraftKey(c.key,{uid:REVIEW_DRAFT_UID,lane:c.lane},c.action==='draft.save'?c.value:root.drafts?.[c.key]);root.drafts??={};
  if(c.action==='draft.save')root.drafts[c.key]=clone(c.value);else {if(!same(root.drafts[c.key],c.base))throw Error('draft revision conflict');delete root.drafts[c.key];}body={saved:true};
 }
 else if(c.action==='post.save'){
  guarded(root,'posts',c.id,c.base);const v=clone(c.value);if(!v||typeof v.title!=='string'||!v.title.trim()||!['draft','ready','error'].includes(v.status||'draft'))throw Error('review post must remain an editable queue record');if(v.title.length>80||(v.caption||'').length>2200||(v.hashtags||'').length>500)throw Error('post field capacity');if(v.videoUrl&&!/^https?:\/\//.test(v.videoUrl))throw Error('invalid video URL');root.posts[c.id]=v;body={id:c.id,saved:true,publication:false};
 }
 else if(c.action==='post.delete'){guarded(root,'posts',c.id,c.base);delete root.posts[c.id];body={deleted:true};}
 else if(c.action==='agreement.prepare'){
  guarded(root,'agreements',c.id,c.base);const v=clone(c.value);if(!v?.doc||v.submission||v.archive||v.views)throw Error('review agreement cannot fabricate signature/submission');root.agreements[c.id]={...v,reviewOnly:true};body={id:c.id,prepared:true,publicLink:null};
 }
 else if(c.action==='agreement.delete'){guarded(root,'agreements',c.id,c.base);delete root.agreements[c.id];body={deleted:true};}
 else if(c.action==='team.save'){
  if(!same(root.marketing?.data,c.base))throw Error('revision conflict');if(!c.value||!Array.isArray(c.value.categories))throw Error('invalid team data');root.marketing??={};root.marketing.data=clone(c.value);body={saved:true,publication:false};
 }
 else if(c.action==='asset.registered'){
  const a=c.asset;safeId(a?.sha256);if(!/^[a-f0-9]{64}$/.test(a.sha256)||!['image/png','image/jpeg','image/webp','application/pdf'].includes(a.mime)||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>8*1024*1024)throw Error('invalid asset');safeId(c.owner);root.assets??={};const old=root.assets[a.sha256];if(old&&(old.mime!==a.mime||old.bytes!==a.bytes))throw Error('asset identity conflict');root.assets[a.sha256]={...a,owners:{...old?.owners,[c.owner]:true}};body={assetRef:'guide-asset:'+a.sha256};
 }
 else throw Error('normal review action is unavailable: '+c.action);
 return response(false,body);
}
