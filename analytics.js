/* BeanCraft 분석 — GA4 (고객 페이지 공용)
   사용법: GA4 측정 ID(G-XXXXXXXXXX) 발급 후 아래 GA_ID만 바꾸면 추적이 켜집니다.
   - 발급 전(placeholder)이면 추적은 자동으로 꺼져 있고, 페이지는 정상 동작합니다.
   - 민감정보 페이지(agree/ 동의서)에는 일부러 넣지 않습니다(개인정보 보호).
   - 이벤트 기록은 어디서든 bcTrack('이벤트명', {파라미터}) 로 호출. */
window.GA_ID = 'G-X8L7PKRQ5B';   // GA4 측정 ID (beancraft 속성)

/* 추적 헬퍼 — GA 미설정이어도 안전(아무것도 안 함) */
window.bcTrack = function(name, params){ try{ if(window.gtag) window.gtag('event', name, params || {}); }catch(e){} };

(function(){
  var id = window.GA_ID;
  if(!id || id.indexOf('G-') !== 0 || /X{4,}/.test(id)) return;   // placeholder(G-XXXX…)면 로드 안 함. 실제 ID(X 1개 포함 가능)는 통과
  var s = document.createElement('script'); s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function(){ window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id, { anonymize_ip: true });   // IP 익명화(개인정보)
})();
