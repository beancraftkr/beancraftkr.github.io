// 빈크래프트 마케팅 — 항상 최신(네트워크 전용). 설치 가능 유지 + 캐시 미사용으로 옛 버전 고착 방지
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){return Promise.all(keys.map(function(k){return caches.delete(k);}));})
      .then(function(){return self.clients.claim();})
  );
});
self.addEventListener('fetch',function(e){
  // 항상 네트워크에서 받아옴 (오프라인일 때만 실패) → 항상 최신 코드
  e.respondWith(fetch(e.request));
});
