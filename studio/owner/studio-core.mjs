import {editorFormKey,legacyFormKey} from './draft-keys.mjs';
// Original normal Studio functions. Shared by standalone and integrated owners.
export function createStudioCore(guideEnvironment){
const {document,window,location,navigator,GuidePublishing,GuidePublisherRuntime,crypto,URL,Blob,Image,FileReader,pdfjsLib,Tesseract,setTimeout,clearTimeout,setInterval,clearInterval,alert,confirm,prompt,indexedDB}=guideEnvironment;
// NORMAL-CORE-START

/* ===== Firebase (영업관리 앱과 동일 프로젝트 = 같은 로그인) ===== */
var DATA_REF='marketing/data';        // 영업 데이터와 분리된 마케팅 전용 경로
var PUB_REF='marketing/published';    // 고객 공개용 스냅샷
var BACKUP_REF='marketing/deployBackups';   // 원자 배포에 함께 저장되는 GUIDE 범위 복구 기록
var BACKUP_KEEP=7;                     // 새 GUIDE 전체 복구 기록 7개 + 보관되는 작업 식별 기록
var STORAGE_DIR='marketing';
var ENV=typeof guideEnvironment==='undefined'?{}:guideEnvironment;
var DEMO=false;
var fbAuth=null,fbDb=null,fbStore=null;
if(ENV.runtime){fbAuth=ENV.runtime.auth||null;fbDb=ENV.runtime.db;fbStore=ENV.runtime.storage||null;}

var data={categories:[]},sel=null,dirty=false,curUser=null;
var _guideBase={known:false,team:null,state:null},_guideLoadSequence=0,_publicationReadable=true;
var _editGeneration=0,_draftWriterId=(crypto.randomUUID?crypto.randomUUID():('w'+Date.now()+Math.random().toString(36).slice(2)));
var _draftWrites=Promise.resolve(),_draftLoaded=null,_saveCapture=null;
var _publishIntent=null,_guideConfirmation=null;
function $(id){return document.getElementById(id);}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function uid(p){return p+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
function setDirty(v){dirty=v;if(v)_editGeneration++;var b=$('deployBtn');b.disabled=!v;b.classList.toggle('dirty',v);b.textContent=ENV.authority==='review'?'검토 자료 저장':(v?'배포하기':'배포');if(v)scheduleDraftSave();}
function defaultCategories(){return [{id:'cardnews',name:'카드뉴스',kind:'page',items:[]},{id:'street',name:'거리분석',kind:'market',items:[]},{id:'property',name:'매물분석',kind:'market',items:[]}];}
/* 카테고리마다 '정해진 분석 카테고리' 이름 — 카드 순서대로 자동 부여(카드N 대신).
   카드 칸에서 수정 가능. 목록보다 카드가 많으면 OCR→그래도 없으면 카드N 폴백. */
var ANALYSIS_LABELS={
  street:['상권 분석 리포트','상권 변화 추이','유동인구','임대/창업 정보','고객 분석','SNS 트렌드','날씨 영향 분석','프랜차이즈 현황','개인 카페 분석','상권 경쟁 분석','매출 분석','카페 기회','배달 객단가','AI 종합 분석'],
  property:['매물 기본 정보','임대 조건 분석','권리금 분석','입지·접근성 분석','면적·구조 분석','주변 시세 비교','매물 앞 유동인구','경쟁 매물 비교','예상 매출','예상 수익성','리스크 체크','종합 평가']
};
/* 카테고리 구조 마이그레이션: 구버전 'market'(상권분석)을 'street'(거리분석)로 옮기고
   3개 카테고리(카드뉴스·거리분석·매물분석)를 항상 보장 + 순서 고정. (기존 항목 보존) */
function migrateCategories(d){
  if(!d||typeof d!=='object')d={};
  var cats=asArray(d.categories).filter(Boolean);
  var byId={};cats.forEach(function(c){if(c&&c.id)byId[c.id]=c;});
  if(byId.market&&!byId.street){byId.market.id='street';byId.market.name='거리분석';byId.market.kind='market';byId.street=byId.market;delete byId.market;}
  function ensureCat(id,name,kind){ if(!byId[id]){byId[id]={id:id,name:name,kind:kind,items:[]};} else {byId[id].kind=kind; if(!byId[id].name)byId[id].name=name;} }
  ensureCat('cardnews','카드뉴스','page');
  ensureCat('street','거리분석','market');
  ensureCat('property','매물분석','market');
  var order=['cardnews','street','property'];
  var ordered=order.map(function(id){return byId[id];});
  cats.forEach(function(c){ if(c&&c.id&&order.indexOf(c.id)<0)ordered.push(c); });   // 알 수 없는 카테고리는 뒤에 보존
  d.categories=ordered;
  return d;
}
/* 항목이 속한 카테고리 id 찾기 */
function catIdOf(it){var cs=asArray(data.categories);for(var i=0;i<cs.length;i++){if(asArray(cs[i].items).indexOf(it)>=0)return cs[i].id;}return (sel&&sel.cat)||'';}

/* ===== 작업 자동 저장 (IndexedDB · 새로고침/재접속해도 유지, 배포 전까지 보관) ===== */
var IDB_DB='bc_studio_drafts',IDB_STORE='kv';
function idbOpen(){return new Promise(function(res,rej){var r=indexedDB.open(IDB_DB,1);r.onupgradeneeded=function(){r.result.createObjectStore(IDB_STORE);};r.onsuccess=function(){res(r.result);};r.onerror=function(){rej(r.error);};});}
function idbSet(k,v){if(ENV.draftStore)return ENV.draftStore.set(k,v);return idbOpen().then(function(db){return new Promise(function(res,rej){var tx=db.transaction(IDB_STORE,'readwrite');tx.objectStore(IDB_STORE).put(v,k);tx.oncomplete=function(){db.close();res();};tx.onerror=tx.onabort=function(){db.close();rej(tx.error||new Error('작업 저장 실패'));};});});}
function idbGet(k){if(ENV.draftStore)return ENV.draftStore.get(k);return idbOpen().then(function(db){return new Promise(function(res,rej){var tx=db.transaction(IDB_STORE,'readonly'),rq=tx.objectStore(IDB_STORE).get(k),value;rq.onsuccess=function(){value=rq.result;};tx.oncomplete=function(){db.close();res(value);};tx.onerror=tx.onabort=function(){db.close();rej(tx.error||rq.error||new Error('작업 읽기 실패'));};});});}
function idbList(prefix){if(ENV.draftStore)return (ENV.draftStore.listRecovery||ENV.draftStore.list).call(ENV.draftStore,prefix);return idbOpen().then(function(db){return new Promise(function(res,rej){var tx=db.transaction(IDB_STORE,'readonly'),rq=tx.objectStore(IDB_STORE).openCursor(),rows=[];rq.onsuccess=function(){var cursor=rq.result;if(cursor){if(typeof cursor.key==='string'&&cursor.key.indexOf(prefix)===0)rows.push({key:cursor.key,value:cursor.value});cursor.continue();}};tx.oncomplete=function(){db.close();res(rows);};tx.onerror=tx.onabort=function(){db.close();rej(tx.error||new Error('준비 작업 목록 읽기 실패'));};});});}
function idbDelIf(k,check){if(ENV.draftStore)return ENV.draftStore.deleteIf(k,check);return idbOpen().then(function(db){return new Promise(function(res,rej){var tx=db.transaction(IDB_STORE,'readwrite'),store=tx.objectStore(IDB_STORE),rq=store.get(k),removed=false;rq.onsuccess=function(){if(!rq.result||check(rq.result)){store.delete(k);removed=true;}};tx.oncomplete=function(){db.close();res(removed);};tx.onerror=tx.onabort=function(){db.close();rej(tx.error||new Error('작업 정리 실패'));};});});}
function idbDel(k){return idbDelIf(k,function(){return true;});}
function legacyDraftKey(){return 'draft_'+(curUser&&curUser.uid?curUser.uid:'anon');}
function draftKey(){var actor=curUser&&curUser.uid||'anon';var encoded=Array.from(actor).map(ch=>ch.codePointAt(0).toString(16).padStart(6,'0')).join('');return 'draft_v2_'+encoded+'_'+(ENV.editorId||_draftWriterId);}
function serializeData(){
  return JSON.parse(JSON.stringify(data,function(k,v){
    if(k==='_cards')return(v||[]).map(function(a){return {title:a.title||'',url:a.url,blur:a.blur,wm:a.wm,derivatives:a.derivatives||null,revealed:!!a.revealed,committed:!!a.committed,ord:(a.ord!=null?a.ord:0)};});
    return k.charAt&&k.charAt(0)==='_'?undefined:v;
  }));
}
var _saveTimer=null;
function captureGuideDraft(){return {key:draftKey(),uid:curUser&&curUser.uid||'demo',writerId:_draftWriterId,generation:_editGeneration,data:serializeData(),base:GuidePublishing.clone(_guideBase),selection:GuidePublishing.clone(sel)};}
function scheduleDraftSave(){
  clearTimeout(_saveTimer);var capture=captureGuideDraft();_saveCapture=capture;
  _saveTimer=setTimeout(function(){_saveTimer=null;_draftWrites=_draftWrites.then(function(){return idbSet(capture.key,{savedAt:Date.now(),uid:capture.uid,editorId:ENV.editorId||_draftWriterId,writerId:capture.writerId,generation:capture.generation,data:capture.data,base:capture.base});}).catch(function(){if(capture.key===draftKey())$('loginState').textContent='자동 저장 실패 · 현재 편집 내용은 화면에 유지됩니다.';});},600);
}
function restoreDraft(expectedKey){
  var key=expectedKey||draftKey();
  return idbGet(key).then(function(d){
    if(key!==draftKey())return false;
    if(!d||!d.data||!d.data.categories)return false;
    _draftLoaded=GuidePublishing.clone(d);
    // A clock comparison is not evidence that a draft was saved. Keep its exact
    // editing base; an old/legacy base must conflict rather than overwrite cloud.
    _guideBase=d.base&&d.base.known?GuidePublishing.clone(d.base):{known:false,team:null,state:null};
    data=GuidePublishing.clone(d.data);if(!data.categories)data.categories=defaultCategories();
    normalizeData(data);migrateCategories(data);
    return true;
  }).catch(function(){return false;});
}
async function clearSubmittedGuideDraft(capture){
  function current(){return capture.key===draftKey()&&capture.writerId===_draftWriterId&&capture.generation===_editGeneration&&GuidePublishing.equal(capture.data,serializeData());}
  if(!current())return false;
  if(_saveCapture&&_saveCapture.key===capture.key&&_saveCapture.generation<=capture.generation){clearTimeout(_saveTimer);_saveTimer=null;}
  await _draftWrites;if(!current())return false;
  var removed=await idbDelIf(capture.key,function(record){return(record.writerId===capture.writerId&&record.generation<=capture.generation)||(_draftLoaded&&GuidePublishing.equal(record,_draftLoaded));});
  return current()&&removed;
}

/* ===== 접근 허용 계정 (퇴사자 정리: 본인 계정만) =====
   이 목록에 없는 계정은 로그인에 성공해도 즉시 차단·로그아웃되어 스튜디오/동의서 관리에 들어올 수 없다.
   계정을 추가하려면 따옴표로 이메일을 더 넣으면 된다(모두 소문자). */
var ALLOWED_EMAILS=['admin@beancraft.com'];
function isAllowed(u){return !!(u&&u.email&&ALLOWED_EMAILS.indexOf(String(u.email).toLowerCase())>=0);}
function denyAccess(email){
  curUser=null;
  try{if(fbAuth)fbAuth.signOut();}catch(e){}
  var lg=$('login');if(lg)lg.classList.remove('hidden');
  var ls=$('loginStatus');if(ls){ls.className='status show err';ls.textContent='이 계정('+(email||'')+')은 더 이상 접근 권한이 없습니다. 관리자 계정으로만 이용할 수 있습니다.';}
  var ll=$('logoutLink');if(ll)ll.classList.add('hidden');
}
/* ===== 로그인 (영업앱과 동일 Firebase 계정) ===== */
function login(email,pw){
  $('loginStatus').className='status show info';$('loginStatus').textContent='로그인 중…';
  var em=email.indexOf('@')>=0?email:(email+'@beancraft.com');   // 영업관리 앱과 동일 방식 (아이디 → @beancraft.com)
  fbAuth.signInWithEmailAndPassword(em,pw).catch(function(e){
    var c=e.code||'';
    var m=(c.indexOf('invalid-credential')>=0||c.indexOf('wrong-password')>=0||c.indexOf('user-not-found')>=0)?'이메일 또는 비밀번호가 올바르지 않습니다.':(c.indexOf('invalid-email')>=0?'이메일 형식이 올바르지 않습니다.':(c.indexOf('too-many-requests')>=0?'시도가 많아 잠시 후 다시 해주세요.':e.message));
    $('loginStatus').className='status show err';$('loginStatus').textContent=m;
  });
}
function afterLogin(){
  $('login').classList.add('hidden');
  $('loginState').textContent=ENV.authority==='review'?'검토용 자료 · 실제 원장과 분리':(curUser?('로그인됨 · '+(curUser.email||'')):'계정 연결 필요');
  $('logoutLink').classList.remove('hidden');
  $('logoutLink').onclick=async function(){if(confirm('로그아웃 할까요?')){await ENV.beforeAccountChange?.();if(fbAuth)await fbAuth.signOut();location.reload();}};
}
$('loginBtn').onclick=function(){var e=$('email').value.trim(),p=$('pw').value;if(!e||!p){$('loginStatus').className='status show err';$('loginStatus').textContent='이메일과 비밀번호를 입력하세요.';return;}login(e,p);};
$('pw').addEventListener('keydown',function(ev){if(ev.key==='Enter')$('loginBtn').click();});
$('email').addEventListener('keydown',function(ev){if(ev.key==='Enter')$('pw').focus();});

/* ===== 데이터 (Firebase RTDB · 마케팅 전용 경로) ===== */
function isSeedNeeded(d){
  if(!d||!d.categories)return true;     // 데이터 자체가 없음
  if(d.seeded)return false;             // 이미 심었음(이후 삭제는 사용자 의도이므로 재생성 안 함)
  var cats=d.categories,any=false;      // 비어있는 채로만 존재하면 심기
  for(var k in cats){var c=cats[k];if(c&&c.items&&c.items.length){any=true;break;}}
  return !any;
}
/* Firebase는 빈 배열을 저장하지 않고(키 자체가 사라짐), 비순차 배열은 객체로 돌려준다.
   → 불러온 데이터의 categories/items/cards를 항상 배열로 정규화해 렌더·편집 코드가 깨지지 않게 한다. */
function asArray(v){return Array.isArray(v)?v:(v&&typeof v==='object'?Object.keys(v).map(function(k){return v[k];}):[]);}
function normalizeData(d){
  if(!d||typeof d!=='object')return {categories:[]};
  d.categories=asArray(d.categories).filter(Boolean);
  d.categories.forEach(function(c){
    c.items=asArray(c.items).filter(Boolean);
    c.items.forEach(function(it){ if(it&&it.cards!=null)it.cards=asArray(it.cards).filter(Boolean); });
  });
  return d;
}
function loadData(){
  var key=draftKey(),sequence=++_guideLoadSequence;
  return Promise.allSettled([fbDb.ref(DATA_REF).once('value'),fbDb.ref('marketing/'+GuidePublishing.stateKey).once('value')]).then(async function(snaps){
    if(sequence!==_guideLoadSequence||key!==draftKey())return;
    if(snaps[0].status!=='fulfilled')throw snaps[0].reason;
    _publicationReadable=snaps[1].status==='fulfilled';
    var raw=snaps[0].value.val(),d=GuidePublishing.clone(raw);
    _guideBase={known:_publicationReadable,team:GuidePublishing.clone(raw),state:_publicationReadable?GuidePublishing.clone(snaps[1].value.val()):null};
    if(isSeedNeeded(d)){
      // Opening the studio is a read. A seed stays local until explicit deploy.
      data={categories:defaultCategories(),seeded:true};
    }else{
      data=d;
    }
    normalizeData(data);   // 빈 배열 누락(예: 상권분석 items)로 인한 렌더 충돌 방지
    migrateCategories(data);   // 3개 카테고리(카드뉴스·거리분석·매물분석) 보장
    var restored=await restoreDraft(key);if(sequence!==_guideLoadSequence||key!==draftKey())return;
    _publishIntent=await idbGet('publish_'+key)||null;
    renderTree();if(restored)setDirty(true);else setDirty(false);
    if(ENV.draftStore)await showRecoverableDrafts();
    if(_publishIntent){$('loginState').textContent='확인할 배포 작업이 있습니다. 배포 버튼으로 같은 작업의 결과를 먼저 확인하세요.';$('deployBtn').disabled=false;$('deployBtn').textContent='작업 확인·재시도';}
    if(!_publicationReadable)$('loginState').textContent='편집 자료 조회됨 · 배포 소유 기록의 연결 권한 확인 필요';
  }).catch(function(e){alert('데이터 로드 실패: '+e.message);if(ENV.strict)throw e;});
}
function loadDemo(){
  data={categories:[
    {id:'cardnews',name:'카드뉴스',kind:'page',items:[
      {id:'late',type:'page',title:'지각, 보상이 답일까?',page:'marketing/late/'},
      {id:'music',type:'page',title:'매장 음악, 멜론 결제하면 끝일까?',page:'marketing/music-copyright/'}
    ]},
    {id:'street',name:'거리분석',kind:'market',items:[
      {id:'market-analysis',type:'market',title:'강남역 거리분석',cards:[]}
    ]},
    {id:'property',name:'매물분석',kind:'market',items:[]}
  ]};
  restoreDraft().then(function(restored){renderTree();openCat('cardnews');if(restored)setDirty(true);});
}

/* ===== 사이드바 트리 ===== */
var openCats={};
var dragItem=null;   // 사이드바 항목 드래그 상태
var cardDrag=null;   // 카드 목록 드래그 순서변경 상태
function renderTree(){
  var tr=$('tree');tr.innerHTML='';
  asArray(data.categories).forEach(function(c){
    var cat=document.createElement('div');cat.className='cat'+(openCats[c.id]?' open':'');
    var rows=asArray(c.items).map(function(it){
      return '<div class="item-row" data-cat="'+c.id+'" data-item="'+it.id+'"><span>'+esc(it.title||'(제목없음)')+'</span></div>';
    }).join('');
    cat.innerHTML='<div class="cat-row" data-cat="'+c.id+'"><span class="caret">▶</span><span>'+esc(c.name)+'</span></div>'+
      '<div class="cat-items">'+rows+'<div class="item-new" data-newcat="'+c.id+'">＋ 새로 만들기</div></div>';
    tr.appendChild(cat);
  });
  tr.querySelectorAll('.cat-row').forEach(function(r){r.onclick=function(){toggleCat(r.dataset.cat);};});
  tr.querySelectorAll('.item-row').forEach(function(r){
    r.onclick=function(){selectContext({view:'item',categoryId:r.dataset.cat,itemId:r.dataset.item}).catch(e=>alert(e.message));};
    r.setAttribute('draggable','true');   // 드래그로 카테고리 간 이동/순서변경
    r.ondragstart=function(e){dragItem={cat:r.dataset.cat,item:r.dataset.item};r.classList.add('dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',r.dataset.item);}catch(_){}}};
    r.ondragend=function(){clearDnDMarks();dragItem=null;};
    r.ondragover=function(e){if(!dragItem)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';clearDnDMarks(true);r.classList.add('drop-before');};
    r.ondrop=function(e){if(!dragItem)return;e.preventDefault();e.stopPropagation();var d=dragItem;dragItem=null;moveItem(d.cat,d.item,r.dataset.cat,r.dataset.item);};
  });
  tr.querySelectorAll('.cat').forEach(function(catEl){
    var cr=catEl.querySelector('.cat-row');var cid=cr&&cr.dataset.cat;if(!cid)return;
    catEl.ondragover=function(e){if(!dragItem)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';catEl.classList.add('cat-drop');};
    catEl.ondragleave=function(e){if(!catEl.contains(e.relatedTarget))catEl.classList.remove('cat-drop');};
    catEl.ondrop=function(e){if(!dragItem)return;e.preventDefault();var d=dragItem;dragItem=null;moveItem(d.cat,d.item,cid,null);};  // 카테고리 빈 영역에 놓으면 맨 뒤로
  });
  tr.querySelectorAll('[data-newcat]').forEach(function(r){r.onclick=function(){newItem(r.dataset.newcat);};});
  highlightActive();
}
function clearDnDMarks(keepDragging){var t=$('tree');if(!t)return;t.querySelectorAll('.drop-before,.cat-drop').forEach(function(el){el.classList.remove('drop-before','cat-drop');});if(!keepDragging)t.querySelectorAll('.dragging').forEach(function(el){el.classList.remove('dragging');});}
/* 항목을 다른(또는 같은) 카테고리로 이동. beforeId 앞에 삽입, 없으면 맨 뒤. */
function moveItem(srcCat,srcId,dstCat,beforeId){
  if(srcId===beforeId)return;
  var s=findCat(srcCat);if(!s||!s.items)return;
  var idx=-1;for(var i=0;i<s.items.length;i++){if(s.items[i].id===srcId){idx=i;break;}}
  if(idx<0)return;
  var it=s.items.splice(idx,1)[0];
  var d=findCat(dstCat);if(!d){s.items.splice(idx,0,it);return;}
  if(!d.items)d.items=[];
  var pos=d.items.length;
  if(beforeId){for(var j=0;j<d.items.length;j++){if(d.items[j].id===beforeId){pos=j;break;}}}
  d.items.splice(pos,0,it);
  if(sel&&sel.item===srcId)sel.cat=dstCat;   // 선택 유지
  setDirty(true);openCat(dstCat);            // openCat 안에서 renderTree
}
function toggleCat(id){openCats[id]=!openCats[id];renderTree();}
function openCat(id){openCats[id]=true;renderTree();}
function highlightActive(){document.querySelectorAll('.item-row').forEach(function(r){r.classList.toggle('active',sel&&r.dataset.cat===sel.cat&&r.dataset.item===sel.item);});}

/* ===== 중앙 뷰 라우터 — 모든 화면 전환을 한 곳에서 처리. 신규 모듈은 nav 1개 + render 1개만 추가하면 꽂힘 =====
   name: 'market'(항목 편집) | 'compose' | 'dash' | 'agree' | 'reference' | 'assets' | null(홈) */
var refView=false, assetView=false;
function setActiveView(name){
  agView=(name==='agree');dashView=(name==='dash');composeView=(name==='compose');refView=(name==='reference');assetView=(name==='assets');
  if(name!=='market')sel=null;
  ['composeNav','dashNav','agreeNav','refNav','assetNav'].forEach(function(nid){var el=$(nid);if(el)el.classList.remove('active');});
  var navMap={compose:'composeNav',dash:'dashNav',agree:'agreeNav',reference:'refNav',assets:'assetNav'};
  if(navMap[name]){var a=$(navMap[name]);if(a)a.classList.add('active');}
  highlightActive();
  var bb=$('backBtn');if(bb)bb.classList.toggle('hidden',name!=='market');
  var w=$('welcome');if(w&&name)w.classList.add('hidden');
}

function findCat(id){return data.categories.filter(function(c){return c.id===id;})[0];}
function findItem(cat,item){var c=findCat(cat);return c?c.items.filter(function(x){return x.id===item;})[0]:null;}

/* ===== 새 항목 ===== */
function newItem(catId){
  openCat(catId);
  var cat=findCat(catId);if(!cat)return;
  if(cat.kind==='page'){
    var topic=prompt('새 카드뉴스 주제를 입력하세요\n예: 배달앱 수수료, 어떻게 줄일까?','');
    if(topic===null)return;topic=topic.trim();if(!topic)return;
    var id=uid('c');
    var it={id:id,type:'card',title:topic,subtitle:'',intro:''};
    cat.items.push(it);setDirty(true);renderTree();selectItem(catId,id);
  }else{
    var name=prompt('새 '+cat.name+' 이름을 입력하세요\n예: 홍대입구역 '+cat.name,'');
    if(name===null)return;name=name.trim();if(!name)return;
    var gid=uid('m');
    var git={id:gid,type:'market',title:name,cards:[]};
    cat.items.push(git);setDirty(true);renderTree();selectItem(catId,gid);
  }
}

/* ===== 항목 선택 → 작업대 ===== */
async function selectItem(cat,item){
  await flushForms();
  var c=findCat(cat),it=findItem(cat,item);
  if(!c||!it)throw new Error('선택한 카테고리·항목을 찾지 못했습니다.');
  sel={cat:cat,item:item};
  setActiveView('market');
  if(ENV.contextChanged)ENV.contextChanged({view:'item',categoryId:cat,itemId:item,postId:null,agreementId:null});
  $('crumb').innerHTML='<span>'+esc(c.name)+'</span><span class="sep">›</span><span class="cur">'+esc(it.title||'')+'</span>';
  if(c&&c.kind==='market')renderMarketWork(it);else renderCardWork(it);
}
function goBack(){ setActiveView(null); clearStage(); }
$('backBtn').onclick=function(){return selectContext({view:'items'}).catch(e=>alert(e.message));};

/* ----- 카드뉴스 작업대 ----- */
function renderCardWork(it){
  var isPage=(it.type==='page');  // 기존 가이드(외부 링크 페이지) vs 새 카드뉴스(데이터로 렌더)
  var ctrl='<label>카드뉴스 제목</label><input type="text" id="cTitle" value="'+esc(it.title)+'"'+(isPage?' disabled':'')+'>'+
    (isPage?'':'<label>부제 (선택)</label><input type="text" id="cSub" value="'+esc(it.subtitle||'')+'">'+
    '<label>도입 문구 (선택)</label><textarea id="cIntro">'+esc(it.intro||'')+'</textarea>')+
    (isPage?'<div class="status show ok" style="margin-top:14px;">기존 가이드 페이지입니다. 미리보기는 실제 페이지입니다.</div>':
      '<div class="status show info" style="margin-top:14px;">제목·부제·도입을 입력하면 미리보기에 바로 반영됩니다. <b>배포</b>하면 팀·고객에게 공개됩니다.</div>')+
    '<div style="margin-top:16px;display:flex;gap:8px;"><button class="btn danger sm" id="cDel">항목 삭제</button></div>';
  var pv=isPage?'<iframe id="pvFrame" sandbox="allow-same-origin" src="'+esc(ENV.resourceUrl?ENV.resourceUrl(it.page):(ENV.publicBase||location.origin)+'/'+String(it.page).replace(/^\/+/g,''))+'"></iframe>':'<iframe id="pvFrame"></iframe>';
  $('stage').innerHTML='<div class="controls">'+ctrl+'</div><div class="preview"><div class="pv-bar"><span class="dotr"></span><span class="dotr"></span><span class="dotr"></span><span style="margin-left:8px;">미리보기</span></div>'+pv+'</div>';
  if(!isPage){
    updateDraftPreview(it);
    $('cTitle').oninput=function(){it.title=this.value;setDirty(true);$('crumb').querySelector('.cur').textContent=this.value;var act=document.querySelector('.item-row.active span:last-child');if(act)act.textContent=this.value;updateDraftPreview(it);};
    $('cSub').oninput=function(){it.subtitle=this.value;setDirty(true);updateDraftPreview(it);};
    $('cIntro').oninput=function(){it.intro=this.value;setDirty(true);updateDraftPreview(it);};
  }
  $('cDel').onclick=function(){if(confirm('이 카드뉴스를 삭제할까요?')){var c=findCat('cardnews');c.items=c.items.filter(function(x){return x.id!==it.id;});setDirty(true);sel=null;renderTree();clearStage();}};
}
function cardStarterHTML(it){
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
   '<title>'+esc(it.title)+' | BEANCRAFT</title>'+
   '<meta name="robots" content="noindex, nofollow">'+
   '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">'+
   '<style>body{font-family:Pretendard,sans-serif;margin:0;color:#111;background:#fff;}'+
   '.wm{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:1;}'+
   '.wm::before{content:\'빈크래프트 BeanCraft · 빈크래프트 BeanCraft · 빈크래프트 BeanCraft · 빈크래프트 BeanCraft · 빈크래프트 BeanCraft\';position:absolute;top:-50%;left:-50%;width:200%;height:200%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:rgba(26,54,93,.06);letter-spacing:6px;white-space:nowrap;transform:rotate(-35deg);}'+
   '.hd{background:linear-gradient(135deg,#1a365d,#0f2647);color:#fff;padding:48px 24px;text-align:center;position:relative;z-index:2;}'+
   '.hd .chip{display:inline-block;font-size:.76rem;font-weight:800;letter-spacing:.06em;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:6px 14px;margin-bottom:14px;}'+
   '.hd h1{font-size:1.8rem;font-weight:800;letter-spacing:-.02em;line-height:1.3;}'+
   '.hd p{color:#cbd5e0;margin-top:8px;font-size:.98rem;}'+
   '.bd{max-width:760px;margin:0 auto;padding:30px 20px 80px;position:relative;z-index:2;}'+
   '.intro{border:1.5px solid #1a365d;border-radius:14px;padding:20px 22px;font-size:1rem;line-height:1.8;color:#222;}'+
   '.ph{margin-top:24px;border:1.5px dashed #c3ccd6;border-radius:14px;padding:40px 20px;text-align:center;color:#9aa6b3;}'+
   '.cr{position:fixed;bottom:0;left:0;width:100%;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#a0aec0;padding:10px;text-align:center;font-size:.72rem;z-index:3;}.cr b{color:#4a7fbf;}</style></head>'+
   '<body><div class="wm"></div><div class="hd"><span class="chip">BEANCRAFT · 카페 컨설팅</span><h1>'+esc(it.title)+'</h1>'+
   (it.subtitle?'<p>'+esc(it.subtitle)+'</p>':'')+'</div><div class="bd">'+
   (it.intro?'<div class="intro">'+esc(it.intro).replace(/\n/g,'<br>')+'</div>':'<div class="intro">도입 문구를 입력하면 여기에 표시됩니다.</div>')+
   '<div class="ph">본문 내용 영역<br><small>(세부 편집 방식은 다음 단계에서 설정)</small></div></div>'+
   '<div class="cr"><b>© 2026 BEANCRAFT</b> · 무단 복제·재배포 금지</div></body></html>';
}
/* 미리보기 렌더 — 큰 이미지(dataURL) 다수도 안전하게: srcdoc 대신 Blob URL 사용 */
var _pvBlobUrl=null;
function setPreviewHTML(html){
  var f=$('pvFrame');if(!f)return;
  var sy=0; try{ if(f.contentWindow) sy=f.contentWindow.scrollY||f.contentWindow.pageYOffset||0; }catch(e){}  // 보던 위치 기억
  try{ if(_pvBlobUrl)URL.revokeObjectURL(_pvBlobUrl); }catch(e){}
  _pvBlobUrl=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  f.onload=function(){ try{ f.contentWindow.scrollTo(0,sy); }catch(e){} };  // 로드 후 위치 복원
  f.removeAttribute('srcdoc');
  f.setAttribute('sandbox',ENV.authority==='review'?'allow-same-origin':'allow-scripts allow-same-origin');
  f.src=_pvBlobUrl;
}
function updateDraftPreview(it){setPreviewHTML(cardStarterHTML(it));}

/* ----- 상권분석 작업대 (카드 자동분리 + 공개체크 + 오픈업식 미리보기) ----- */
function ensureCards(it){if(!it._cards){it._cards=(it.cards||[]).map(function(c,i){return{title:c.title||'',url:c.file,blur:c.blur,wm:c.wm,derivatives:c.derivatives||null,revealed:!!c.revealed,committed:true,ord:(c.ord!=null?c.ord:i)};});}it._cards.forEach(function(a,i){if(a.ord==null)a.ord=i;});return it._cards;}
/* 공개=위로, 비공개=원래 자리. ord(원래 순서) 기준 안정 정렬: 공개 카드 먼저, 그 안에서 ord 오름차순. */
function sortCardsByReveal(it){ensureCards(it);it._cards.sort(function(a,b){if(!!a.revealed!==!!b.revealed)return a.revealed?-1:1;return (a.ord||0)-(b.ord||0);});}
function renderMarketWork(it){
  ensureCards(it);
  var catName=(findCat(catIdOf(it))||{}).name||'분석';
  var ctrl='<label>'+esc(catName)+' 제목 (지역명)</label><input type="text" id="mTitle" value="'+esc(it.title)+'">'+
    '<label>자료 첨부 (합본 1장 → 자동으로 카드 분리)</label>'+
    '<div class="dropzone" id="dz"><div><strong>'+esc(catName)+' 이미지를 끌어다 놓기</strong></div><div class="sub">합쳐진 이미지를 넣으면 카드별로 자동 분리됩니다</div></div>'+
    '<input type="file" id="fileInput" accept="image/*,application/pdf,.pdf">'+
    '<label style="margin-top:14px;">낱개로 올리기 (1장 = 카드 1장 · 자르지 않음)</label>'+
    '<div class="dropzone alt" id="dzS"><div><strong>낱개 이미지를 끌어다 놓기</strong></div><div class="sub">자동분리 없이 그대로 카드로 추가 (여러 장 한꺼번에 가능)</div></div>'+
    '<input type="file" id="fileInputS" accept="image/*,application/pdf,.pdf" multiple>'+
    '<div id="cardhint" class="status show info" style="margin-top:12px;">공개할 카드를 체크하세요. 체크 안 한 카드는 고객 화면에서 블러 처리됩니다.</div>'+
    '<div class="flist" id="clist"></div>'+
    '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn sm" id="mDetect">카드 제목 다시 인식</button><button class="btn danger sm" id="mDel">항목 삭제</button></div>';
  $('stage').innerHTML='<div class="controls">'+ctrl+'</div><div class="preview"><div class="pv-bar"><span class="dotr"></span><span class="dotr"></span><span class="dotr"></span><span style="margin-left:8px;">고객 화면 미리보기</span></div><iframe id="pvFrame"></iframe></div>';
  renderCards(it);updateMarketPreview(it);
  $('mTitle').oninput=function(){it.title=this.value;setDirty(true);$('crumb').querySelector('.cur').textContent=this.value;var act=document.querySelector('.item-row.active span:last-child');if(act)act.textContent=this.value;updateMarketPreview(it);};
  var dz=$('dz'),fi=$('fileInput');
  dz.setAttribute('role','button');dz.tabIndex=0;dz.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();fi.click();}};
  dz.onclick=function(){fi.click();};
  dz.ondragover=function(e){e.preventDefault();dz.classList.add('drag');};
  dz.ondragleave=function(){dz.classList.remove('drag');};
  dz.ondrop=function(e){e.preventDefault();dz.classList.remove('drag');onAttach(it,e.dataTransfer.files);};
  fi.onchange=function(){onAttach(it,fi.files);fi.value='';};
  var dzS=$('dzS'),fiS=$('fileInputS');
  dzS.setAttribute('role','button');dzS.tabIndex=0;dzS.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();fiS.click();}};
  dzS.onclick=function(){fiS.click();};
  dzS.ondragover=function(e){e.preventDefault();dzS.classList.add('drag');};
  dzS.ondragleave=function(){dzS.classList.remove('drag');};
  dzS.ondrop=function(e){e.preventDefault();dzS.classList.remove('drag');onAttachSingle(it,e.dataTransfer.files);};
  fiS.onchange=function(){onAttachSingle(it,fiS.files);fiS.value='';};
  $('mDetect').onclick=function(){detectTitles(it);};
  $('mDel').onclick=function(){if(confirm('이 항목을 삭제할까요?')){var c=findCat(catIdOf(it));if(c)c.items=c.items.filter(function(x){return x.id!==it.id;});setDirty(true);sel=null;renderTree();clearStage();}};
  // 기존 카드 제목이 '카드 N'(또는 빈값)이면 자동으로 한 번 다시 인식 → 옛 제목 고착 방지
  if(!it._titleTried && it._cards.length && it._cards.some(function(a){return !a.title||/^카드\s*\d+$/.test(a.title);})){ it._titleTried=true; detectTitles(it); }
}
function fmtDate(d){try{return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}catch(e){return '';}}
function loadImg(src){return new Promise(function(res,rej){var im=new Image();im.onload=function(){res(im);};im.onerror=rej;im.src=src;});}
/* 카드 제목 자동 인식 (OCR) — tesseract.js 지연 로드 */
function loadScriptOnce(src){return new Promise(function(res,rej){if(document.querySelector('script[data-s="'+src+'"]')){res();return;}var s=document.createElement('script');s.src=src;s.setAttribute('data-s',src);s.onload=function(){res();};s.onerror=rej;document.head.appendChild(s);});}
var _tess=null;
async function getTess(){if(_tess)return _tess;await ENV.loadLibrary('tesseract');_tess=await window.Tesseract.createWorker('kor+eng',1,ENV.tesseractOptions);return _tess;}
function cleanTitle(s){
  return (s||'')
    .replace(/^[0-9oOiIlL]{1,3}[\s.\-·)]*/,'')      // 앞 번호배지(01·02…) 제거
    .replace(/^[^가-힣A-Za-z]+/,'')                 // 앞쪽 자모 조각·기호 제거(ㅠㅠ, 시 등 노이즈)
    .replace(/[^가-힣A-Za-z0-9 /·]/g,'')    // 한글·영문·숫자·공백만 남김
    .replace(/\s{2,}/g,' ').trim();
}
/* OCR로 읽은 제목을 '정해진 분석 카테고리명'에 맞춰 보정(스냅). 비슷하면 깨끗한 이름으로 교정,
   목록에 없는 새 내용이면 OCR 원문 사용 → 읽기(적응) + 정확도 둘 다 확보. */
function snapLabel(ocr,labels){
  if(!ocr||!labels||!labels.length)return '';
  var o=(ocr||'').replace(/\s/g,'');if(o.length<2)return '';
  var best='',bestScore=0;
  for(var i=0;i<labels.length;i++){
    var l=labels[i].replace(/\s/g,''),common=0,used={};
    for(var k=0;k<o.length;k++){var pos=l.indexOf(o[k]);if(pos>=0&&!used[pos]){used[pos]=1;common++;}}
    var score=common/Math.max(o.length,l.length);
    if(score>bestScore){bestScore=score;best=labels[i];}
  }
  return bestScore>=0.5?best:'';
}
async function ocrTitle(url){
  try{
    var im=await loadImg(url);var W=im.naturalWidth;
    // 제목줄만: 좌측 번호배지(≈0.06W)는 건너뛰고, 우측 버튼('지도로 보기' 등)도 제외
    var sx=Math.round(W*0.057), sw=Math.round(W*0.42), sh=Math.max(40,Math.round(W*0.05));
    if(sx+sw>W)sw=W-sx; if(sh>im.naturalHeight)sh=im.naturalHeight;
    var sc=2;   // 2배 확대 → OCR 정확도 향상
    var cv=document.createElement('canvas');cv.width=sw*sc;cv.height=sh*sc;
    var x=cv.getContext('2d');x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';
    x.drawImage(im,sx,0,sw,sh,0,0,sw*sc,sh*sc);
    var r=await _tess.recognize(cv);
    var line=((r&&r.data&&r.data.text)||'').split('\n').map(function(s){return s.trim();}).filter(Boolean)[0]||'';
    return cleanTitle(line);
  }catch(e){return '';}
}
/* 첨부 → 로딩 중 → 자동 분리 → 제목 인식 */
async function _onAttach(it,files){
  var arr=[].slice.call(files);var f=arr[0];if(!f)return;
  showOverlay('로딩 중…');
  try{
    var imgs=[];
    if(f.type==='application/pdf'||/\.pdf$/i.test(f.name)){
      if(!window.pdfjsLib)await ENV.loadLibrary('pdf');if(!window.pdfjsLib)throw new Error('PDF 모듈 로드 실패');
      var buf=await f.arrayBuffer();var pdf=await window.pdfjsLib.getDocument({data:buf}).promise;
      for(var n=1;n<=pdf.numPages;n++){var pg=await pdf.getPage(n);var vp=pg.getViewport({scale:2});var cc=document.createElement('canvas');cc.width=vp.width;cc.height=vp.height;await pg.render({canvasContext:cc.getContext('2d'),viewport:vp}).promise;imgs.push(cc);}await pdf.destroy();
    }else if(f.type.indexOf('image/')===0){
      imgs.push(await fileToImage(f));   // 통짜 캔버스 없이 원본 이미지에서 직접 분석·자르기 (브라우저 한계 무관)
    }else{ hideOverlay();alert('이미지 또는 PDF만 첨부 가능합니다.');return; }
    var cards=[];
    for(var k=0;k<imgs.length;k++){ cards=cards.concat(splitCards(imgs[k])); }
    ensureCards(it);
    var start=it._cards.length;
    var labels=ANALYSIS_LABELS[catIdOf(it)]||[];   // 카테고리별 '정해진 분석 카테고리' 이름
    cards.forEach(function(c){ var idx=it._cards.length; it._cards.push({title:labels[idx]||('카드 '+(idx+1)),url:c.url,revealed:false,committed:false,ord:idx}); });
    setDirty(true);renderCards(it);updateMarketPreview(it);
    // 각 카드 상단의 [번호배지][제목] 패턴을 OCR로 읽어 제목 기재 → 정해진 분석 카테고리명으로 보정
    try{
      showOverlay('카드 제목 인식 중…');
      await getTess();
      for(var ti=start;ti<it._cards.length;ti++){
        showOverlay('카드 제목 인식 중… ('+(ti-start+1)+'/'+(it._cards.length-start)+')');
        var ocr=await ocrTitle(it._cards[ti].url);
        var snapped=snapLabel(ocr,labels);                                   // 비슷하면 깨끗한 이름으로
        var t=snapped||((ocr&&ocr.length>=2&&ocr.length<=24)?ocr:'')||labels[ti]||'';
        if(t)it._cards[ti].title=t;
        renderCards(it);updateMarketPreview(it);                              // 한 장씩 즉시 반영(읽는 게 보이게)
      }
    }catch(e){/* OCR 실패 시 정해진 라벨/카드N 유지 */}
  }catch(e){ alert('처리 실패: '+(e&&e.message||e)); }
  hideOverlay();
}
/* 이미 있는 카드(예: 예전에 '카드 N'으로 저장된 것)의 제목을 이미지에서 다시 읽어 고침.
   OCR 안 되면 정해진 분석 카테고리명으로라도 채움 → '카드 N'이 남지 않게. */
function _detectTitles(it){
  ensureCards(it);if(!it._cards.length)return;
  var labels=ANALYSIS_LABELS[catIdOf(it)]||[];
  return (async function(){
    var ocrOk=false; try{ await getTess(); ocrOk=true; }catch(e){ ocrOk=false; }
    for(var i=0;i<it._cards.length;i++){
      var ocr='';
      if(ocrOk){ showOverlay('카드 제목 인식 중… ('+(i+1)+'/'+it._cards.length+')'); try{ ocr=await ocrTitle(it._cards[i].url); }catch(e){ ocr=''; } }
      var snapped=snapLabel(ocr,labels);
      var t=snapped||((ocr&&ocr.length>=2&&ocr.length<=24)?ocr:'')||labels[i]||'';
      if(t&&t!==it._cards[i].title){it._cards[i].title=t;setDirty(true);}
      renderCards(it);updateMarketPreview(it);
    }
    hideOverlay();
  })();
}
/* 낱개 업로드: 이미지 1장 = 카드 1장 (자동분리 안 함). 제목은 원문 OCR(카테고리 강제스냅 없음). 여러 장 가능. */
async function _onAttachSingle(it,files){
  var arr=[].slice.call(files);if(!arr.length)return;
  showOverlay('올리는 중…');
  try{
    ensureCards(it);it._titleTried=true;
    var start=it._cards.length;
    for(var k=0;k<arr.length;k++){
      var f=arr[k];var pages=[];
      if(f.type==='application/pdf'||/\.pdf$/i.test(f.name)){
        if(!window.pdfjsLib)await ENV.loadLibrary('pdf');if(!window.pdfjsLib)throw new Error('PDF 모듈 로드 실패');
        var buf=await f.arrayBuffer();var pdf=await window.pdfjsLib.getDocument({data:buf}).promise;
        for(var n=1;n<=pdf.numPages;n++){var pg=await pdf.getPage(n);var vp=pg.getViewport({scale:2});var cc=document.createElement('canvas');cc.width=vp.width;cc.height=vp.height;await pg.render({canvasContext:cc.getContext('2d'),viewport:vp}).promise;pages.push(cc);}await pdf.destroy();
      }else if(f.type.indexOf('image/')===0){ pages.push(await fileToImage(f)); }
      else continue;
      for(var p=0;p<pages.length;p++){
        var im=pages[p];
        var card=trimToContent(im);   // 위·아래 빈 여백만 잘라 콘텐츠에 초점(자동 인식)
        if(card){var idx=it._cards.length;it._cards.push({title:'',url:card.url,revealed:false,committed:false,ord:idx});}
      }
    }
    setDirty(true);renderCards(it);updateMarketPreview(it);
    try{   // 제목: 원문 OCR 그대로(정해진 라벨로 강제 변환하지 않음)
      showOverlay('제목 인식 중…');await getTess();
      for(var ti=start;ti<it._cards.length;ti++){
        showOverlay('제목 인식 중… ('+(ti-start+1)+'/'+(it._cards.length-start)+')');
        var ocr=await ocrTitle(it._cards[ti].url);
        it._cards[ti].title=(ocr&&ocr.length>=2&&ocr.length<=24)?ocr:('카드 '+(ti+1));
        renderCards(it);updateMarketPreview(it);
      }
    }catch(e){}
  }catch(e){alert('처리 실패: '+(e&&e.message||e));}
  hideOverlay();
}
function fileToCanvas(file){return new Promise(function(res,rej){var u=URL.createObjectURL(file);var im=new Image();im.onload=function(){var cv=document.createElement('canvas');cv.width=im.naturalWidth;cv.height=im.naturalHeight;cv.getContext('2d').drawImage(im,0,0);URL.revokeObjectURL(u);res(cv);};im.onerror=rej;im.src=u;});}
function fileToImage(file){return new Promise(function(res,rej){var u=URL.createObjectURL(file);var im=new Image();im.onload=function(){res(im);};im.onerror=rej;im.src=u;});}
/* 원본(이미지/캔버스)에서 [top,bot) 구간만 잘라 dataURL 반환.
   원본 크기 통짜 캔버스를 만들지 않으므로 브라우저별 캔버스 크기 한계(사파리 등)에 안 걸린다. */
function cropFromSource(src,W,H,top,bot){
  top=Math.max(0,Math.round(top));bot=Math.min(H,Math.round(bot));var sh=bot-top;if(sh<24)return null;
  var c=document.createElement('canvas');c.width=W;c.height=sh;
  c.getContext('2d').drawImage(src,0,top,W,sh,0,0,W,sh);
  return {url:c.toDataURL('image/jpeg',0.9)};
}
/* 낱개 카드용 콘텐츠 트림 — 위·아래의 '균일한 빈 띠'(여백)만 잘라 콘텐츠에 초점.
   원리: 콘텐츠가 있는 행은 밝기 편차가 크고, 빈 여백 행은 거의 균일(편차 작음).
   행 편차로 위/아래 여백을 자동 인식 → 카드마다 텍스트·높이가 달라도 고치지 않고 잘 잘림.
   좌우 폭은 그대로 유지(요청: 윗/아랫 초점). 가운데 패널 사이 간격은 건드리지 않음. */
function trimToContent(src){
  var W=src.naturalWidth||src.width, H=src.naturalHeight||src.height;
  if(!W||!H) return cropFromSource(src,W,H,0,H);
  var s=Math.min(1, 4000/H, Math.sqrt(8000000/(W*H))); if(!(s>0)||!isFinite(s))s=1;
  var hs=Math.max(1,Math.round(H*s)), sw=Math.max(40,Math.round(W*s));
  var cv=document.createElement('canvas');cv.width=sw;cv.height=hs;
  cv.getContext('2d').drawImage(src,0,0,W,H,0,0,sw,hs);
  var d;try{d=cv.getContext('2d').getImageData(0,0,sw,hs).data;}catch(e){return cropFromSource(src,W,H,0,H);}
  function lum(p){return 0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];}
  var x0=Math.round(sw*0.03), x1=sw-Math.round(sw*0.03); if(x1<=x0){x0=0;x1=sw;}   // 가장자리 잡티 제외
  var step=Math.max(1,Math.floor((x1-x0)/140));
  var flatTol=14;   // 행 안 밝기 편차가 이보다 작으면 '빈 여백'으로 봄
  function flat(y){var mn=999,mx=-1,base=y*sw;for(var x=x0;x<x1;x+=step){var L=lum((base+x)*4);if(L<mn)mn=L;if(L>mx)mx=L;if(mx-mn>=flatTol)return false;}return true;}
  var ct=0;while(ct<hs&&flat(ct))ct++;
  var cb=hs-1;while(cb>ct&&flat(cb))cb--;
  if(ct>=cb){ct=0;cb=hs-1;}   // 전부 균일하면(인식 실패) 통째
  var pad=Math.max(14,Math.round(W*0.014));
  var card=cropFromSource(src,W,H, ct/s-pad, (cb+1)/s+pad);
  return card||cropFromSource(src,W,H,0,H);
}
/* 핵심: 어떤 PC·브라우저에서도 동일하게 동작하도록 —
   1) 분석은 축소본에서(대형 캔버스 한계 회피), 자르기는 원본에서 직접
   2) 배경 밝기를 이미지마다 자동 측정(어두운/밝은 테마 모두 인식)
   3) 좌측 번호배지로 경계 인식, 실패하면 '카드 사이 빈 줄' 간격으로 2차 분리 */
function splitCards(src){
  var W=src.naturalWidth||src.width, H=src.naturalHeight||src.height;
  if(!W||!H)return [];
  var s=Math.min(1, 8000/H, Math.sqrt(12000000/(W*H))); if(!(s>0)||!isFinite(s))s=1;
  var hs=Math.max(1,Math.round(H*s));
  var pad=Math.max(14,Math.round(W*0.014));
  function lum(d,p){return 0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];}
  function median(a){var b=a.slice().sort(function(x,y){return x-y;});return b[Math.floor(b.length/2)];}
  function rowMeans(d,wd){var ms=new Array(hs);for(var y=0;y<hs;y++){var t=0;for(var x=0;x<wd;x++){t+=lum(d,(y*wd+x)*4);}ms[y]=t/wd;}return ms;}
  // 1) 좌측 번호배지 띠 (배경과의 '차이'로 인식 — 테마 무관)
  var x0=Math.max(2,Math.round(W*0.035)),x1=Math.round(W*0.05);if(x1<=x0)x1=x0+12;
  var sw=Math.max(8,Math.round((x1-x0)*s));
  var sc=document.createElement('canvas');sc.width=sw;sc.height=hs;
  sc.getContext('2d').drawImage(src,x0,0,x1-x0,H,0,0,sw,hs);
  var d=sc.getContext('2d').getImageData(0,0,sw,hs).data;
  var bg=median(rowMeans(d,sw));
  var badge=new Array(hs);
  for(var y=0;y<hs;y++){var c=0;for(var x=0;x<sw;x++){if(Math.abs(lum(d,(y*sw+x)*4)-bg)>45)c++;}badge[y]=c>=2;}
  // 2) 콘텐츠 행 감지 (배경과의 차이 기준, 축소본)
  var SQW=240;var sq=document.createElement('canvas');sq.width=SQW;sq.height=hs;
  sq.getContext('2d').drawImage(src,0,0,W,H,0,0,SQW,hs);
  var sd=sq.getContext('2d').getImageData(0,0,SQW,hs).data;
  var bg2=median(rowMeans(sd,SQW));
  var need=Math.max(3,Math.round(SQW*0.018));
  var content=new Array(hs);
  for(var y2=0;y2<hs;y2++){var c2=0;for(var x2=0;x2<SQW;x2++){if(Math.abs(lum(sd,(y2*SQW+x2)*4)-bg2)>40)c2++;}content[y2]=c2>=need;}
  // 3) 배지 → 카드 경계 (축소 좌표)
  var minGap=Math.max(Math.round(180*s),Math.round(hs*0.017));
  var minRun=Math.max(3,Math.round(6*s));
  var tops=[],i=0;
  while(i<hs){if(badge[i]){var j=i;while(j<hs&&badge[j])j++;if(j-i>=minRun){if(!tops.length||i-tops[tops.length-1]>=minGap)tops.push(i);}i=j;}else i++;}
  var out=[];
  if(tops.length>=2){
    for(var k=0;k<tops.length;k++){
      var a=tops[k], b=(k<tops.length-1?tops[k+1]:hs);
      var g=segBounds(a,b,content,k<tops.length-1);
      if(g){var card=cropFromSource(src,W,H,g[0]/s-pad,g[1]/s+pad);if(card)out.push(card);}
    }
    if(out.length)return out;
  }
  // 4) 배지 실패 → 콘텐츠 블록 사이 '간격'을 자동 측정해 카드 경계로 분리
  //    (칸 안 작은 줄간격 vs 카드 사이 큰 간격을 중앙값 기준으로 구분 → 테마/브라우저 무관)
  var blocks=[],inB=false,bs0=0;
  for(var yy=0;yy<=hs;yy++){var isC=(yy<hs)&&content[yy];if(isC){if(!inB){inB=true;bs0=yy;}}else if(inB){blocks.push([bs0,yy]);inB=false;}}
  if(blocks.length>=2){
    var gaps=[];for(var b1=1;b1<blocks.length;b1++)gaps.push(blocks[b1][0]-blocks[b1-1][1]);
    var medGap=median(gaps);
    var thr=Math.max(Math.round(hs*0.012),Math.round(medGap*1.7),8);   // 카드 경계로 볼 최소 간격
    var groups=[[blocks[0]]];
    for(var b2=1;b2<blocks.length;b2++){var gp=blocks[b2][0]-blocks[b2-1][1];if(gp>=thr)groups.push([blocks[b2]]);else groups[groups.length-1].push(blocks[b2]);}
    if(groups.length>=2){
      var res=groups.map(function(g){var top=g[0][0],bot=g[g.length-1][1];return cropFromSource(src,W,H,top/s-pad,bot/s+pad);}).filter(Boolean);
      if(res.length>=2)return res;
    }
  }
  // 5) 통째 1장 (콘텐츠 범위만)
  var ct=0;while(ct<hs&&!content[ct])ct++;var cb=hs-1;while(cb>ct&&!content[cb])cb--;
  if(ct>=cb){ct=0;cb=hs-1;}
  var one=cropFromSource(src,W,H,ct/s-pad,(cb+1)/s+pad);
  return one?[one]:[];
}
// 구간 [a,b) 안에서 콘텐츠 상·하단(축소 좌표) 반환. hasNext면 다음 카드 머리·사이 배경을 건너뛴다.
function segBounds(a,b,content,hasNext){
  var ct=a; while(ct<b&&!content[ct])ct++; if(ct>=b)ct=a;
  var cb;
  if(hasNext){
    cb=b-1;
    while(cb>ct&&content[cb])cb--;
    while(cb>ct&&!content[cb])cb--;
  }else{
    cb=b-1; while(cb>ct&&!content[cb])cb--;
  }
  if(cb<=ct)cb=Math.min(b-1,ct+1);
  return [ct,cb+1];
}
function renderCards(it){
  ensureCards(it);var l=$('clist');var w=it._cards;
  if(!w.length){l.innerHTML='<div class="status show info" style="margin-top:8px;">아직 카드가 없습니다. 위에 이미지를 넣으면 자동 분리됩니다.</div>';return;}
  l.innerHTML='';
  w.forEach(function(a,i){
    var d=document.createElement('div');d.className='fitem';
    d.innerHTML='<div class="ord"><button data-up="'+i+'">▲</button><button data-down="'+i+'">▼</button></div>'+
      '<img src="'+a.url+'">'+
      '<div class="meta" style="flex:1;min-width:0;"><input class="cap" placeholder="카드 제목" value="'+esc(a.title||'')+'">'+
      '<label style="display:flex;align-items:center;gap:6px;margin-top:5px;font-size:.8rem;color:#445;cursor:pointer;"><input type="checkbox" '+(a.revealed?'checked':'')+' style="width:auto;"> 공개(체크 안 하면 블러)</label></div>'+
      '<button class="x">✕</button>';
    d.querySelector('[data-up]').onclick=function(){if(i>0){var o=w[i].ord;w[i].ord=w[i-1].ord;w[i-1].ord=o;sortCardsByReveal(it);setDirty(true);renderCards(it);updateMarketPreview(it);}};
    d.querySelector('[data-down]').onclick=function(){if(i<w.length-1){var o=w[i].ord;w[i].ord=w[i+1].ord;w[i+1].ord=o;sortCardsByReveal(it);setDirty(true);renderCards(it);updateMarketPreview(it);}};
    d.querySelector('.cap').oninput=function(){a.title=this.value;setDirty(true);updateMarketPreview(it);};
    d.querySelector('input[type=checkbox]').onchange=function(){a.revealed=this.checked;sortCardsByReveal(it);setDirty(true);renderCards(it);updateMarketPreview(it);};   // 공개=위로, 비공개=원래 자리
    d.querySelector('.x').onclick=function(){if(!confirm('이 카드를 뺄까요?'))return;w.splice(i,1);setDirty(true);renderCards(it);updateMarketPreview(it);};
    // 드래그로 카드 순서 정리
    d.setAttribute('draggable','true');
    var imgEl=d.querySelector('img');if(imgEl)imgEl.setAttribute('draggable','false');
    var capEl=d.querySelector('.cap');if(capEl)capEl.ondragstart=function(e){e.stopPropagation();};   // 제목 입력 중 텍스트 드래그가 카드 드래그로 안 가게
    d.ondragstart=function(e){cardDrag=i;d.classList.add('cdragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',''+i);}catch(_){}}};
    d.ondragend=function(){cardDrag=null;var t=$('clist');if(t)[].forEach.call(t.children,function(el){el.classList.remove('cdragging','cdrop');});};
    d.ondragover=function(e){if(cardDrag==null||cardDrag===i)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';d.classList.add('cdrop');};
    d.ondragleave=function(){d.classList.remove('cdrop');};
    d.ondrop=function(e){if(cardDrag==null)return;e.preventDefault();e.stopPropagation();var from=cardDrag;cardDrag=null;moveCard(it,from,i);};
    l.appendChild(d);
  });
}
/* 드래그한 카드를 대상 카드 앞으로 이동. ord 재부여 후 공개=위로 정렬 유지. */
function moveCard(it,from,to){
  var w=it._cards;if(from==null||to==null||from===to||from<0||to<0||from>=w.length||to>=w.length)return;
  var c=w.splice(from,1)[0];
  var dst=(from<to)?to-1:to;
  w.splice(dst,0,c);
  for(var i=0;i<w.length;i++)w[i].ord=i;
  sortCardsByReveal(it);setDirty(true);renderCards(it);updateMarketPreview(it);
}
/* 오픈업식 고객 화면 미리보기 */
function updateMarketPreview(it){
  ensureCards(it);var w=it._cards;
  var FORM='https://docs.google.com/forms/d/e/1FAIpQLSeRIOxxWOuf-kkhjSsLe5ctcw7GO8_jt5I4rM9sS3CDtJpP5g/viewform';
  var FF=FORM+'?usp=pp_url&entry.740000146='+encodeURIComponent('[매물을 구해주세요] ');
  var FH=FORM+'?usp=pp_url&entry.740000146='+encodeURIComponent('[매물은 구했어요] ');
  var LOCK='<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:-1px;margin-right:5px" aria-hidden="true"><path d="M17 8h-1V6A4 4 0 0 0 8 6v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4V6z"></path></svg>';
  var arr=w.map(function(a){
    var t=esc(a.title||'정보 카드');
    if(a.revealed){
      return '<div class="oc"><div class="oct on">'+t+'</div><img class="oi" src="'+a.url+'"></div>';
    }
    return '<div class="oc"><div class="oct off">'+LOCK+t+'</div><div class="olock"><img class="oi blur" src="'+a.url+'"><div class="ov"><div class="ovmsg">이 정보는 카페 창업자에게만<br>제공되는 서비스입니다</div></div></div></div>';
  });
  var cards=arr.join('');
  // 카드 아래 상담 유도(박스 아님): 질문 + 가로 두 버튼(구분선)
  var midcta='<div class="midcta"><div class="ask">카페 창업에 어떤 도움을 드릴까요?</div>'+
    '<div class="ctarow"><button class="cta2 find" type="button" onclick="openConsult(\'find\')">매물 구해주세요</button>'+
    '<button class="cta2 have" type="button" onclick="openConsult(\'have\')">매물은 구했어요</button></div></div>';
  if(!w.length)cards='<div style="text-align:center;color:#9aa6b3;padding:60px;">이미지를 넣으면 카드가 여기 표시됩니다.</div>';
  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">'+
   '<style>*{margin:0;box-sizing:border-box}body{font-family:Pretendard,sans-serif;background:#fff;color:#111;}'+
   '.watermark-overlay{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;background-image:url("data:image/png;base64,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");background-repeat:repeat;background-size:120px 120px;opacity:0.13}'+
   '.watermark-text-overlay{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9998;overflow:hidden}'+
   '.watermark-text-overlay::before{content:\'빈크래프트 BeanCraft  ·  빈크래프트 BeanCraft  ·  빈크래프트 BeanCraft  ·  빈크래프트 BeanCraft  ·  빈크래프트 BeanCraft  ·  빈크래프트 BeanCraft\';position:absolute;top:-50%;left:-50%;width:200%;height:200%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:rgba(43,108,176,0.07);letter-spacing:6px;white-space:nowrap;transform:rotate(-35deg)}'+
   '.copyright-bar{position:fixed;bottom:0;left:0;width:100%;z-index:10000;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#a0aec0;padding:10px 20px;font-size:.72rem;text-align:center;line-height:1.5;user-select:none;-webkit-user-select:none;pointer-events:none;border-top:2px solid #2b6cb0}.copyright-bar .cr-logo{display:inline-block;width:18px;height:18px;vertical-align:middle;margin-right:6px;background-image:url("data:image/png;base64,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");background-size:contain;background-repeat:no-repeat}.copyright-bar strong{color:#63b3ed}body{padding-bottom:84px}'+
   '.hd{background:linear-gradient(135deg,#1a365d,#0f2647);color:#fff;padding:26px 22px}.hd .area{font-size:1.3rem;font-weight:800}.hd .sub{font-size:.84rem;color:#cbd5e0;margin-top:4px}'+
   '.bd{max-width:560px;margin:0 auto;padding:18px 16px 40px;position:relative;z-index:6}'+
   '.purpose{border:1.5px solid #1a365d;border-radius:12px;padding:15px 17px;font-size:.86rem;line-height:1.75;color:#222;margin-bottom:10px}.purpose b{color:#1a365d}'+
   '.disc{font-size:.74rem;color:#8a93a0;line-height:1.6;margin:0 2px 8px;}'+
   '.collected{font-size:.8rem;color:#1a365d;font-weight:600;margin:0 2px 10px;}'+
   '.notice{background:#f4f7fb;border:1px solid #dde6f1;border-radius:10px;padding:11px 14px;font-size:.78rem;color:#3b4a5e;line-height:1.6;margin:0 2px 16px;display:flex;gap:7px;align-items:flex-start}.notice .ic{flex-shrink:0}'+
   '.hbtn{display:inline-block;margin-bottom:12px;background:#fff;color:#1a365d;border:1.5px solid #1a365d;font-weight:700;padding:10px 22px;border-radius:999px;text-decoration:none;font-size:.88rem}'+
   '.ask{font-size:.92rem;font-weight:700;color:#1a365d;margin-bottom:10px}'+
   '.midcta{text-align:center;margin:24px 2px 26px}.midcta .ask{font-size:1.05rem;font-weight:800;color:#1a365d;margin-bottom:12px}'+
   '.ctarow{display:flex;gap:10px;max-width:400px;margin:0 auto}.cta2{flex:1;text-align:center;font-weight:700;font-size:.96rem;padding:13px 12px;border-radius:10px;cursor:pointer;font-family:inherit;text-decoration:none;border:1.5px solid #1a365d}.cta2.find{background:#1a365d;color:#fff}.cta2.have{background:#fff;color:#1a365d}'+
   '.cmodal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:none;align-items:center;justify-content:center;padding:16px}.cmodal.open{display:flex}'+
   '.cbox{background:#fff;border-radius:16px;width:440px;max-width:calc(100vw - 32px);height:800px;max-height:calc(100vh - 56px);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.35)}'+
   '.chead{background:linear-gradient(135deg,#1a365d,#2b6cb0);color:#fff;padding:14px 18px;display:flex;align-items:center;justify-content:space-between}.chead b{font-size:1rem;font-weight:800}.cclose{background:none;border:0;color:#fff;font-size:1.1rem;cursor:pointer;padding:4px 8px;line-height:1}.cbox iframe{flex:1;width:100%;border:0;background:#fff}'+
   '.oc{border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;margin-bottom:14px;background:#fff}'+
   '.oct{padding:11px 15px;font-size:.95rem;border-bottom:1px solid #f0f2f4}.oct.on{font-weight:800;color:#111}.oct.off{font-weight:600;color:#9aa6b3}'+
   '.oi{width:100%;display:block}.oi.blur{filter:blur(11px);transform:scale(1.04)}'+
   '.olock{position:relative;max-height:220px;overflow:hidden}'+
   '.ov{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(20,30,50,.34)}'+
   '.ovmsg{color:#fff;font-weight:700;font-size:.95rem;text-align:center;line-height:1.5;text-shadow:0 1px 6px rgba(0,0,0,.4)}'+
   '.ovbtn{background:#fff;color:#1a365d;font-weight:800;font-size:.9rem;padding:10px 20px;border-radius:999px;text-decoration:none}'+
   '.foot{margin-top:8px;border-top:1px dashed #d3d9e0;padding-top:18px;text-align:center}'+
   '.foot p{font-size:.85rem;color:#445;line-height:1.7;margin-bottom:14px}.foot .site{color:#1a365d;font-weight:700}'+
   '.cta{display:inline-block;background:#1a365d;color:#fff;font-weight:800;padding:13px 26px;border-radius:999px;text-decoration:none;font-size:.95rem}</style></head>'+
   '<body><div class="watermark-overlay"></div><div class="watermark-text-overlay"></div>'+
   '<div class="hd"><div class="area">'+esc(it.title||'상권분석 리포트')+'</div><div class="sub">빈크래프트 상권분석 리포트</div></div>'+
   '<div class="bd">'+
   '<div class="purpose">이 자료는 빈크래프트가 직접 개발한 상권분석 프로그램으로 분석한 실제 데이터입니다. 저희는 <b>상권분석을 파는 회사가 아니라, 매물부터 오픈까지 함께하는 카페 창업 회사</b>예요. 상권분석은 창업을 준비하는 과정의 일부입니다.<br><br>그래서 이 자료도 전체 중 일부만 공개해 두었어요. 정보를 팔려는 게 아니라, 저희가 창업을 도울 때 <b>이런 데이터까지 들여다본다</b>는 걸 보여드리고 싶었습니다. 모든 정보는 카페 창업자를 위해 준비해 두었습니다.</div>'+
   '<div class="disc">※ 분석 데이터는 실시간으로 수집되지만, 본 자료는 <b>수집된 시점 기준</b> 정보입니다. 전체 분석은 카페 창업 상담 시에만 제공됩니다.</div>'+
   midcta+
   '<div class="notice"><span>공개된 정보는 <b>영상 속에 첨부한 정보</b>만 보여드리고 있습니다.</span></div>'+
   cards+
   '<div class="foot"><a class="hbtn" href="https://beancraft.co.kr" target="_blank" rel="noopener">빈크래프트 홈페이지 바로가기</a><p><b>빈크래프트는 프랜차이즈 회사가 아닙니다.</b><br>개인 카페를 만들어 주는 회사입니다.</p></div>'+
   '</div>'+
   '<div class="copyright-bar"><span class="cr-logo"></span><strong>© 2026 BEANCRAFT</strong>. All Rights Reserved.<br>본 문서는 <strong>빈크래프트</strong>가 제작한 저작물로, 무단 수정 · 복제 · 배포를 엄격히 금합니다. 저작권법에 의해 보호를 받는 저작물이므로 무단 전재 및 재배포는 법적 제재를 받을 수 있습니다.</div>'+
   '<div class="cmodal" id="cmodal" onclick="if(event.target===this)closeConsult()"><div class="cbox"><div class="chead"><b id="ctitle">무료 상담 신청</b><button class="cclose" type="button" onclick="closeConsult()" aria-label="닫기">✕</button></div><iframe id="cframe" title="상담 신청 폼"></iframe></div></div>'+
   '<scr'+'ipt>var CONSULT="'+FORM+'";function openConsult(type){var pre=(type==="have")?"[매물은 구했어요] ":"[매물을 구해주세요] ";var t=document.getElementById("ctitle");if(t)t.textContent=(type==="have")?"매물은 구했어요 · 상담 신청":"매물 구해주세요 · 상담 신청";document.getElementById("cframe").src=CONSULT+"?embedded=true&usp=pp_url&entry.740000146="+encodeURIComponent(pre);document.getElementById("cmodal").classList.add("open");}function closeConsult(){var m=document.getElementById("cmodal");if(m)m.classList.remove("open");var f=document.getElementById("cframe");if(f)f.src="about:blank";}<\/scr'+'ipt>'+
   '</body></html>';
  setPreviewHTML(html);
}

function clearStage(){$('stage').innerHTML='<div class="welcome" id="welcome"><h2>왼쪽에서 카테고리를 펼쳐 항목을 선택하세요</h2><p>카드뉴스는 주제만 입력하면 새 페이지가 만들어지고,<br>상권분석은 파일을 첨부하면 폼에 적용됩니다.<br>편집 후 우측 상단 <b>배포</b>를 누르면 고객에게 공개됩니다.</p></div>';$('crumb').innerHTML='<span>마케팅</span>';var bb=$('backBtn');if(bb)bb.classList.add('hidden');}

/* ===== 배포 ===== */
$('deployBtn').onclick=function(){if(!dirty&&!_publishIntent)return;if(ENV.authority==='review')return saveReviewTeam();return showDeployConfirm();};
function showOverlay(m){$('overlayMsg').textContent=m;$('overlay').classList.add('show');}
function hideOverlay(){$('overlay').classList.remove('show');}

function uploadDataUrl(itemId,dataUrl,plan){
  var fn=plan&&plan.name?plan.name:uid('card')+'.jpg';var ref=fbStore.ref(STORAGE_DIR+'/'+itemId+'/'+fn);
  return new Promise(function(resolve,reject){
    var done=false;
    var t=setTimeout(function(){if(!done){done=true;reject(new Error('사진 업로드 응답 없음(30초 초과). Firebase 콘솔에서 Storage가 사용설정됐는지 / Storage 규칙이 로그인 사용자 쓰기를 허용하는지 확인하세요.'));}},30000);
    var metadata=plan?{customMetadata:{guideOperationId:plan.operationId,guideContentHash:plan.contentHash,guideDerivative:plan.role}}:undefined;
    // Reconcile an uncertain upload at its own immutable input-derived path.
    // Existing metadata of another input is never overwritten. Storage and RTDB
    // are separate commits; unused uploaded assets remain tracked, not deleted.
    var work=plan?ref.getMetadata().then(function(m){var x=m.customMetadata||{};if(x.guideOperationId!==plan.operationId||x.guideContentHash!==plan.contentHash||x.guideDerivative!==plan.role)throw new Error('기존 이미지와 업로드 입력이 다릅니다. 덮어쓰지 않았습니다.');return null;}).catch(function(e){if(e&&e.code==='storage/object-not-found'&&!done)return ref.putString(dataUrl,'data_url',metadata);throw e;}):ref.putString(dataUrl,'data_url');
    work.then(function(){if(done)throw new Error('업로드 결과 확인 시간이 지났습니다.');return ref.getDownloadURL();})
      .then(function(url){if(!done){done=true;clearTimeout(t);resolve(url);}})
      .catch(function(e){if(!done){done=true;clearTimeout(t);reject(new Error('Storage 업로드 실패: '+((e&&e.code)||(e&&e.message)||e)));}});
  });
}
// 가린 카드용: 블러를 이미지에 영구적으로 구워서 dataURL 반환 (원본은 고객에게 전송 안 됨)
function blurToDataUrl(srcDataUrl){return new Promise(function(resolve,reject){
  var image=new Image(),settled=false,timer=setTimeout(function(){finish(new Error('블러 변환 응답 시간이 지났습니다.'));},30000);
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);}
  image.crossOrigin='anonymous';
  image.onload=function(){if(settled)return;try{
    var w=image.naturalWidth,h=image.naturalHeight;if(!w||!h)throw new Error('이미지 크기가 없습니다.');
    var canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;var context=canvas.getContext('2d');
    context.filter='blur('+Math.max(16,Math.round(w*0.022))+'px)';context.drawImage(image,0,0,w,h);context.filter='none';context.fillStyle='rgba(15,20,30,0.16)';context.fillRect(0,0,w,h);
    finish(null,canvas.toDataURL('image/jpeg',0.5));
  }catch(e){finish(new Error('블러 변환 실패: 이미지 접근 권한/CORS를 확인하고 다시 첨부해 주세요.'));}};
  image.onerror=function(){finish(new Error('블러 변환용 이미지를 읽지 못했습니다.'));};image.src=srcDataUrl;
});}
// 공개 카드용: 1400px로 축소 + 워터마크를 이미지에 영구히 구워 dataURL 반환 → 네트워크탭으로 빼가도 워터마크 저화질본만 나감
function watermarkToDataUrl(srcDataUrl){return new Promise(function(resolve){
  var settled=false,timer=setTimeout(function(){res(null);},30000);function res(value){if(settled)return;settled=true;clearTimeout(timer);resolve(value);}
  var im=new Image();im.crossOrigin='anonymous';
  im.onload=function(){if(settled)return;try{
    var w=im.naturalWidth,h=im.naturalHeight,cap=1400;
    var s=Math.min(1,cap/Math.max(w,h));var W=Math.max(1,Math.round(w*s)),H=Math.max(1,Math.round(h*s));
    var cv=document.createElement('canvas');cv.width=W;cv.height=H;var x=cv.getContext('2d');
    x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';x.drawImage(im,0,0,W,H);
    // 대각선 반복 텍스트 워터마크 — 카드가 어두우므로 흰 글씨(옅게). 그림자로 밝은 영역에서도 보이게.
    x.save();x.translate(W/2,H/2);x.rotate(-32*Math.PI/180);x.textAlign='center';x.textBaseline='middle';
    var fs=Math.max(13,Math.round(W*0.019));x.font='bold '+fs+'px sans-serif';
    x.shadowColor='rgba(0,0,0,0.18)';x.shadowBlur=2;
    var stepY=Math.max(64,Math.round(W*0.10)),unit='빈크래프트 BeanCraft      ';
    var line='';for(var k=0;k<10;k++)line+=unit;
    var span=Math.max(W,H)*1.3;
    for(var yy=-span;yy<span;yy+=stepY){x.fillStyle='rgba(255,255,255,0.14)';x.fillText(line,0,yy);}
    x.restore();
    res(cv.toDataURL('image/jpeg',0.82));
  }catch(e){res(null);}};   // cross-origin(기존 https 카드)으로 캔버스 오염 시 null → 호출부에서 폴백
  im.onerror=function(){res(null);};
  im.src=srcDataUrl;
});}
/* 고객 공개본 URL 선택 — 선명한 원본(file)은 어떤 경우에도 내보내지 않는다(경쟁사 원본 유출 방지).
   공개 카드=워터마크본(wm), 없으면 블러로 안전 폴백. 가린 카드=블러본. 둘 다 없으면 빈값(표시 안 함). */
function publicCardFile(cd){
  if(!cd)return '';
  try{return GuidePublishing.safeCard(cd);}catch(e){return '';}
}

function stripT(o){return JSON.parse(JSON.stringify(o,function(k,v){return k.charAt&&k.charAt(0)==='_'?undefined:v;}));}
async function acceptGuidePublication(result,capture,submitted){
  if(capture.uid!==(curUser&&curUser.uid))return;
  if(!result.currentMatchesAfter)return;   // historical success is not the latest editor base
  if(capture.writerId!==_draftWriterId&&!GuidePublishing.equal(submitted,serializeData()))return {needsComparison:true};
  var clear=await clearSubmittedGuideDraft(capture);
  _guideBase={known:true,team:GuidePublishing.clone(result.team),state:GuidePublishing.clone(result.publicationState)};
  if(clear){data=GuidePublishing.clone(result.team)||{categories:[]};normalizeData(data);migrateCategories(data);setDirty(false);}
  else{GuidePublisherRuntime.rebaseAssets(data,submitted,result.team);setDirty(true);}
  renderTree();highlightActive();
}
function downloadGuideRecovery(recovery){
  var count=recovery.verifiedItemIds.length,blocked=recovery.blocked.length;
  if(!count){alert('이전 백업에는 자동으로 소유·파생본을 확인할 수 있는 항목이 없습니다. 현재 자료와 초안을 변경하지 않았습니다.');return;}
  if(!confirm('이전 형식 백업은 이후 판본을 확인할 수 없어 즉시 복원하지 않습니다.\n확인 가능한 '+count+'개 항목의 편집 복구안만 내려받습니다.'+(blocked?' 확인되지 않은 '+blocked+'개 항목은 제외합니다.':'')+'\n고객 화면과 현재 초안은 변경하지 않습니다.\n\n내려받을까요?'))return;
  var url=URL.createObjectURL(new Blob([JSON.stringify(recovery,null,2)],{type:'application/json'}));
  var link=document.createElement('a');link.href=url;link.download='guide-legacy-recovery.json';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},0);
}
var guidePublisher=GuidePublisherRuntime.create({
  actor:function(){return isAllowed(curUser)?{uid:curUser.uid,email:curUser.email}:null;},
  ready:function(){return _publicationReadable;},
  clock:{setTimeout:function(fn,ms){return setTimeout(fn,ms);},clearTimeout:function(timer){clearTimeout(timer);}},
  capture:captureGuideDraft,today:today,intent:function(){return _publishIntent;},setIntent:function(v){_publishIntent=v;},
  write:function(k,v){return idbSet(k,v);},remove:function(k,check){return idbDelIf(k,check);},
  parentRef:function(){return fbDb.ref('marketing');},readBackup:async function(key){return(await fbDb.ref(BACKUP_REF+'/'+key).once('value')).val();},
  submitPublication:ENV.runtime?.submitPublication,
  blur:function(src){return blurToDataUrl(src);},watermark:function(src){return watermarkToDataUrl(src);},upload:function(item,src,plan){return uploadDataUrl(item,src,plan);},
  busy:function(m){showOverlay(m);},idle:function(){hideOverlay();},confirm:function(m){return confirm(m);},
  warning:function(m){alert(m);},legacy:downloadGuideRecovery,accept:acceptGuidePublication,
  error:function(e){alert((e&&e.state==='unknown'?'배포 결과 확인 필요: ':'배포하지 못했습니다: ')+(e&&e.message||e));},
  completed:function(kind,warnings,result,capture){
    if(kind==='restore'){$('backupModal').classList.remove('show');alert('GUIDE 소유 범위를 확인해 복원했습니다. 다른 프로그램 자료는 유지했습니다.');}
    else showDeployModal(deployShareInfo(result.team,capture.selection));
    if(warnings.length)alert('워터마크를 만들지 못한 공개 카드는 검증된 블러로 표시했습니다. 원본은 공개하지 않았습니다.\n· '+warnings.join('\n· '));
  }
});
function deploy(confirmedCapture){
  if(ENV.strict&&ENV.authority==='native'&&!ENV.publicBase){alert('기존 고객페이지의 정확한 공개 주소 연결이 필요합니다. 입력은 보관했습니다.');return Promise.resolve({state:'blocked',code:'public_base_required'});}
  if(ENV.authority==='review')return saveReviewTeam();
  if(DEMO){showOverlay('(데모) 배포 시뮬레이션…');return new Promise(function(resolve){setTimeout(function(){hideOverlay();setDirty(false);showDeployModal();resolve({state:'demo'});},1000);});}
  return confirmedCapture?guidePublisher.deploy(confirmedCapture):(_publishIntent?guidePublisher.resume():guidePublisher.deploy());
}
/* Full GUIDE receipts are retained atomically by the publisher. No separate
   pruning/removal of unknown or legacy backups is performed by the studio. */
function bkSummary(b){
  var scoped=GuidePublishing.isReceipt(b),t=(scoped?b.before.team:(b&&b.team))||{},n=0,c=0;
  asArray(t.categories).forEach(function(cat){if(!cat||typeof cat!=='object')return;asArray(cat.items).forEach(function(it){if(!it||typeof it!=='object')return;n++;if(it.cards)c+=asArray(it.cards).length;});});
  return (scoped?'GUIDE 범위 · ':'이전 형식 · ')+n+'개 항목'+(c?' · 카드 '+c+'장':'');
}
async function renderBackupList(){
  var el=$('backupList');if(!el)return;
  if(DEMO){el.innerHTML='<div class="status show info">(데모 모드) 실제 로그인 시 배포 이력이 표시됩니다.</div>';return;}
  el.innerHTML='<div class="status show info">불러오는 중…</div>';
  var owner=draftKey(),actor=curUser&&curUser.uid;
  var results=await Promise.allSettled([fbDb.ref(BACKUP_REF).once('value'),idbList('publish-intent_'+owner+'_')]);
  if(owner!==draftKey()||actor!==(curUser&&curUser.uid))return;
  var cloud=results[0],local=results[1],h='',pending={};
  if(local.status==='fulfilled')local.value.forEach(function(row){var op=row.value;if(!op||!op.actor||op.actor.uid!==actor||typeof op.id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(op.id)||!op.capture||op.capture.key!==owner||['deploy','restore'].indexOf(op.kind)<0)return;pending[op.id]=op;h+='<div style="padding:9px 11px;border:1px solid #e4e9ef;border-radius:8px;margin-bottom:7px;"><b>확인할 '+(op.kind==='restore'?'복원':'배포')+' 작업</b><div class="dnote">'+esc(agFmt(op.at))+' · '+esc(op.id)+'</div><button class="btn ghost sm" data-pending="'+esc(op.id)+'">'+(op.phase==='ready'?'같은 작업 확인·재시도':'준비 이어가기')+'</button></div>';});
  else h+='<div class="status show bad">로컬 준비 작업을 읽지 못했습니다. 현재 편집 내용은 유지됩니다.</div>';
  if(cloud.status==='fulfilled'){
    var all=cloud.value.val()||{},keys=Object.keys(all).sort(function(a,b){return((all[b]&&all[b].at)||0)-((all[a]&&all[a].at)||0)||b.localeCompare(a);});
    if(!keys.length&&!Object.keys(pending).length)h+='<div class="status show info">아직 복구 기록이 없습니다. 정상 배포가 확정되면 함께 기록됩니다.</div>';
    keys.forEach(function(k){var item=all[k]||{};h+='<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 11px;border:1px solid #e4e9ef;border-radius:8px;margin-bottom:7px;"><div style="min-width:0;"><div style="font-weight:700;font-size:.86rem;">'+esc(agFmt(item.at))+'</div><div style="font-size:.74rem;color:#8a93a0;">'+esc(bkSummary(item))+(typeof item.by==='string'&&item.by?' · '+esc(item.by):'')+'</div></div><button class="btn ghost sm" data-bk="'+esc(k)+'">'+(GuidePublishing.isReceipt(item)?'범위 확인 후 복원':'편집 복구안')+'</button></div>';});
  }else h+='<div class="status show bad">클라우드 복구 기록을 읽지 못했습니다. 로컬 준비 작업은 별도로 확인할 수 있습니다.</div>';
  el.innerHTML=h;
  el.querySelectorAll('[data-bk]').forEach(function(btn){btn.onclick=function(){restoreBackup(btn.dataset.bk);};});
  el.querySelectorAll('[data-pending]').forEach(function(btn){btn.onclick=function(){if(guidePublisher.busy()){alert('진행 중인 작업의 결과를 먼저 확인해 주세요.');return;}var op=pending[btn.dataset.pending];if(!op)return;_publishIntent=GuidePublishing.clone(op);$('backupModal').classList.remove('show');showDeployConfirm();};});
}
function restoreBackup(bkey){return guidePublisher.restoreBackup(bkey);}

/* ===== 배포 후 링크 복사 팝업 ===== */
function deployShareInfo(teamOverride,selectionOverride){
  var source=arguments.length?teamOverride:data,selection=arguments.length>1?selectionOverride:sel,cs=asArray(source&&source.categories);
  if(selection){var cat=cs.find(function(c){return c.id===selection.cat;}),item=cat&&asArray(cat.items).find(function(it){return it.id===selection.item;});if(item){
    if(item.type==='page'&&item.page)return {url:(ENV.publicBase||location.origin)+'/'+String(item.page).replace(/^\/+/,''),name:item.title||'(제목 없음)'};
    return {url:(ENV.publicBase||location.origin)+'/m/#'+item.id,name:item.title||'(제목 없음)'};
  }}
  for(var i=0;i<cs.length;i++){var rows=asArray(cs[i].items);if(cs[i].kind==='market'&&rows[0])return {url:(ENV.publicBase||location.origin)+'/m/#'+rows[0].id,name:rows[0].title||'(제목 없음)'};}
  return {url:(ENV.publicBase||location.origin)+'/m/',name:'상권분석'};
}
function showDeployModal(info){
  info=info||deployShareInfo();
  $('dmName').textContent=info.name||'';
  $('dmUrl').value=info.url;
  $('dmOpen').href=info.url;
  $('dmMsg').textContent='';
  $('deployModal').classList.add('show');
}
/* 배포 전 확인 — 통째 덮어쓰기 전에 요약 보여주고 명시적 확인 받음(오배포 방지) */
function deploySummary(source){
  source=source||data;var cats=asArray(source.categories),items=0,pages=0,revealed=0,hidden=0;
  cats.forEach(function(c){asArray(c.items).forEach(function(it){
    items++;if(it.type==='page'){pages++;return;}
    asArray(it._cards||it.cards).forEach(function(card){if(card&&card.revealed)revealed++;else hidden++;});
  });});
  return {items:items,pages:pages,revealed:revealed,hidden:hidden,last:(source.updated||'기록 없음')};
}
function guidePendingConfirmation(intent){return intent?{id:intent.id,kind:intent.kind,actor:intent.actor,operation:intent.operation||null,snapshot:intent.snapshot,base:intent.base,restoreReceipt:intent.restoreReceipt||null}:null;}
function freezeGuideConfirmation(value){var copy=GuidePublishing.clone(value);function freeze(v){if(v&&typeof v==='object'){Object.keys(v).forEach(function(k){freeze(v[k]);});Object.freeze(v);}return v;}return freeze(copy);}
function showDeployConfirm(){
  var pending=_publishIntent,capture=captureGuideDraft();
  _guideConfirmation=freezeGuideConfirmation({kind:pending?'pending':'fresh',capture:capture,pending:guidePendingConfirmation(pending)});
  var source=pending?(pending.operation?pending.operation.team:(pending.kind==='restore'&&pending.restoreReceipt?pending.restoreReceipt.before.team:pending.snapshot)):_guideConfirmation.capture.data;
  var summary=deploySummary(source||{categories:[]});
  var text='항목 <b>'+summary.items+'개</b>'+(summary.pages?' (카드뉴스 '+summary.pages+'개 포함)':'')+'<br>공개 카드 <b>'+summary.revealed+'개</b> · 가림 카드 <b>'+summary.hidden+'개</b><br>직전 배포: '+esc(summary.last);
  if(pending){
    var titles=[];asArray(source&&source.categories).forEach(function(cat){asArray(cat.items).forEach(function(item){titles.push('<div>'+esc(item.title||'(제목 없음)')+'</div>');});});
    text='<b>준비했던 원래 '+(pending.kind==='restore'?'복원':'배포')+' 작업</b><br>'+text+'<br>저장 기록을 확인하고, 기록이 없으면 같은 내용으로 다시 시도합니다. 이후에 추가한 초안은 이 작업에 포함하지 않습니다.<details><summary>준비했던 항목 보기</summary><div style="max-height:160px;overflow:auto;">'+titles.join('')+'</div></details>';
  }
  $('dcSummary').innerHTML=text;$('dcGo').textContent=pending?'같은 작업 확인·재시도':'네, 배포할게요';
  $('deployConfirm').classList.add('show');
}
$('dcCancel').onclick=function(){_guideConfirmation=null;$('deployConfirm').classList.remove('show');};
$('dcGo').onclick=function(){
  var confirmation=_guideConfirmation;_guideConfirmation=null;
  if(!confirmation||confirmation.capture.key!==draftKey()||confirmation.capture.uid!==(curUser&&curUser.uid||'demo')||guidePublisher.busy()||!GuidePublishing.equal(confirmation.pending,guidePendingConfirmation(_publishIntent))){alert('확인 이후 계정이나 준비 작업이 달라졌습니다. 배포 내용을 다시 확인해 주세요.');return {state:'blocked',code:'confirmation_changed'};}
  $('deployConfirm').classList.remove('show');
  return deploy(confirmation.kind==='fresh'?confirmation.capture:undefined);
};
$('rollbackBtn').onclick=function(){renderBackupList();$('backupModal').classList.add('show');};
$('bkClose').onclick=function(){$('backupModal').classList.remove('show');};

$('dmCopy').onclick=function(){
  var u=$('dmUrl').value;
  function ok(){$('dmMsg').textContent='복사됐어요! 고객에게 붙여넣어 보내세요.';}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(ok).catch(function(){try{$('dmUrl').select();document.execCommand('copy');ok();}catch(e){$('dmMsg').textContent='주소창을 길게 눌러 직접 복사해주세요.';}});}
  else{try{$('dmUrl').select();document.execCommand('copy');ok();}catch(e){$('dmMsg').textContent='주소창을 길게 눌러 직접 복사해주세요.';}}
};
$('dmClose').onclick=function(){$('deployModal').classList.remove('show');};
/* 채널별 UTM 링크 — GA에서 유입 채널(인스타/카톡/문자) 구분용. 해시(#id) 앞에 쿼리 삽입. */
function utmLink(url,channel){
  var map={instagram:'instagram|social',kakao:'kakao|messenger',sms:'sms|sms'};
  var m=(map[channel]||(channel+'|social')).split('|');
  var hash='',u=url,hi=u.indexOf('#');if(hi>=0){hash=u.slice(hi);u=u.slice(0,hi);}
  var sep=u.indexOf('?')>=0?'&':'?';
  return u+sep+'utm_source='+m[0]+'&utm_medium='+m[1]+hash;
}
function bcCopy(text,msg){
  function ok(){$('dmMsg').textContent=msg||'복사됐어요!';}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok).catch(function(){prompt('아래 링크를 복사하세요',text);});}
  else{try{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok();}catch(e){prompt('아래 링크를 복사하세요',text);}}
}
$('dmUtmIg').onclick=function(){bcCopy(utmLink($('dmUrl').value,'instagram'),'인스타용 링크 복사됨 (인스타에 붙여넣기)');};
$('dmUtmKakao').onclick=function(){bcCopy(utmLink($('dmUrl').value,'kakao'),'카톡용 링크 복사됨 (카톡에 붙여넣기)');};
$('dmUtmSms').onclick=function(){bcCopy(utmLink($('dmUrl').value,'sms'),'문자용 링크 복사됨 (문자에 붙여넣기)');};

window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});

/* ===== 동의서(창업 디렉팅 신청서) 관리 =====
   마케팅 배포 흐름(data/dirty/deploy)과 완전 분리 — agreements/ 경로에 직접 기록.
   고객 페이지: /agree/#<id> (DB의 doc 스냅샷을 읽음). 데모 모드는 메모리 저장으로 동작. */
var AGREE_BASE=(ENV.publicBase||'')+'/agree/#';
var agOn=false, agCache={}, agDemoStore={}, agView=false, dashView=false, LOOKER_EMBED='https://lookerstudio.google.com/embed/reporting/72ead548-31e4-4d1e-93dc-d45214caa7dc/page/TlJ0C';
var postOn=false, postCache={}, postDemoStore={}, composeView=false, editingPostId=null, _cpThumb='';
function aid(){var a=new Uint8Array(16);try{crypto.getRandomValues(a);}catch(e){for(var i=0;i<16;i++)a[i]=Math.floor(Math.random()*256);}return Array.prototype.map.call(a,function(b){return ('0'+b.toString(16)).slice(-2);}).join('');}
function sha256Hex(str){
  try{return crypto.subtle.digest('SHA-256',new TextEncoder().encode(str)).then(function(buf){return Array.prototype.map.call(new Uint8Array(buf),function(b){return ('0'+b.toString(16)).slice(-2);}).join('');});}
  catch(e){return Promise.resolve('');}
}
function agFmt(ms){if(!ms)return '-';try{var d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}catch(e){return '-';}}
function agStatus(rec){if(rec&&rec.reviewOnly)return ['검토안','wait'];var d=(rec&&rec.doc)||{};if(rec&&rec.archive)return ['파기됨','mut'];if(rec&&rec.submission)return ['완료','ok'];if(d.revoked===true)return ['무효','mut'];if(d.expireAt&&Date.now()>d.expireAt)return ['만료','mut'];if(rec&&rec.views)return ['열람','view'];return ['대기','wait'];}
function agStart(){
  if(DEMO){agCache=agDemoStore;agRefreshUI();return;}
  if(agOn)return;agOn=true;
  fbDb.ref('agreements').on('value',function(s){agCache=s.val()||{};agRefreshUI();},function(e){if($('agList'))$('agList').textContent='신청서를 읽지 못했습니다: '+(e&&e.message||e);});
}
function agRefreshUI(){
  var ids=Object.keys(agCache||{});
  var done=ids.filter(function(id){return agCache[id]&&agCache[id].submission;}).length;
  var b=$('agreeBadge');if(b){if(done>0){b.textContent='완료 '+done;b.classList.remove('hidden');}else{b.classList.add('hidden');}}
  if(agView&&$('agList'))renderAgreeList();
  if(dashView)dashRender();
}
function agCopy(text,btn){
  function ok(){if(btn){var t=btn.textContent;btn.textContent='복사됨';setTimeout(function(){btn.textContent=t;},1200);}}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok).catch(function(){prompt('아래 주소를 복사하세요',text);});}
  else prompt('아래 주소를 복사하세요',text);
}
/* ===== 콘텐츠 작성·발행 큐 (릴스/숏츠 준비) — posts 큐. 실제 발행은 쇼츠 편집기/서버 연결 시 동작 ===== */
function postStart(){
  if(DEMO){postCache=postDemoStore;postRefreshUI();return;}
  if(postOn)return;postOn=true;
  fbDb.ref('posts').on('value',function(s){postCache=s.val()||{};postRefreshUI();},function(e){if(composeView&&$('postList'))$('postList').innerHTML='<div class="status show bad">콘텐츠 큐를 불러오지 못했습니다(접근 권한/Firebase 규칙 확인): '+esc(e&&e.message||'')+'</div>';});
}
function postRefreshUI(){ if(composeView&&$('postList'))renderPostList(); }
function postStatus(p){ if(!p)return ['초안','wait']; var s=p.status; if(s==='published')return ['게시됨','ok']; if(s==='claimed')return ['처리중','view']; if(s==='error')return ['실패','mut']; if(s==='ready')return ['준비완료','view']; return ['초안','wait']; }
function composePreview(){
  var pv=$('cpPreview');if(!pv)return;
  var cap=$('cpCaption')?$('cpCaption').value:'', tags=$('cpTags')?$('cpTags').value:'';
  pv.innerHTML='<div class="igcard">'+(_cpThumb?'<img src="'+_cpThumb+'">':'<div class="igph">썸네일 미리보기</div>')+
    '<div class="igcap">'+(esc(cap)||'<span style="color:#9aa6b3">캡션 미리보기</span>')+(tags?'<br><span class="igtags">'+esc(tags)+'</span>':'')+'</div></div>';
}
function renderCompose(){
  _postFormVersion++;
  setActiveView('compose');
  $('crumb').innerHTML='<span>콘텐츠 작성·발행</span>';
  _cpThumb='';editingPostId=null;_postEditBase=null;
  $('stage').innerHTML='<div class="cpwrap">'+
    '<div class="agcard"><h3 id="cpHead">새 콘텐츠 작성</h3><div class="cprow">'+
      '<div class="cpform">'+
        '<label class="fl2">내부 제목</label><input type="text" id="cpTitle" placeholder="예: 합정 카페 릴스 1편">'+
        '<label class="fl2">캡션</label><textarea id="cpCaption" rows="4" placeholder="인스타/유튜브에 올릴 문구"></textarea>'+
        '<label class="fl2">해시태그</label><input type="text" id="cpTags" placeholder="#카페창업 #상권분석">'+
        '<label class="fl2">대상</label><div style="display:flex;gap:14px;margin:4px 0;"><label class="ck2"><input type="checkbox" id="cpIg" checked> 인스타 릴스</label><label class="ck2"><input type="checkbox" id="cpYt"> 유튜브 숏츠</label></div>'+
        '<label class="fl2">썸네일</label><input type="file" id="cpThumbFile" accept="image/*">'+
        '<label class="fl2">영상 링크 (편집기 결과 URL · 선택)</label><input type="text" id="cpVideo" placeholder="https://...">'+
        '<div style="margin-top:14px;display:flex;gap:8px;"><button class="btn deploy sm" id="cpSave">큐에 저장</button><button class="btn ghost sm" id="cpReset">새로 작성</button></div>'+
        '<div class="dnote" style="margin-top:8px;">저장하면 아래 큐에 쌓입니다. \'준비완료\'로 바꾸면 쇼츠 편집기가 집어가 발행하는 구조(편집기 연결 시 동작).</div>'+
      '</div>'+
      '<div class="cpprev"><div class="dnote" style="margin-bottom:6px;">미리보기</div><div id="cpPreview"></div></div>'+
    '</div></div>'+
    '<div class="agcard"><h3>콘텐츠 큐</h3><div id="postList"></div></div>'+
  '</div>';
  composePreview();
  $('cpCaption').oninput=composePreview;$('cpTags').oninput=composePreview;
  $('cpThumbFile').onchange=function(){var f=this.files&&this.files[0];if(!f)return;var r=new FileReader(),field=this;_pendingNormal++;r.onload=function(){_pendingNormal--;if(field.isConnected){_cpThumb=r.result;markFormChanged();composePreview();}};r.onerror=function(){_pendingNormal--;alert('썸네일을 읽지 못했습니다.');};r.readAsDataURL(f);};
  $('cpSave').onclick=function(){return savePost().catch(function(e){return {state:'error',message:e.message};});};
  $('cpReset').onclick=async function(){await flushForms();renderCompose();await restoreForm('post','new');};
  renderPostList();postStart();
}
async function savePost(){
  var title=$('cpTitle').value.trim();
  if(!title){alert('내부 제목을 입력하세요.');return;}
  var id=editingPostId||uid('p'), prev=_postEditBase||{};if(!editingPostId)editingPostId=id;
  var vurl=$('cpVideo').value.trim().slice(0,500);
  if(vurl&&!/^https?:\/\//i.test(vurl)){alert('영상 링크는 http:// 또는 https:// 로 시작해야 합니다.');return;}
  var rec={title:title.slice(0,80),caption:$('cpCaption').value.slice(0,2200),hashtags:$('cpTags').value.slice(0,500),
    igOn:$('cpIg').checked,ytOn:$('cpYt').checked,thumbUrl:(_cpThumb||prev.thumbUrl||''),videoUrl:vurl,
    status:prev.status||'draft',createdAt:prev.createdAt||Date.now(),createdBy:(curUser&&curUser.email)||''};
  var btn=$('cpSave');btn.disabled=true;btn.textContent='저장 중…';
  var submittedId=editingPostId,submittedGeneration=_formGeneration,submittedVersion=_postFormVersion,submittedUid=curUser&&curUser.uid,submittedKey=formKey();
  async function done(){
    if(submittedUid!==(curUser&&curUser.uid))return {draftSaved:false,detached:true};
    postCache[id]=rec;
    var sameForm=composeView&&editingPostId===submittedId&&_postFormVersion===submittedVersion&&formKey()===submittedKey,draftSaved=true;
    if(sameForm){
      // The ACK advances only this opened record's CAS base. Later input is a separate draft.
      _postEditBase=GuidePublishing.clone(rec);
      try{
        if(_formGeneration===submittedGeneration){_formsDirty=false;delete _forms['post:'+submittedId];await idbSet(submittedKey,GuidePublishing.clone({scope:{uid:submittedUid,lane:ENV.editorId||_draftWriterId},forms:_forms}));}
        else{_formsDirty=true;await flushForms();}
      }catch(e){draftSaved=false;_formsDirty=true;alert('콘텐츠 저장은 확인했지만 추가 입력 보관에 실패했습니다: '+e.message);}
      if(btn.isConnected!==false){btn.disabled=false;btn.textContent=_formGeneration===submittedGeneration?'저장됨':'큐에 저장';}
    }else if(btn.isConnected){btn.disabled=false;btn.textContent='큐에 저장';}
    renderPostList();return {draftSaved:draftSaved};
  }
  if(DEMO){postDemoStore[id]=rec;postCache=postDemoStore;done();return;}
  _pendingNormal++;return normalRecordRef('posts/'+id,_postEditBase).set(rec).then(async function(){var local=await done();return Object.assign({id:id,saved:true},local);}).catch(function(e){alert('저장 실패: '+(e&&e.message||e));btn.disabled=false;btn.textContent='큐에 저장';throw e;}).finally(function(){_pendingNormal--;});
}
function renderPostList(){
  var el=$('postList');if(!el)return;
  var ids=Object.keys(postCache||{});
  if(!ids.length){el.innerHTML='<div class="status show info">아직 작성한 콘텐츠가 없습니다. 위에서 작성해 큐에 저장하세요.</div>';return;}
  ids.sort(function(a,b){return ((postCache[b]||{}).createdAt||0)-((postCache[a]||{}).createdAt||0);});
  var h='<table class="agtable"><tr><th></th><th>제목</th><th>대상</th><th>상태</th><th></th></tr>';
  ids.forEach(function(id){var p=postCache[id]||{},st=postStatus(p);var tgt=[];if(p.igOn)tgt.push('릴스');if(p.ytOn)tgt.push('숏츠');
    // 발행/처리중 글은 토글 미노출(편집기가 회신한 상태를 관리자가 되돌려 손상시키는 것 방지). 실패만 '다시 준비' 허용.
    var act='<button data-pedit="'+esc(id)+'">수정</button>';
    if(p.status==='published'){ if(p.videoUrl)act+='<a class="btn ghost sm" href="'+esc(p.videoUrl)+'" target="_blank" rel="noopener">결과</a>'; }
    else if(p.status==='claimed'){ /* 처리중: 토글 없음 */ }
    else if(p.status==='error'){ act+='<button data-ptoggle="'+esc(id)+'" data-to="ready">다시 준비</button>'; }
    else { act+='<button data-ptoggle="'+esc(id)+'" data-to="'+(p.status==='ready'?'draft':'ready')+'">'+(p.status==='ready'?'초안으로':'준비완료')+'</button>'; }
    act+='<button class="warn" data-pdel="'+esc(id)+'">삭제</button>';
    h+='<tr><td>'+(p.thumbUrl?'<img src="'+esc(p.thumbUrl)+'" style="width:46px;height:46px;object-fit:cover;border-radius:6px;">':'')+'</td>'+
      '<td><b>'+esc(p.title||'(제목없음)')+'</b><div style="font-size:.72rem;color:#8a93a0;">'+esc((p.caption||'').slice(0,40))+'</div>'+(p.status==='error'&&p.error?'<div style="font-size:.7rem;color:#c2410c;">실패: '+esc(String(p.error).slice(0,60))+'</div>':'')+'</td>'+
      '<td>'+esc(tgt.join(', ')||'-')+'</td>'+
      '<td><span class="agchip '+st[1]+'">'+st[0]+'</span></td>'+
      '<td><div class="agact">'+act+'</div></td></tr>';
  });
  h+='</table>';el.innerHTML=h;
  el.querySelectorAll('[data-pedit]').forEach(function(b){b.onclick=function(){selectContext({view:'posts',postId:b.dataset.pedit}).catch(e=>alert(e.message));};});
  el.querySelectorAll('[data-ptoggle]').forEach(function(b){b.onclick=function(){var id=b.dataset.ptoggle,ns=b.dataset.to;if(DEMO){postDemoStore[id].status=ns;postRefreshUI();}else normalRecordRef('posts/'+id,{...postCache[id]}).set({...postCache[id],status:ns}).catch(function(e){alert('실패: '+(e&&e.message||e));});};});
  el.querySelectorAll('[data-pdel]').forEach(function(b){b.onclick=function(){var id=b.dataset.pdel;if(!confirm('이 콘텐츠를 삭제할까요?'))return;if(DEMO){delete postDemoStore[id];postRefreshUI();}else normalRecordRef('posts/'+id,postCache[id]).remove().catch(function(e){alert('실패: '+(e&&e.message||e));});};});
}
function loadPost(id){
  var p=postCache[id];if(!p)throw new Error('선택한 콘텐츠를 찾지 못했습니다.');
  renderCompose();
  editingPostId=id;_postEditBase=GuidePublishing.clone(p);_cpThumb=p.thumbUrl||'';if(ENV.contextChanged)ENV.contextChanged({view:'posts',postId:id,categoryId:null,itemId:null,agreementId:null});
  $('cpHead').textContent='콘텐츠 수정';
  $('cpTitle').value=p.title||'';$('cpCaption').value=p.caption||'';$('cpTags').value=p.hashtags||'';
  $('cpIg').checked=!!p.igOn;$('cpYt').checked=!!p.ytOn;$('cpVideo').value=p.videoUrl||'';
  composePreview();
}
$('composeNav').onclick=function(){renderCompose();};

/* ===== 대시보드 (현황) — 우리 데이터(Firebase)로 즉시. GA는 루커 임베드 자리 예약. ===== */
function dashSiteStats(){
  var cats=asArray(data.categories),reports=0,deployed=0,cardnews=0,revealed=0,blurred=0;
  cats.forEach(function(c){asArray(c.items).forEach(function(it){
    if(it.type==='page'){cardnews++;return;}
    reports++;var cards=asArray(it.cards);if(cards.length)deployed++;
    cards.forEach(function(cd){if(cd.revealed)revealed++;else blurred++;});
  });});
  return {reports:reports,deployed:deployed,cardnews:cardnews,revealed:revealed,blurred:blurred};
}
function dashAgreeStats(){
  var ids=Object.keys(agCache||{}),sent=ids.length,opened=0,completed=0,expired=0,revoked=0;
  ids.forEach(function(id){var r=agCache[id]||{},d=r.doc||{};
    if(r.views||r.submission)opened++;
    if(r.submission){completed++;return;}
    if(d.revoked===true){revoked++;return;}
    if(d.expireAt&&Date.now()>d.expireAt){expired++;}
  });
  return {sent:sent,opened:opened,completed:completed,expired:expired,revoked:revoked,conv:(sent?Math.round(completed/sent*100):0)};
}
function dashRender(){
  $('crumb').innerHTML='<span>대시보드</span><span class="sep">›</span><span class="cur">현황</span>';
  var s=dashSiteStats(),a=dashAgreeStats();
  function st(lbl,num,suf){return '<div class="dstat"><div class="lbl">'+lbl+'</div><div class="num">'+num+(suf?'<small> '+suf+'</small>':'')+'</div></div>';}
  function bar(label,val,max){var pct=max?Math.round(val/max*100):0;return '<div class="dfrow"><span class="fl">'+label+'</span><span class="fb"><span style="width:'+pct+'%"></span></span><span class="fv">'+val+'건 ('+pct+'%)</span></div>';}
  var h='<div class="agwrap">';
  h+='<div class="agcard"><h3>종합</h3><div class="dgrid">'+
    st('배포 리포트',s.deployed,'/ '+s.reports+'개')+st('동의서 발송',a.sent,'건')+st('동의서 완료',a.completed,'건')+st('완료 전환율',a.conv,'%')+st('카드뉴스',s.cardnews,'개')+
    '</div></div>';
  h+='<div class="agcard"><h3>동의서 현황</h3><div class="dfunnel">'+
    bar('발송',a.sent,a.sent)+bar('열람',a.opened,a.sent)+bar('완료',a.completed,a.sent)+
    '</div><div class="dnote" style="margin-top:8px;">만료 '+a.expired+'건 · 무효 '+a.revoked+'건 · 전환율 '+a.conv+'% (발송 대비 완료)</div></div>';
  h+='<div class="agcard"><h3>배포 콘텐츠</h3><div class="dgrid">'+
    st('전체 리포트',s.reports,'개')+st('공개 카드',s.revealed,'장')+st('가림 카드',s.blurred,'장')+
    '</div></div>';
  h+='<div class="agcard"><h3>방문·유입 (Google Analytics)</h3>';
  if(LOOKER_EMBED&&ENV.authority!=='review'){h+='<iframe src="'+esc(LOOKER_EMBED)+'" title="방문·유입 분석" loading="lazy" referrerpolicy="no-referrer" style="width:100%;height:520px;border:0;border-radius:8px;"></iframe>';}
  else{h+='<div class="dnote">GA에 데이터가 쌓이고 있어요(측정ID 연결됨). 이 자리에 <b>루커(Looker) 대시보드</b>를 임베드하면 방문·유입·채널이 한 화면에 표시됩니다. 준비되면 루커 보고서의 \'퍼가기(embed) URL\'을 LOOKER_EMBED에 넣으면 됩니다.</div>'+
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><a class="btn ghost sm" href="https://analytics.google.com" target="_blank" rel="noopener">GA 실시간 열기</a><a class="btn ghost sm" href="https://lookerstudio.google.com" target="_blank" rel="noopener">루커 스튜디오 열기</a></div>';}
  h+='</div></div>';
  $('stage').innerHTML=h;
}
function renderDashboard(){setActiveView('dash');dashRender();agStart();}
$('dashNav').onclick=function(){renderDashboard();};

function renderAgreementAdmin(){
  setActiveView('agree');
  $('crumb').innerHTML='<span>동의서</span><span class="sep">›</span><span class="cur">창업 디렉팅 신청서</span>';
  $('stage').innerHTML='<div class="agwrap">'+
    '<div class="agcard"><h3>새 신청서 보내기</h3>'+
    '<div class="agform">'+
      '<div class="fg"><label>고객 이름 (내부 표시용)</label><input type="text" id="agName" placeholder="예: 김OO"></div>'+
      '<div class="fg"><label>연락처 (선택)</label><input type="text" id="agPhone" placeholder="010-0000-0000"></div>'+
      '<div class="fg"><label>메모 (선택)</label><input type="text" id="agMemo" placeholder="예: 인스타 DM 문의"></div>'+
      '<button class="btn deploy sm" id="agCreate" style="height:38px;">신청서 링크 만들기</button>'+
    '</div>'+
    '<div class="aglink" id="agLinkBox"><code id="agLinkUrl"></code><button class="btn ghost sm" id="agLinkCopy">링크 복사</button></div>'+
    '<div style="margin-top:10px;font-size:.74rem;color:#8a93a0;line-height:1.6;">링크 유효기간 7일 · 같은 링크는 1회만 제출됩니다. 만든 링크를 카카오톡·문자·이메일로 직접 보내세요.<br>문서 버전: '+esc((window.AGREEMENT_TEMPLATE_V1||{}).version||'')+' · 미리보기: <a href="'+esc(location.origin)+'/agree/#demo" target="_blank" rel="noopener">고객 화면 데모 열기</a></div>'+
    '</div>'+
    '<div class="agcard"><h3 style="display:flex;justify-content:space-between;align-items:center;">신청 현황 <button class="btn ghost sm" id="agExport">전체 내보내기 (JSON)</button></h3><div id="agList"></div></div>'+
  '</div>';
  $('agCreate').onclick=async function(){
    if(ENV.authority==='native'&&ENV.strict&&!ENV.publicBase){alert('기존 동의서의 공개 주소 연결이 필요합니다. 입력을 유지했습니다.');return;}
    var nm=$('agName').value.trim();
    if(!nm){alert('고객 이름을 입력하세요. (내부 표시용입니다)');return;}
    var self=this;self.disabled=true;self.textContent='만드는 중…';
    var body=window.AGREEMENT_TEMPLATE_V1;
    if(!body){alert('신청서 본문 템플릿을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');self.disabled=false;self.textContent='신청서 링크 만들기';return;}
    var id=aid(),now=Date.now();
    var submittedFields={name:nm,phone:$('agPhone').value,memo:$('agMemo').value},submittedFormGeneration=_formGeneration;_pendingNormal++;
    return sha256Hex(JSON.stringify(body)).then(function(hash){
      var rec={doc:{title:body.title,version:body.version,body:body,bodyHash:hash,createdAt:now,expireAt:now+7*864e5},
               private:{customerName:nm.slice(0,40),customerPhone:submittedFields.phone.trim().slice(0,20),memo:submittedFields.memo.trim().slice(0,200),createdBy:(curUser&&curUser.email)||'',sentAt:now}};
      function done(){
        if(ENV.authority==='review'){agCache[id]=rec;self.disabled=false;self.textContent='검토안 저장됨';renderAgreeList();return;}
        var url=AGREE_BASE+id;
        $('agLinkUrl').textContent=url;$('agLinkBox').classList.add('show');
        $('agLinkCopy').onclick=function(){agCopy(url,this);};
        if(_formGeneration===submittedFormGeneration&&self.isConnected){$('agName').value='';$('agPhone').value='';$('agMemo').value='';_formsDirty=false;}
        self.disabled=false;self.textContent='신청서 링크 만들기';
        agRefreshUI();if($('agList'))renderAgreeList();
      }
      if(DEMO){agDemoStore[id]=rec;agCache=agDemoStore;done();return;}
      return normalRecordRef('agreements/'+id,null).set(rec).then(done).catch(function(e){alert('만들지 못했습니다: '+(e&&e.message||e));self.disabled=false;self.textContent='신청서 링크 만들기';throw e;});
    }).finally(function(){_pendingNormal--;ENV.changed?.();});
  };
  if(ENV.authority==='review'){$('agCreate').textContent='서류 검토안 저장';$('agLinkBox').remove();}
  $('agExport').onclick=function(){
    var blob=new Blob([JSON.stringify(agCache||{},null,2)],{type:'application/json'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='beancraft-agreements-'+fmtDate(new Date())+'.json';a.click();
  };
  renderAgreeList();agStart();
}
function renderAgreeList(){
  var el=$('agList');if(!el)return;
  var ids=Object.keys(agCache||{});
  if(!ids.length){el.innerHTML='<div class="status show info">아직 보낸 신청서가 없습니다. 위에서 링크를 만들어 보내세요.</div>';return;}
  ids.sort(function(a,b){return (((agCache[b]||{}).doc||{}).createdAt||0)-(((agCache[a]||{}).doc||{}).createdAt||0);});
  var h='<table class="agtable"><tr><th>고객</th><th>상태</th><th>보낸 날</th><th>열람</th><th>제출 시각</th><th></th></tr>';
  ids.forEach(function(id){
    var r=agCache[id]||{},st=agStatus(r),pv=(r.private||{}),views=r.views?Object.keys(r.views).length:0;
    var nm=r.archive?'(개인정보 파기됨)':(pv.customerName||'(이름 없음)');
    var subAt=r.submission?r.submission.submittedAt:(r.archive?r.archive.submittedAt:0);
    h+='<tr><td><b>'+esc(nm)+'</b>'+(pv.memo?'<div style="font-size:.72rem;color:#8a93a0;">'+esc(pv.memo)+'</div>':'')+'</td>'+
      '<td><span class="agchip '+st[1]+'">'+st[0]+'</span></td>'+
      '<td>'+esc(agFmt((r.doc||{}).createdAt))+'</td>'+
      '<td>'+(views?views+'회':'-')+'</td>'+
      '<td>'+esc(subAt?agFmt(subAt):'-')+'</td>'+
      '<td><div class="agact">'+
        '<button data-agcopy="'+esc(id)+'">링크 복사</button>'+
        '<button data-agdetail="'+esc(id)+'">상세</button>'+
        ((r.submission&&!r.archive)?'<button data-agpurge="'+esc(id)+'">개인정보 파기</button>':'')+
        '<button data-agrevoke="'+esc(id)+'">'+(((r.doc||{}).revoked===true)?'복구':'무효화')+'</button>'+
        '<button class="warn" data-agdel="'+esc(id)+'">삭제</button>'+
      '</div></td></tr>';
  });
  h+='</table>';
  el.innerHTML=h;
  if(ENV.authority==='review'){el.querySelectorAll('[data-agcopy],[data-agrevoke],[data-agpurge]').forEach(b=>{b.disabled=true;b.title='실제 계정에서 실행하는 업무입니다.';});}
  el.querySelectorAll('[data-agcopy]').forEach(function(b){b.onclick=function(){agCopy(AGREE_BASE+b.dataset.agcopy,b);};});
  el.querySelectorAll('[data-agdetail]').forEach(function(b){b.onclick=function(){selectContext({view:'agreement',agreementId:b.dataset.agdetail}).catch(e=>alert(e.message));};});
  el.querySelectorAll('[data-agrevoke]').forEach(function(b){b.onclick=function(){
    var id=b.dataset.agrevoke,r=agCache[id]||{},rv=((r.doc||{}).revoked===true);
    if(!confirm(rv?'이 링크를 다시 사용할 수 있게 복구할까요?':'이 링크를 무효화할까요? 고객이 더 이상 제출할 수 없게 됩니다.'))return;
    if(DEMO){agDemoStore[id].doc.revoked=rv?null:true;agRefreshUI();renderAgreeList();return;}
    normalRecordRef('agreements/'+id,r).set({...r,doc:{...r.doc,revoked:rv?null:true}}).catch(function(e){alert('실패: '+(e&&e.message||e));});
  };});
  el.querySelectorAll('[data-agdel]').forEach(function(b){b.onclick=function(){
    var id=b.dataset.agdel,r=agCache[id]||{};
    var warn=r.submission?'이 신청서에는 고객 제출 기록(법적 증빙)이 있습니다!\n삭제하면 되돌릴 수 없습니다. 삭제 전 [전체 내보내기]로 백업하세요.\n\n정말 삭제할까요?':'이 신청서를 삭제할까요?';
    if(!confirm(warn))return;
    if(r.submission&&!confirm('마지막 확인: 제출 기록까지 영구 삭제됩니다. 진행할까요?'))return;
    if(DEMO){delete agDemoStore[id];agRefreshUI();renderAgreeList();return;}
    normalRecordRef('agreements/'+id,r).remove().catch(function(e){alert('실패: '+(e&&e.message||e));});
  };});
  el.querySelectorAll('[data-agpurge]').forEach(function(b){b.onclick=function(){purgeAgreementPII(b.dataset.agpurge);};});
}
/* 개인정보 파기: 이름·연락처·서명 등 PII 노드를 영구 제거하고, 동의 사실 증빙만 익명으로 보존.
   (규칙상 submission 필드만 비우면 .validate에 막히므로 노드 통째 제거 + archive 별도 기록 + 링크 무효화) */
function purgeAgreementPII(id){
  if(ENV.authority==='review')throw new Error('검토 자료에서 실제 개인정보 파기는 실행하지 않습니다.');
  var r=agCache[id]||{};
  if(r.archive){alert('이미 개인정보가 파기된 신청서입니다.');return;}
  if(!r.submission){alert('아직 고객 제출 전이라 파기할 개인정보가 없습니다. 필요하면 [삭제]를 사용하세요.');return;}
  if(!confirm('이 신청서의 개인정보(이름·연락처·서명·기기/IP·희망조건·메모)를 영구 파기합니다.\n동의 사실 증빙(문서 버전·해시·제출 시각·동의 항목 수)은 익명으로 보존됩니다.\n\n파기 전 [상세 → 이 건 JSON 내보내기]로 원본을 백업하세요. 되돌릴 수 없습니다.\n\n계속할까요?'))return;
  if(!confirm('마지막 확인: 개인정보를 영구 파기합니다. 진행할까요?'))return;
  var s=r.submission||{},d=r.doc||{};
  var archive={purgedAt:Date.now(),by:((curUser&&curUser.email)||''),version:d.version||'',bodyHash:d.bodyHash||'',submittedAt:s.submittedAt||null,consentCount:Object.keys(s.agreed||{}).filter(function(k){return k!=='final';}).length,finalAgreed:!!(s.agreed&&s.agreed.final),serviceCount:Object.keys(s.services||{}).length};
  if(DEMO){var rec=agDemoStore[id]||{};delete rec.private;delete rec.submission;rec.archive=archive;if(rec.doc)rec.doc.revoked=true;agDemoStore[id]=rec;agCache=agDemoStore;agRefreshUI();renderAgreeList();alert('(데모) 개인정보 파기 완료 — 증빙만 익명 보존');return;}
  // 원자적 multi-path 업데이트: 증빙 기록 + PII 제거 + 링크 무효화를 한 번에 (중간 실패 시 PII 잔존 방지)
  var updates={};
  updates['agreements/'+id+'/archive']=archive;
  updates['agreements/'+id+'/submission']=null;
  updates['agreements/'+id+'/private']=null;
  updates['agreements/'+id+'/doc/revoked']=true;
  var purged=GuidePublishing.clone(r);delete purged.private;delete purged.submission;purged.archive=archive;purged.doc=Object.assign({},purged.doc,{revoked:true});
  normalRecordRef('agreements/'+id,r).set(purged)
    .then(function(){alert('개인정보를 파기했습니다. 동의 증빙은 익명으로 남았습니다.');})
    .catch(function(e){alert('파기 실패: '+(e&&e.message||e));});
}
function renderAgreeDetail(id){
  var r=agCache[id];if(!r)throw new Error('선택한 서류를 찾지 못했습니다.');ENV.contextChanged?.({view:'agreement',agreementId:id,categoryId:null,itemId:null,postId:null});
  var pv=r.private||{},d=r.doc||{},s=r.submission||null,st=agStatus(r);
  var body=d.body||{},svcMap={};(body.services||[]).forEach(function(x){svcMap[x.key]=x.name;});
  var conMap={};(body.consents||[]).forEach(function(x){conMap[x.key]=x.tag;});
  var h='<div class="agwrap"><div class="agcard agdet" style="max-width:700px;">';
  h+='<h3 style="display:flex;justify-content:space-between;align-items:center;"><span>'+esc(pv.customerName||'(이름 없음)')+' <span class="agchip '+st[1]+'">'+st[0]+'</span></span><button class="btn ghost sm" id="agBack">← 목록</button></h3>';
  h+='<div class="r"><span class="k">링크</span><span class="v" style="font-weight:400;font-size:.78rem;">'+esc(AGREE_BASE+id)+' <button class="btn ghost sm" id="agDetCopy" style="padding:2px 9px;font-size:.72rem;">복사</button></span></div>';
  h+='<div class="r"><span class="k">보낸 날</span><span class="v">'+esc(agFmt(d.createdAt))+' (유효기간 '+esc(agFmt(d.expireAt))+'까지)</span></div>';
  h+='<div class="r"><span class="k">문서 버전</span><span class="v">'+esc(d.version||'-')+(d.bodyHash?' · 해시 '+esc(String(d.bodyHash).slice(0,16))+'…':'')+'</span></div>';
  h+='<div class="r"><span class="k">내부 메모</span><span class="v">'+esc(pv.memo||'-')+' · 등록: '+esc(pv.createdBy||'-')+'</span></div>';
  var views=r.views?Object.keys(r.views).map(function(k){return r.views[k];}).sort(function(a,b){return (a.at||0)-(b.at||0);}):[];
  h+='<div class="r"><span class="k">열람 기록</span><span class="v">'+(views.length?views.map(function(v,i){return (i+1)+'차 '+agFmt(v.at);}).join(' · '):'아직 열람 전')+'</span></div>';
  if(s){
    h+='<div style="margin:14px 0 6px;font-weight:800;color:#1a365d;font-size:.92rem;">고객 제출 내용</div>';
    h+='<div class="r"><span class="k">신청인</span><span class="v">'+esc(s.name||'-')+' / '+esc(s.phone||'-')+'</span></div>';
    h+='<div class="r"><span class="k">제출 시각</span><span class="v">'+esc(agFmt(s.submittedAt))+' (서버 기록·위변조 불가)</span></div>';
    var w=s.wishes||{};
    h+='<div class="r"><span class="k">희망 조건</span><span class="v">지역 '+esc(w.region||'-')+' · 보증금 '+esc(w.deposit||'-')+' · 월세 '+esc(w.rent||'-')+' · 권리금 '+esc(w.premium||'-')+' · '+esc(w.size||'-')+'평 · 기타 '+esc(w.etc||'-')+'</span></div>';
    var svcs=Object.keys(s.services||{}).map(function(k){return svcMap[k]||k;});
    h+='<div class="r"><span class="k">선택 서비스</span><span class="v">'+esc(svcs.join(', ')||'-')+'</span></div>';
    var cons=Object.keys(s.agreed||{}).filter(function(k){return k!=='final';}).map(function(k){return conMap[k]||k;});
    h+='<div class="r"><span class="k">동의 항목</span><span class="v">'+cons.length+'개 전체 동의 + 최종 동의</span></div>';
    h+='<div class="r"><span class="k">서명</span><span class="v">'+(s.signatureType==='drawn'&&/^data:image/.test(s.signatureData||'')?'<img class="sig" src="'+s.signatureData+'" alt="서명">':'이름 서명: '+esc(s.signatureData||'-'))+'</span></div>';
    h+='<div class="r"><span class="k">참고 정보</span><span class="v" style="font-weight:400;font-size:.76rem;">기기 '+esc((s.device||'').slice(0,90))+(s.clientIp?' · IP(자기보고) '+esc(s.clientIp):'')+(s.viewedForMs?' · 열람~제출 '+Math.round(s.viewedForMs/1000)+'초':'')+'</span></div>';
    h+='<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn deploy sm" id="agPrint">인쇄용 보기 (PDF 저장)</button><button class="btn ghost sm" id="agOneExport">이 건 JSON 내보내기</button></div>';
  }else if(r.archive){
    var ar=r.archive;
    h+='<div style="margin:14px 0 6px;font-weight:800;color:#b45309;font-size:.92rem;">개인정보 파기됨</div>';
    h+='<div class="status show info" style="margin-top:4px;">고객 개인정보(이름·연락처·서명 등)는 영구 파기되었고, 아래 동의 증빙만 익명으로 보존됩니다.</div>';
    h+='<div class="r"><span class="k">제출 시각</span><span class="v">'+esc(agFmt(ar.submittedAt))+' (서버 기록)</span></div>';
    h+='<div class="r"><span class="k">동의 항목</span><span class="v">'+(ar.consentCount||0)+'개'+(ar.finalAgreed?' + 최종 동의':'')+(ar.serviceCount?' · 선택 서비스 '+ar.serviceCount+'개':'')+'</span></div>';
    h+='<div class="r"><span class="k">문서 버전</span><span class="v">'+esc(ar.version||'-')+(ar.bodyHash?' · 해시 '+esc(String(ar.bodyHash).slice(0,16))+'…':'')+'</span></div>';
    h+='<div class="r"><span class="k">파기 시각</span><span class="v">'+esc(agFmt(ar.purgedAt))+(ar.by?' · '+esc(ar.by):'')+'</span></div>';
  }else{
    h+='<div class="status show info" style="margin-top:12px;">아직 제출 전입니다.</div>';
  }
  h+='</div></div>';
  $('stage').innerHTML=h;
  $('agBack').onclick=function(){renderAgreementAdmin();};
  var dc=$('agDetCopy');if(dc)dc.onclick=function(){agCopy(AGREE_BASE+id,this);};
  var oe=$('agOneExport');if(oe)oe.onclick=function(){var blob=new Blob([JSON.stringify(r,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='agreement-'+id.slice(0,8)+'.json';a.click();};
  if(ENV.authority==='review'){$('agDetCopy')?.setAttribute('disabled','');$('agPrint')?.setAttribute('disabled','');}
  var pr=$('agPrint');if(pr)pr.onclick=function(){openAgreePrint(id,r);};
}
function openAgreePrint(id,r){
  var pv=r.private||{},d=r.doc||{},s=r.submission||{},body=d.body||{};
  var svcMap={};(body.services||[]).forEach(function(x){svcMap[x.key]=x.name+' ('+x.price+')';});
  var svcs=Object.keys(s.services||{}).map(function(k){return svcMap[k]||k;});
  var w=s.wishes||{};
  var h='<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>'+esc(d.title||'신청서')+'</title>'+
    '<style>body{font-family:"Pretendard","Apple SD Gothic Neo",sans-serif;color:#111;max-width:680px;margin:0 auto;padding:32px 24px;font-size:13px;line-height:1.7;}'+
    'h1{font-size:20px;color:#1a365d;}h2{font-size:14px;color:#1a365d;margin:18px 0 6px;border-bottom:1.5px solid #1a365d;padding-bottom:4px;}'+
    'table{width:100%;border-collapse:collapse;}td{padding:5px 8px;border:1px solid #ddd;}td.k{background:#f4f7fb;width:130px;color:#3b4a5e;font-weight:700;}'+
    '.con{margin:7px 0;}.con b{color:#1a365d;}.sig img{max-width:240px;border:1px solid #ddd;}'+
    '.ft{margin-top:26px;font-size:11px;color:#8a93a0;text-align:center;}</style></head><body>'+
    '<h1>'+esc(d.title||'')+'</h1><div style="font-size:11px;color:#67768a;">'+esc(body.brand||'')+' · 문서 버전 '+esc(d.version||'')+(d.bodyHash?' · 본문 해시 '+esc(String(d.bodyHash).slice(0,24))+'…':'')+'</div>'+
    '<h2>제출 정보</h2><table>'+
    '<tr><td class="k">신청인</td><td>'+esc(s.name||'-')+'</td></tr>'+
    '<tr><td class="k">연락처</td><td>'+esc(s.phone||'-')+'</td></tr>'+
    '<tr><td class="k">제출 시각 (서버 기록)</td><td>'+esc(agFmt(s.submittedAt))+'</td></tr>'+
    '<tr><td class="k">선택 서비스</td><td>'+esc(svcs.join(', ')||'-')+'</td></tr>'+
    '<tr><td class="k">희망 조건</td><td>지역 '+esc(w.region||'-')+' / 보증금 '+esc(w.deposit||'-')+' / 월세 '+esc(w.rent||'-')+' / 권리금 '+esc(w.premium||'-')+' / '+esc(w.size||'-')+'평 / '+esc(w.etc||'-')+'</td></tr>'+
    '<tr><td class="k">기기·참고 정보</td><td style="font-size:11px;">'+esc((s.device||'').slice(0,120))+(s.clientIp?' / IP(자기보고) '+esc(s.clientIp):'')+'</td></tr>'+
    '</table>'+
    '<h2>동의한 내용 (제출 시점 원문)</h2>'+
    (body.consents||[]).map(function(c){return '<div class="con"><b>['+esc(c.tag)+']</b> 동의함<br><span style="font-size:11.5px;color:#374357;">'+esc(c.text)+'</span></div>';}).join('')+
    '<div class="con"><b>최종 동의</b> '+esc(body.finalCheck||'')+' — 동의함</div>'+
    '<h2>서명</h2><div class="sig">'+(s.signatureType==='drawn'&&/^data:image/.test(s.signatureData||'')?'<img src="'+s.signatureData+'" alt="서명">':'이름 서명: <b>'+esc(s.signatureData||'-')+'</b>')+'</div>'+
    '<div class="ft">© 2026 BEANCRAFT · 본 문서는 전자적으로 제출된 신청 기록입니다.</div>'+
    '<script>window.print();<\/script></body></html>';
  var u=URL.createObjectURL(new Blob([h],{type:'text/html;charset=utf-8'}));
  window.open(u,'_blank');
}
$('agreeNav').onclick=function(){renderAgreementAdmin();};

/* ===== 레퍼런스·자료 — 외부 모듈 연동 자리(스텁). 다른 방에서 받은 코드를 여기에 연결 ===== */
function stubHtml(title,desc,note,node){
  return '<div class="agwrap"><div class="agcard"><h3>'+esc(title)+'</h3>'+
    '<p class="dnote" style="margin:6px 0 12px;">'+esc(desc)+'</p>'+
    '<div class="status show info">'+esc(note)+'</div>'+
    '<div class="dnote" style="margin-top:10px;">연동 위치(Firebase): <code>'+esc(node)+'</code></div></div></div>';
}
function renderReference(){
  setActiveView('reference');
  $('crumb').innerHTML='<span>레퍼런스</span><span class="sep">›</span><span class="cur">사례집</span>';
  $('stage').innerHTML=stubHtml('레퍼런스 사례집','디렉터·인테리어 등 사례를 모아 고객에게 보여주는 공간입니다.','이 기능은 별도로 제작 중이에요. 완성되면 받은 코드를 여기에 연결합니다. 데이터는 상권분석과 같은 공개 방식(워터마크/블러)을 그대로 재사용합니다.','marketing/references → marketing/published');
}
function renderAssets(){
  setActiveView('assets');
  $('crumb').innerHTML='<span>자료</span><span class="sep">›</span><span class="cur">에셋 라이브러리</span>';
  $('stage').innerHTML=stubHtml('자료 에셋 라이브러리','AI로 재해석한 저작권-안전 이미지·영상을 모아 숏츠·리포트에서 재사용합니다.','이 기능은 별도로 제작 중이에요. 완성되면 받은 코드를 여기에 연결합니다. 파일은 Storage, 목록은 RTDB에 저장하는 규격으로 준비돼 있습니다.','marketing/assets (+ Storage marketing/assets/)');
}
$('refNav').onclick=function(){renderReference();};
$('assetNav').onclick=function(){renderAssets();};


function readPostInput(prev){return {title:($('cpTitle')?.value||'').trim().slice(0,80),caption:($('cpCaption')?.value||'').slice(0,2200),hashtags:($('cpTags')?.value||'').slice(0,500),igOn:!!$('cpIg')?.checked,ytOn:!!$('cpYt')?.checked,thumbUrl:(_cpThumb||prev.thumbUrl||''),videoUrl:($('cpVideo')?.value||'').trim().slice(0,500),status:prev.status||'draft',createdAt:prev.createdAt||Date.now(),createdBy:(curUser&&curUser.email)||''};}

async function normalLocalWork(work){_pendingNormal++;ENV.changed?.();try{return await work();}finally{_pendingNormal--;ENV.changed?.();}}
function onAttach(it,files){return normalLocalWork(()=>_onAttach(it,files));}
function onAttachSingle(it,files){return normalLocalWork(()=>_onAttachSingle(it,files));}
function detectTitles(it){return normalLocalWork(()=>_detectTitles(it));}

var _formsDirty=false,_formGeneration=0,_pendingNormal=0;
function formKey(){return editorFormKey(curUser&&curUser.uid||'review',ENV.editorId||_draftWriterId);}
function formSnapshot(){
 const ids=composeView?['cpTitle','cpCaption','cpTags','cpIg','cpYt','cpVideo']:agView&&$('agName')?['agName','agPhone','agMemo']:[];
 if(!ids.length)return null;const fields={};ids.forEach(id=>{const el=$(id);if(el)fields[id]=el.type==='checkbox'?el.checked:el.value;});return{kind:composeView?'post':'agreement',id:composeView?editingPostId||'new':'new',fields,thumb:composeView?_cpThumb:'',base:composeView?GuidePublishing.clone(_postEditBase):null};
}
var _postEditBase=null,_postFormVersion=0,_forms={};
function markFormChanged(){if(formSnapshot()){_formsDirty=true;_formGeneration++;ENV.changed?.();}}
async function flushForms(){for(let attempt=0;attempt<8;attempt++){const snap=formSnapshot(),generation=_formGeneration;if(!snap||!_formsDirty)return;_forms[snap.kind+':'+snap.id]=snap;await idbSet(formKey(),{scope:{uid:curUser&&curUser.uid,lane:ENV.editorId||_draftWriterId},forms:_forms});if(generation===_formGeneration){_formsDirty=false;return;}}throw Error('입력이 계속 변경되어 현재 편집 화면을 유지했습니다.');}
async function restoreForm(kind,id){const record=await idbGet(formKey());_forms=record?.forms||{};const saved=_forms[kind+':'+(id||'new')];if(!saved)return;for(const[key,value]of Object.entries(saved.fields||{})){const el=$(key);if(el){if(el.type==='checkbox')el.checked=value;else el.value=value;}}if(kind==='post'){_cpThumb=saved.thumb||'';_postEditBase=saved.base;composePreview();}_formsDirty=true;}
function normalRecordRef(path,base){return ENV.runtime.recordRef?ENV.runtime.recordRef(path,base):fbDb.ref(path);}
async function saveReviewTeam(){if(_publishIntent)throw Error('이전 배포의 결과를 먼저 확인해 주세요.');const capture=captureGuideDraft();if(!capture.base.known)throw Error('현재 자료와 초안을 먼저 비교해 주세요.');_pendingNormal++;try{await ENV.reviewRepository.saveTeam(capture.data,capture.base.team);_guideBase={known:true,team:GuidePublishing.clone(capture.data),state:GuidePublishing.clone(capture.base.state)};if(await clearSubmittedGuideDraft(capture))setDirty(false);$('loginState').textContent='검토 자료 저장됨 · 실제 고객 화면에는 게시하지 않았습니다.';return{state:'review-saved'};}catch(e){alert('저장되지 않았습니다: '+e.message);throw e;}finally{_pendingNormal--;ENV.changed?.();}}
async function selectContext(context={view:'items'}){
 if(_pendingNormal||guidePublisher.busy())throw Error('현재 실행 결과를 확인한 뒤 이동해 주세요.');
 await flushForms();if(!context||!['items','item','posts','agreements','agreement','dashboard','reference','assets'].includes(context.view))throw Error('지원하지 않는 GUIDE 업무입니다.');
 if(context.view==='item'){if(!context.categoryId||!context.itemId||context.postId||context.agreementId)throw Error('카테고리·항목 ID를 각각 지정해 주세요.');await selectItem(context.categoryId,context.itemId);}
 else if(context.view==='posts'){if(context.itemId||context.categoryId||context.agreementId)throw Error('콘텐츠 ID와 항목 ID는 다른 업무입니다.');if(context.postId)loadPost(context.postId);else renderCompose();await restoreForm('post',context.postId);}
 else if(context.view==='agreement'){if(!context.agreementId||context.postId||context.itemId||context.categoryId)throw Error('서류 ID를 지정해 주세요.');if(!agCache[context.agreementId])throw Error('선택한 서류를 찾지 못했습니다.');renderAgreeDetail(context.agreementId);}
 else if(context.view==='agreements'){renderAgreementAdmin();await restoreForm('agreement','new');}
 else if(context.view==='dashboard')renderDashboard();else if(context.view==='reference')renderReference();else if(context.view==='assets')renderAssets();
 else{setActiveView(null);$('stage').innerHTML='<div class="agwrap"><div class="agcard"><h3>작업할 고객페이지</h3><p>작업 대상 선택·관리를 펼쳐 기존 항목을 선택하거나 새 항목을 만드세요.</p></div></div>';}
 ENV.contextChanged?.(context);await showRecoverableDrafts();return context;
}
async function compareLegacyForm(row,kind,id){
 if(_pendingNormal||_publishIntent||guidePublisher.busy())throw Error('진행 중인 작업을 먼저 확인해 주세요.');
 const current=formSnapshot(),saved=row?.value?.forms?.[kind+':'+id];
 if(!current||current.kind!==kind||current.id!==id||!saved||saved.kind!==kind||saved.id!==id)throw Error('이전 입력의 업무 대상과 현재 화면을 확인해 주세요.');
 const capture={uid:curUser&&curUser.uid,key:formKey(),generation:_formGeneration,version:_postFormVersion,snapshot:GuidePublishing.clone(current)};
 const box=$('guideCompare');box.replaceChildren();const h=document.createElement('h3');h.textContent='이전 형식 입력 비교';box.appendChild(h);
 const note=document.createElement('p');note.textContent='이전 키는 UID와 편집기 경계가 모호합니다. 작성 주체와 업무 대상을 직접 확인하세요. 원래 기록과 소유권 기록은 보존하고, 선택한 입력만 현재 편집기의 새 저장칸에 보관합니다. 원장 기준 판본을 최신값으로 바꾸지 않습니다.';box.appendChild(note);
 const pre=document.createElement('pre');pre.textContent=JSON.stringify({legacyKey:row.key,ownership:'unverified legacy scope',current:current,legacy:saved},null,2);box.appendChild(pre);
 const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';label.append(check,document.createTextNode('이전 입력의 작성 주체와 대상을 확인했습니다.'));box.appendChild(label);
 const apply=document.createElement('button');apply.textContent='새 편집기에서 복구';apply.disabled=true;check.onchange=()=>{apply.disabled=!check.checked;};box.appendChild(apply);const close=document.createElement('button');close.textContent='닫기';close.onclick=()=>box.close();box.appendChild(close);box.showModal();
 apply.onclick=async()=>{
  if(!check.checked)return {state:'review-required'};
  if(_pendingNormal||capture.uid!==(curUser&&curUser.uid)||capture.key!==formKey()||capture.generation!==_formGeneration||capture.version!==_postFormVersion||!GuidePublishing.equal(capture.snapshot,formSnapshot())){alert('현재 입력이나 편집기가 바뀌었습니다. 다시 비교해 주세요.');return {state:'retained'};}
  _pendingNormal++;apply.disabled=true;ENV.changed?.();
  try{
   for(const key of Object.keys(current.fields)){const el=$(key);if(!el||!Object.prototype.hasOwnProperty.call(saved.fields||{},key))continue;if(el.type==='checkbox')el.checked=!!saved.fields[key];else el.value=String(saved.fields[key]??'');}
   if(kind==='post'){
    _postEditBase=GuidePublishing.clone(saved.base??null);
    const thumb=typeof saved.thumb==='string'?saved.thumb:'';
    _cpThumb=/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(thumb)||/^https?:\/\/[^\s"'<>]+$/.test(thumb)?thumb:'';composePreview();
   }
   markFormChanged();await flushForms();if(capture.uid!==(curUser&&curUser.uid)||capture.key!==formKey()||capture.version!==_postFormVersion)return {state:'detached'};box.close();alert('이전 입력을 새 편집기에 보관했습니다. 원래 기록과 원장 자료는 변경하지 않았습니다.');return {state:'recovered'};
  }catch(error){alert('현재 입력을 유지했습니다. 새 초안 보관을 확인해 주세요: '+error.message);return {state:'retained'};}
  finally{_pendingNormal--;ENV.changed?.();}
 };
}

function detailedDifference(a,b,path='',out=[]){if(GuidePublishing.equal(a,b))return out;if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))detailedDifference(a[k],b[k],path+'/'+k,out);}else out.push({path:path||'/',draft:a===undefined?'(없음)':a,current:b===undefined?'(없음)':b});return out;}
async function showRecoverableDrafts(){const panel=$('guideRecovery');if(!panel)return;const rows=(await idbList('draft_')).filter(r=>r.key!==draftKey()&&r.value?.data&&(r.key===legacyDraftKey()||r.value.uid===curUser?.uid));panel.innerHTML='';if(!_guideBase.known){const current=document.createElement('button');current.textContent='현재 초안과 최신 자료 비교';current.onclick=()=>compareDraft({key:draftKey(),value:{data:serializeData(),base:_guideBase}}).catch(e=>alert(e.message));panel.appendChild(current);}for(const row of rows){const button=document.createElement('button');button.textContent=(row.key===legacyDraftKey()?'이전 공용 초안':'다른 편집기의 보관 초안')+' 비교';button.onclick=()=>compareDraft(row).catch(e=>alert(e.message));panel.appendChild(button);}const journals=await idbList('publish_');const owns=journals.filter(r=>r.value?.actor?.uid===curUser?.uid&&r.key!==('publish_'+draftKey()));if(owns.length){const info=document.createElement('p');info.textContent='이전 편집기의 미확인 배포 '+owns.length+'건을 보관 중입니다. 이전 작업 ID로 결과 조회가 가능하며 새 배포로 대체하지 않습니다.';panel.appendChild(info);for(const row of owns){const b=document.createElement('button');b.textContent='이전 작업 결과 조회 '+row.value.id;b.onclick=()=>inspectOldOperation(row.value);panel.appendChild(b);}}const form=formSnapshot();if(form){const oldKey=legacyFormKey(curUser&&curUser.uid||'review',ENV.editorId||_draftWriterId),oldRows=await idbList('forms_');const oldForm=oldRows.find(row=>row.key===oldKey&&row.value?.forms?.[form.kind+':'+form.id]);if(oldForm){const button=document.createElement('button');button.textContent='이전 형식 입력 비교 · 작성 주체 확인';button.onclick=()=>compareLegacyForm(oldForm,form.kind,form.id).catch(error=>alert(error.message));panel.appendChild(button);}}}
async function inspectOldOperation(intent){if(!intent.operation){alert('이전 작업은 배포 전 준비 단계입니다. 원래 초안과 작업 기록을 보관했습니다.');return;}try{const op=await GuidePublishing.resumeOperation(intent.operation);const s=await fbDb.ref('marketing').once('value');const result=await GuidePublishing.inspectOperation(s.val(),op);if(result.state!=='committed'){alert('현재 원장에서는 완료를 확인하지 못했습니다. 기존 기록을 유지했습니다.');return;}alert(result.recoveryState==='damaged'?'이전 배포 저장은 확인했지만 복구 기록이 손상되었습니다. 초안과 작업 기록을 유지했습니다.':'이전 작업의 저장 기록을 확인했습니다. 현재 초안·기준 판본과 이전 작업 기록은 변경하지 않았습니다.');}catch(e){alert('이전 결과 확인 필요: '+e.message);}}
function comparisonToken(){return {uid:curUser&&curUser.uid,email:curUser&&curUser.email,key:draftKey(),lane:ENV.editorId||_draftWriterId,writer:_draftWriterId,generation:_editGeneration,formGeneration:_formGeneration,base:GuidePublishing.clone(_guideBase),data:serializeData()};}
function sameComparisonEditor(token){return token.uid===(curUser&&curUser.uid)&&token.email===(curUser&&curUser.email)&&token.key===draftKey()&&token.lane===(ENV.editorId||_draftWriterId)&&token.writer===_draftWriterId;}
function assertComparisonCurrent(token,box){
 if(!sameComparisonEditor(token)||token.generation!==_editGeneration||token.formGeneration!==_formGeneration||!GuidePublishing.equal(token.data,serializeData())||!GuidePublishing.equal(token.base,_guideBase)||_pendingNormal!==1||_publishIntent||guidePublisher.busy()||(box&&!box.open))throw Error('비교 중 계정·편집기 또는 입력이 바뀌었습니다. 현재 입력을 유지하고 다시 비교해 주세요.');
}
async function retainCurrentComparisonDraft(token){
 for(var attempt=0;attempt<8;attempt++){
  if(!sameComparisonEditor(token))return false;
  clearTimeout(_saveTimer);_saveTimer=null;await _draftWrites;
  if(!sameComparisonEditor(token))return false;
  var capture=captureGuideDraft(),formGeneration=_formGeneration;
  await idbSet(capture.key,{savedAt:Date.now(),uid:capture.uid,editorId:token.lane,writerId:capture.writerId,generation:capture.generation,data:capture.data,base:capture.base});
  await flushForms();
  if(!sameComparisonEditor(token))return false;
  if(capture.generation===_editGeneration&&formGeneration===_formGeneration&&GuidePublishing.equal(capture.data,serializeData()))return true;
 }
 throw Error('추가 입력이 계속 변경되어 화면을 유지했습니다. 저장 상태를 다시 확인해 주세요.');
}
async function compareDraft(row){
 if(_publishIntent||guidePublisher.busy()||_pendingNormal)throw Error('진행 중이거나 미확인인 작업 결과를 먼저 확인해 주세요.');
 const token=comparisonToken();if(!token.uid)throw Error('현재 작업 계정을 확인해 주세요.');
 let snaps;_pendingNormal++;ENV.changed?.();
 try{snaps=await Promise.all([fbDb.ref(DATA_REF).once('value'),fbDb.ref('marketing/'+GuidePublishing.stateKey).once('value'),fbDb.ref(PUB_REF).once('value')]);assertComparisonCurrent(token);}finally{_pendingNormal--;ENV.changed?.();}
 const remote={team:snaps[0].val(),state:snaps[1].val(),published:snaps[2].val()},candidate=GuidePublishing.clone(row.value.data);normalizeData(candidate);migrateCategories(candidate);
 const ids=new Set(GuidePublishing.teamItems(candidate).map(it=>it.id));GuidePublishing.teamItems(remote.team).forEach(it=>ids.add(it.id));const ownPublic={};ids.forEach(id=>{ownPublic[id]=remote.published?.[id]??null;});
 const box=$('guideCompare');box.replaceChildren();const h=document.createElement('h3');h.textContent='초안 복구 비교';box.appendChild(h);const p=document.createElement('p');p.textContent='이전 초안은 그대로 보관합니다. 항목별 차이와 현재 공개본을 검토한 뒤 선택한 초안을 현재 편집기에 적용합니다. 게시·업로드는 실행하지 않습니다.';box.appendChild(p);
 const pre=document.createElement('pre');pre.textContent=JSON.stringify({changes:detailedDifference(candidate,remote.team),currentExactTeam:remote.team,currentOwnPublic:ownPublic,candidate},null,2);box.appendChild(pre);const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';label.append(check,document.createTextNode('차이와 현재 공개본을 검토했습니다.'));box.appendChild(label);const apply=document.createElement('button');apply.textContent='복구안 적용 · 새 기준 판본 기록';apply.disabled=true;check.onchange=()=>{apply.disabled=!check.checked;};box.appendChild(apply);const cancel=document.createElement('button');cancel.textContent='닫기';cancel.onclick=()=>box.close();box.appendChild(cancel);box.showModal();
 apply.onclick=async()=>{
  if(_pendingNormal){alert('진행 중인 작업을 먼저 확인해 주세요.');return;}
  apply.disabled=true;let persisted=false,applied=false;_pendingNormal++;ENV.changed?.();
  try{
   assertComparisonCurrent(token,box);
   const now=await Promise.all([fbDb.ref(DATA_REF).once('value'),fbDb.ref('marketing/'+GuidePublishing.stateKey).once('value'),fbDb.ref(PUB_REF).once('value')]);
   assertComparisonCurrent(token,box);
   if(!GuidePublishing.equal(remote.team,now[0].val())||!GuidePublishing.equal(remote.state,now[1].val())||!GuidePublishing.equal(remote.published,now[2].val()))throw Error('비교 중 원격 자료가 바뀌었습니다. 다시 비교해 주세요.');
   GuidePublishing.assertCurrentPublicOwnership({data:remote.team,published:remote.published,[GuidePublishing.stateKey]:remote.state},Array.from(ids));GuidePublishing.projection(candidate,false);
   const nextBase={known:true,team:GuidePublishing.clone(remote.team),state:GuidePublishing.clone(remote.state)};
   await idbSet(token.key,{savedAt:Date.now(),uid:token.uid,editorId:token.lane,writerId:token.writer,generation:token.generation+1,data:candidate,base:nextBase});persisted=true;
   assertComparisonCurrent(token,box);
   data=candidate;_guideBase=nextBase;setDirty(true);renderTree();box.close();applied=true;
  }catch(e){
   if(persisted){try{await retainCurrentComparisonDraft(token);}catch(storageError){alert('현재 입력은 화면에 유지했습니다. 추가 초안 보관을 확인해 주세요: '+storageError.message);}}
   alert('복구안을 적용하지 않았습니다: '+e.message);apply.disabled=!check.checked;
  }finally{_pendingNormal--;ENV.changed?.();}
  if(applied){await selectContext({view:'items'});return {state:'applied'};}return {state:'retained'};
 };
}


// NORMAL-CORE-END
return {async start(user){curUser=user;if(ENV.authority!=='review'&&!isAllowed(user))throw Error('원본 Studio 관리자 계정이 필요합니다.');afterLogin();await loadData();const initial=await Promise.all([fbDb.ref('posts').once('value'),fbDb.ref('agreements').once('value')]);postCache=initial[0].val()||{};agCache=initial[1].val()||{};agStart();postStart();return true;},selectContext,
 deployReview:saveReviewTeam,acceptReviewReconciliation(result){if(ENV.authority!=='review')throw Error('review only');for(const command of result.commands||[]){if(command.action==='post.save'&&editingPostId===command.id)_postEditBase=GuidePublishing.clone(command.value);if(command.action==='team.save')_guideBase={known:true,team:GuidePublishing.clone(command.value),state:GuidePublishing.clone(_guideBase.state)};}},markFormChanged,
 getState(){return {formsDirty:_formsDirty,normalPending:_pendingNormal,dirty,pendingUnknown:!!_publishIntent,publishing:guidePublisher.busy(),draftKey:draftKey(),editorId:ENV.editorId||_draftWriterId,context:sel?{view:'item',categoryId:sel.cat,itemId:sel.item}:ENV.currentContext(),generation:_editGeneration};},
 async flush(){if(guidePublisher.busy()||_pendingNormal)throw Error('실행 중인 작업의 결과를 먼저 확인해 주세요.');clearTimeout(_saveTimer);_saveTimer=null;await _draftWrites;for(var attempt=0;attempt<8;attempt++){const capture=captureGuideDraft();if(dirty)await idbSet(capture.key,{savedAt:Date.now(),uid:capture.uid,editorId:ENV.editorId||_draftWriterId,writerId:capture.writerId,generation:capture.generation,data:capture.data,base:capture.base});await flushForms();if(capture.generation===_editGeneration)return;}throw Error('저장 중 계속 입력이 변경되어 편집 화면을 유지했습니다.');},
 async stop(){await this.flush();if(_tess){await _tess.terminate();_tess=null;}},login,afterLogin};
}
