// 빈크래프트 마케팅 작업실 — 최소 서비스워커 (설치 가능 + 오프라인 셸)
var CACHE='bc-studio-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  // 네트워크 우선 (항상 최신), 실패 시 캐시
  e.respondWith(
    fetch(e.request).then(function(r){
      try{ if(e.request.method==='GET'&&r&&r.status===200&&e.request.url.indexOf('http')===0){var c=r.clone();caches.open(CACHE).then(function(ch){ch.put(e.request,c);});} }catch(_){}
      return r;
    }).catch(function(){ return caches.match(e.request); })
  );
});
