const PRODUCTION_ORIGIN = 'https://beancraft-sales.netlify.app';
const WORKSPACE_ORIGIN = 'https://beancraft-work-803745881200.asia-northeast3.run.app';
const PUBLICATION_PATH = '/.netlify/functions/guide-publication';
const STUDIO_ORIGIN = 'https://beancraftkr.github.io';

function failure(code, message, state = 'blocked') {
  return Object.assign(new Error(message), {code, state});
}

function serviceUrl(location, endpoint) {
  const studio = new URL(location.origin);
  const hosted = studio.origin === WORKSPACE_ORIGIN || studio.origin === STUDIO_ORIGIN;
  const destination = new URL(endpoint || (hosted ? WORKSPACE_ORIGIN : PRODUCTION_ORIGIN) + PUBLICATION_PATH);
  const production = studio.origin === PRODUCTION_ORIGIN && destination.origin === PRODUCTION_ORIGIN;
  const workspace = hosted && destination.origin === WORKSPACE_ORIGIN;
  const fixture = studio.hostname === '127.0.0.1' && studio.protocol === 'http:' &&
    destination.origin === studio.origin;
  if (!(production || workspace || fixture) || destination.pathname !== PUBLICATION_PATH ||
    destination.username || destination.password || destination.search || destination.hash) {
    throw failure('publication_endpoint_invalid', '확인된 GUIDE 게시 서버 주소가 필요합니다. 초안을 유지했습니다.');
  }
  return destination.href;
}

export function createGuidePublicationClient({auth, location, endpoint, fetcher = (...args) => fetch(...args)}) {
  const target = serviceUrl(location, endpoint);
  async function submit(intent, uid) {
    const user = auth.currentUser;
    if (!uid || user?.uid !== uid || typeof user.getIdToken !== 'function') {
      throw failure('account_changed', '게시를 준비한 계정이 달라졌습니다. 초안을 유지했습니다.');
    }
    let token;
    try { token = await user.getIdToken(); }
    catch { throw failure('publication_auth_required', '기존 계정 인증을 확인하지 못했습니다. 초안을 유지했습니다.'); }
    if (!token || auth.currentUser?.uid !== uid) {
      throw failure('account_changed', '게시를 준비한 계정을 확인하지 못했습니다. 초안을 유지했습니다.');
    }
    let response, body;
    try {
      response = await fetcher(target, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
        body: JSON.stringify(intent),
      });
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error();
      body = await response.json();
    } catch {
      throw failure('result_unknown', '게시 서버의 저장 응답을 확인하지 못했습니다. 원래 작업을 유지했습니다.', 'unknown');
    }
    if (!response.ok) {
      if (response.status === 409 && body?.error?.state === 'conflict') {
        throw failure('publication_conflict', '현재 공개 판본이 바뀌었습니다. 원래 작업과 초안을 유지했습니다.', 'conflict');
      }
      if ([400, 401, 403, 413].includes(response.status) && body?.error?.state === 'blocked') {
        throw failure('publication_rejected', '기존 계정 또는 게시 자료를 서버가 확인하지 못했습니다. 원래 작업과 초안을 유지했습니다.');
      }
      throw failure('result_unknown', '게시 서버의 판정을 확인하지 못했습니다. 같은 작업 ID를 유지했습니다.', 'unknown');
    }
    const result = body?.result;
    if (result?.state !== 'committed' || typeof result.currentMatchesAfter !== 'boolean' ||
      !['verified', 'pruned', 'damaged'].includes(result.recoveryState) ||
      (result.currentMatchesAfter && result.publicationState?.lastOperationId !== intent.id) ||
      (result.recoveryState !== 'damaged' && (result.receipt?.id !== intent.id ||
        result.receipt?.kind !== (intent.action === 'publish' ? 'deploy' : 'restore')))) {
      throw failure('result_unknown', '서버가 돌려준 작업 ID와 저장 기록을 확인하지 못했습니다. 초안을 유지했습니다.', 'unknown');
    }
    return result;
  }
  if (new URL(target).origin === WORKSPACE_ORIGIN) {
    submit.checkAvailability = async () => {
      try {
        const response = await fetcher(target, {method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000)});
        if (response.ok && (await response.json()).publicationEnabled === true) return;
      } catch { /* keep the draft until the hosted publisher responds */ }
      throw failure('publication_unavailable', '현재 외부 앱의 게시 서버를 이용할 수 없습니다. 편집 초안을 유지했습니다.');
    };
  }
  return submit;
}
