/* Normal GUIDE publisher. No Firebase initialization, assets, timers or writes on import.
 * Firebase compat Reference.transaction(updateFn, onComplete?, applyLocally?) is the
 * existing SDK contract (firebase/compat/index.d.ts). Its callback is synchronous
 * and retried against fresh server state; all assets/identities are prepared first.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuidePublishing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var PRODUCER = 'guide-studio', STATE = 'guidePublicationV1', INDEX = 'guidePublicationOperationsV1';
  var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
  var clone = function (v) { return v == null ? null : JSON.parse(JSON.stringify(v)); };
  var object = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
  var array = function (v) { return Array.isArray(v) ? v : object(v) ? Object.keys(v).map(function (k) { return v[k]; }) : []; };
  function PublishError(code, message, state) { this.name = 'GuidePublishError'; this.code = code; this.message = message; this.state = state || 'blocked'; if (Error.captureStackTrace) Error.captureStackTrace(this, PublishError); }
  PublishError.prototype = Object.create(Error.prototype); PublishError.prototype.constructor = PublishError;
  function fail(code, message, state) { throw new PublishError(code, message, state); }
  // RTDB drops null/empty children and can return arrays as numeric-key objects.
  // Compare that wire value without normalizing or rewriting foreign data.
  function wire(v) {
    if (v == null) return null;
    if (typeof v !== 'object') { if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) fail('invalid_json', '저장할 값의 형식을 확인해 주세요.'); return v; }
    var out = {};
    Object.keys(v).sort().forEach(function (k) { var child = wire(v[k]); if (child !== null) Object.defineProperty(out, k, {value: child, enumerable: true, configurable: true, writable: true}); });
    return Object.keys(out).length ? out : null;
  }
  function equal(a, b) { return JSON.stringify(wire(a)) === JSON.stringify(wire(b)); }
  function freeze(v) { if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { freeze(v[k]); }); Object.freeze(v); } return v; }
  function id(value) { if (typeof value !== 'string' || !value || /[.#$\[\]/\u0000-\u001f\u007f]/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value) || /^card3-/i.test(value)) fail('invalid_id', '다른 프로그램의 예약 ID 또는 잘못된 항목 ID입니다.'); return value; }
  function teamItems(team) {
    if (team == null) return [];
    if (!object(team)) fail('invalid_team', '팀 자료 형식을 확인해 주세요.');
    var seen = new Set(), cats = new Set(), rows = [];
    array(team.categories).forEach(function (c) {
      if (!object(c)) fail('invalid_team', '카테고리 형식을 확인해 주세요.');
      id(c.id); if (cats.has(c.id)) fail('duplicate_id', '카테고리 ID가 중복되었습니다.'); cats.add(c.id);
      array(c.items).forEach(function (item) { if (!object(item)) fail('invalid_team', '항목 형식을 확인해 주세요.'); id(item.id); if (seen.has(item.id)) fail('duplicate_id', '항목 ID가 중복되었습니다: ' + item.id); seen.add(item.id); rows.push(item); });
    });
    return rows;
  }
  function assetIdentity(raw) {
    if (typeof raw !== 'string') return null;
    try {
      var u = new URL(raw); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
      var p = decodeURIComponent(u.pathname), match;
      if (u.hostname === 'firebasestorage.googleapis.com' && (match = p.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/))) return 'gcs:' + match[1] + '/' + match[2];
      if (u.hostname === 'storage.googleapis.com' && (match = p.match(/^\/([^/]+)\/(.+)$/))) return 'gcs:' + match[1] + '/' + match[2];
      if (/\.storage\.googleapis\.com$/.test(u.hostname)) return 'gcs:' + u.hostname.slice(0, -'.storage.googleapis.com'.length) + p;
      return u.protocol + '//' + u.host.toLowerCase() + p;
    } catch (_) { return null; }
  }
  function safeCard(card) {
    var source = assetIdentity(card.file), blur = assetIdentity(card.blur), wm = assetIdentity(card.wm), proof = card.derivatives;
    if (!source || !blur || blur === source || (wm && wm === source)) fail('unsafe_derivative', '원본과 분리된 블러·워터마크가 확인되지 않았습니다. 카드를 다시 준비해 주세요.');
    if (!proof || proof.schema !== 1 || proof.method !== 'guide-canvas-v1' || proof.source !== source || proof.blur !== blur || (proof.wm || null) !== wm) fail('unverified_derivative', '이미지 파생본의 제작 기록을 확인하지 못했습니다. 정상 변환이 필요합니다.');
    return card.revealed ? (card.wm || card.blur) : card.blur;
  }
  function validAccent(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
  function projection(team, validate, only) {
    var out = {};
    teamItems(team).forEach(function (item) {
      if (only && !has(only, item.id)) return;
      if (item.cards == null) return;
      var cards = array(item.cards).map(function (card) {
        if (!object(card)) fail('invalid_card', '카드 형식을 확인해 주세요.');
        var row = {title: card.title, file: validate ? safeCard(card) : (card.revealed ? card.wm || card.blur || '' : card.blur || ''), revealed: !!card.revealed, ord: card.ord};
        if (validAccent(card.accent_color)) row.accent_color = card.accent_color;
        return clone(row);
      });
      out[item.id] = {title: item.title || '', collectedAt: item.collectedAt || '', cards: cards};
    });
    return out;
  }
  function validState(state) {
    if (state == null) return null;
    if (!object(state) || state.schema !== 'guide-publication-state' || state.version !== 1 || state.producer !== PRODUCER || !Number.isSafeInteger(state.revision) || state.revision < 1 || (state.manifest != null && !object(state.manifest))) fail('unknown_state', 'GUIDE 소유 기록이 다른 형식입니다. 덮어쓰지 않았습니다.');
    if (Object.keys(state).some(function (k) { return !['schema', 'version', 'producer', 'revision', 'lastOperationId', 'at', 'manifest'].includes(k); })) fail('unknown_state', 'GUIDE 소유 기록에 확인되지 않은 필드가 있습니다.');
    Object.keys(state.manifest || {}).forEach(id); return state;
  }
  function isReceipt(v) { return !!(v && v.schema === 'guide-publication-receipt' && v.version === 1 && v.producer === PRODUCER && object(v.before) && object(v.after) && typeof v.inputHash === 'string' && /^[a-f0-9]{64}$/.test(v.inputHash)); }
  async function digest(value) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) fail('crypto_unavailable', '현재 환경에서 배포 입력을 검증할 수 없습니다. 보안 연결에서 열어 주세요.');
    var bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(wire(value)));
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  function publicationOwnership(team,state){
    state=validState(state);
    return {state:state,previous:state?clone(state.manifest||{}):projection(team,false),strictOwnership:!!state};
  }
  // The older accent renderer used the same item/card order and clear URL for
  // accent-bearing revealed cards. This identifies an existing link only. Every
  // outgoing card still passes safeCard, and hidden clear files prove nothing.
  function legacyPublicMatches(item, published) {
    if (!item || !object(published) || Object.keys(published).some(function (key) { return !['title', 'collectedAt', 'cards'].includes(key); })) return false;
    if (!equal(published.title, item.title || '') || !equal(published.collectedAt, item.collectedAt || '')) return false;
    var source = array(item.cards), current = array(published.cards), seen = new Set();
    return source.length > 0 && source.length === current.length && current.every(function (card, index) {
      var local = source[index];
      if (!object(card) || !object(local) || Object.keys(card).some(function (key) { return !['title', 'file', 'revealed', 'ord', 'accent_color'].includes(key); })) return false;
      if (!Number.isSafeInteger(card.ord) || card.ord !== local.ord || seen.has(card.ord) || card.title !== local.title || card.revealed !== !!local.revealed || !assetIdentity(card.file)) return false;
      seen.add(card.ord);
      var accent = validAccent(card.accent_color), derived = local.revealed ? local.wm || local.blur : local.blur;
      if (has(card, 'accent_color') && !accent) return false;
      return (card.file === derived && assetIdentity(derived) !== assetIdentity(local.file)) ||
        (card.revealed && accent && card.file === local.file && assetIdentity(local.wm) && assetIdentity(local.wm) !== assetIdentity(local.file));
    });
  }
  function assertCurrentPublicOwnership(current,targets){
    current=current||{};var ownership=publicationOwnership(current.data,current[STATE]),pub=current.published||{};
    if(!object(pub))fail('invalid_public','공개 자료 형식이 다릅니다.');
    var keys=new Set(targets||[]),items=new Map(teamItems(current.data).map(function (item) { return [item.id,item]; }));
    var previous=clone(ownership.previous);
    if(ownership.strictOwnership)Object.keys(previous).forEach(function(key){keys.add(key);});
    keys.forEach(function(key){id(key);var present=has(pub,key),value=pub[key];
      if(present&&!ownership.strictOwnership&&legacyPublicMatches(items.get(key),value))previous[key]=clone(value);
      if(present&&(!has(previous,key)||(value&&has(value,'_card3'))||!equal(value,previous[key])))fail('public_collision','다른 생산자 또는 확인되지 않은 공개 ID와 겹칩니다: '+key,'conflict');
      if(ownership.strictOwnership&&has(previous,key)&&!present)fail('public_changed','기존 GUIDE 공개본이 변경되었습니다: '+key,'conflict');
    });return previous;
  }
  function restoreProjection(team, published, proof) {
    var receipt = proof && proof.receipt;
    if (!isReceipt(receipt) || receipt.id !== proof.id || receipt.inputHash !== proof.inputHash ||
        !equal(receipt.before.team, team) || !equal(receipt.before.owned || {}, published)) {
      fail('invalid_restore', '복구 자료가 확인된 이전 저장 기록과 다릅니다.');
    }
    var items = new Map(teamItems(team).map(function (item) { return [item.id, item]; }));
    var legacyIds = new Set();
    Object.keys(published).forEach(function (key) {
      id(key);
      var item = items.get(key), saved = published[key];
      if (item && item.cards != null) {
        try {
          var normal = projection({categories: [{id: 'restore-validation', items: [item]}]}, true);
          if (equal(normal[key], saved)) return;
        } catch (error) { if (!(error instanceof PublishError)) throw error; }
        // Earlier editions may lack derivative metadata. Only the exact public
        // slot captured in this receipt can be restored. A hidden original is
        // never a matching legacy slot, even if both recorded fields claim it.
        var slot = receipt.before.public && receipt.before.public[key];
        if (slot && slot.present === true && equal(slot.value, saved) &&
            array(item.cards).every(function (card) { return object(card) && card.derivatives == null; }) &&
            legacyPublicMatches(item, saved)) {
          legacyIds.add(key);
          return;
        }
      }
      fail('invalid_restore', '복구할 공개본과 기존 공개 범위를 확인하지 못했습니다.');
    });
    return {published: clone(published), legacyIds: legacyIds};
  }
  function historicalRestoreIds(op) {
    return op && op.kind === 'restore' && op.restoreFrom
      ? restoreProjection(op.team, op.public, op.restoreFrom).legacyIds : new Set();
  }
  async function operation(options) {
    var base = options.base;
    if (!base || !base.known) fail('base_unknown', '편집을 시작한 원격 판본이 확인되지 않았습니다. 초안을 보관하고 최신 자료와 먼저 비교해 주세요.');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(options.id || '')) fail('invalid_operation', '배포 작업 ID를 확인해 주세요.');
    if (!options.actor || typeof options.actor.uid !== 'string' || !options.actor.uid) fail('account_required', '기존 관리자 계정이 필요합니다.');
    if (!Number.isSafeInteger(options.at) || options.at <= 0) fail('invalid_operation', '배포 시각을 확인해 주세요.');
    var ownership=publicationOwnership(base.team,base.state),state=ownership.state,desired=clone(options.team),previous=ownership.previous;
    var publicNodes = options.kind === 'restore' ? restoreProjection(desired, options.publicOverride, options.restoreFrom).published
      : projection(desired, true);
    var payload = {schema: 'guide-publication-operation', version: 1, producer: PRODUCER, id: options.id, kind: options.kind || 'deploy', at: options.at, actor: clone(options.actor), baseTeam: clone(base.team), baseState: clone(state), previous: previous, strictOwnership: !!state, team: desired, public: publicNodes, keep: 7};
    if (options.previous) payload.previous = clone(options.previous);
    if (options.restoreFrom) payload.restoreFrom = clone(options.restoreFrom);
    payload.inputHash = await digest(payload);
    return freeze(payload);
  }
  async function prepareDeploy(options) { return operation(options); }
  async function prepareRestore(receipt, options) {
    if (!isReceipt(receipt)) fail('legacy_backup', '이전 형식 백업은 소유 범위와 이후 판본을 입증하지 못해 자동 복원할 수 없습니다. 확인 가능한 편집 자료만 별도로 검토하세요.');
    validState(receipt.after.state);
    return operation({id: options.id, actor: options.actor, at: options.at, kind: 'restore', base: {known: true, team: receipt.after.team, state: receipt.after.state}, team: receipt.before.team, previous: receipt.after.owned || {}, publicOverride: receipt.before.owned || {}, restoreFrom: {id: receipt.id, inputHash: receipt.inputHash, receiptHash: await digest(receipt), receipt: clone(receipt)}});
  }
  async function resumeOperation(value) {
    if (!value || value.schema !== 'guide-publication-operation' || value.version !== 1 || value.producer !== PRODUCER) fail('invalid_operation', '보관한 배포 작업 형식을 확인하지 못했습니다.');
    var c = clone(value), expected = c.inputHash; delete c.inputHash;
    if (await digest(c) !== expected) fail('invalid_operation', '보관한 배포 입력이 변경되었습니다.');
    validState(c.baseState); teamItems(c.team);
    if (c.kind === 'restore') restoreProjection(c.team, c.public, c.restoreFrom);
    else if (!equal(projection(c.team, true), c.public)) fail('invalid_operation', '보관한 공개 대상이 팀 자료와 다릅니다.');
    return freeze(clone(value));
  }
  function stateAfter(op) { return {schema: 'guide-publication-state', version: 1, producer: PRODUCER, revision: (op.baseState ? op.baseState.revision : 0) + 1, lastOperationId: op.id, at: op.at, manifest: clone(op.public)}; }
  function ownSlot(pub, key) { return {present: has(pub, key), value: has(pub, key) ? clone(pub[key]) : null}; }
  function matchesAfter(current, op, targets) {
    if (!equal(current.data, op.team) || !equal(current[STATE], stateAfter(op))) return false;
    return targets.every(function (key) { return equal((current.published || {})[key], has(op.public, key) ? op.public[key] : null); });
  }
  function applyOperation(current, op, verification) {
    current = current || {};
    if (!object(current)) fail('invalid_marketing', '마케팅 저장소 형식을 확인해 주세요.');
    var index = current[INDEX] || {};
    if (!object(index)) fail('unknown_state', '배포 작업 기록의 형식이 다릅니다.');
    var prior = index[op.id];
    if (prior) {
      if (prior.schema !== 'guide-operation-result' || prior.producer !== PRODUCER || prior.version !== 1 || prior.id !== op.id || prior.kind !== op.kind || prior.inputHash !== op.inputHash) fail('operation_reuse', '이미 사용한 작업 ID에 다른 입력을 적용할 수 없습니다.');
      return {next: null, replayed: true, receipt: clone((current.deployBackups || {})['g-' + op.id] || prior), currentMatchesAfter: matchesAfter(current, op, array(prior.targets))};
    }
    if (op.kind === 'restore') {
      var proof = op.restoreFrom, original = proof && index[proof.id], stored = proof && (current.deployBackups || {})['g-' + proof.id];
      if (!proof || !original || original.schema !== 'guide-operation-result' || original.producer !== PRODUCER || original.inputHash !== proof.inputHash || original.receiptHash !== proof.receiptHash || !equal(stored, proof.receipt)) fail('restore_proof_changed', '성공한 원래 복구 기록과 현재 백업이 일치하지 않습니다. 복원하지 않았습니다.', 'conflict');
    }
    if (!equal(current.data, op.baseTeam) || !equal(current[STATE], op.baseState)) fail('stale_base', '다른 작업자가 GUIDE 자료를 변경했습니다. 초안을 유지했으며 최신 판본과 비교해야 합니다.', 'conflict');
    validState(current[STATE]);
    var pub = current.published || {}; if (!object(pub)) fail('invalid_public', '공개 자료 형식이 다릅니다.');
    var beforeOwned = {};
    Object.keys(op.previous || {}).forEach(function (key) {
      id(key); var value = pub[key];
      if (has(pub, key) && !has(value, '_card3') && equal(value, op.previous[key])) beforeOwned[key] = clone(value);
      else if (op.strictOwnership) fail('public_changed', '기존 GUIDE 공개본이 변경되었습니다: ' + key, 'conflict');
    });
    Object.keys(op.public).forEach(function (key) {
      id(key);
      if (has(pub, key) && !has(beforeOwned, key)) fail('public_collision', '다른 생산자 또는 확인되지 않은 공개 ID와 겹칩니다: ' + key, 'conflict');
    });
    var targets = Array.from(new Set(Object.keys(beforeOwned).concat(Object.keys(op.public)))).sort(), next = clone(current), beforeSlots = {}, afterSlots = {};
    next.published = clone(pub); targets.forEach(function (key) {
      beforeSlots[key] = ownSlot(pub, key);
      if (has(op.public, key)) next.published[key] = clone(op.public[key]); else delete next.published[key];
      afterSlots[key] = ownSlot(next.published, key);
    });
    if (op.team == null) delete next.data; else next.data = clone(op.team);
    next[STATE] = stateAfter(op);
    var receipt = {schema: 'guide-publication-receipt', version: 1, producer: PRODUCER, id: op.id, inputHash: op.inputHash, kind: op.kind, at: op.at, by: op.actor.email || op.actor.uid, targets: targets, before: {teamPresent: current.data != null, statePresent: current[STATE] != null, team: clone(current.data), state: clone(current[STATE]), owned: beforeOwned, public: beforeSlots}, after: {teamPresent: op.team != null, statePresent: true, team: clone(op.team), state: clone(next[STATE]), owned: clone(op.public), public: afterSlots}};
    if (verification && !equal(receipt, verification.receipt)) fail('owned_scope_changed', '준비 중 GUIDE 소유 범위가 변경되어 저장을 중단했습니다.', 'conflict');
    if (next.deployBackups != null && !object(next.deployBackups)) fail('invalid_backup', '복구 기록을 함께 저장할 수 없습니다.');
    next.deployBackups = next.deployBackups || {};
    if (has(next.deployBackups, 'g-' + op.id)) fail('backup_collision', '복구 기록 ID가 이미 사용되었습니다.');
    next.deployBackups['g-' + op.id] = receipt;
    // Seven full GUIDE restore receipts; unknown/legacy/foreign backups stay intact.
    // Compact operation identities remain durable even after full receipt retention.
    var verifiedBackups = verification && verification.backups || {},verifiedIndexes=verification&&verification.backupIndexes||{};
    var old = Object.keys(verifiedBackups).filter(function (k) { return k !== 'g-' + op.id && equal(next.deployBackups[k], verifiedBackups[k]) && equal(index[verifiedBackups[k].id],verifiedIndexes[k]); }).sort(function (a, b) { return (next.deployBackups[a].at - next.deployBackups[b].at) || a.localeCompare(b); });
    // The current operation always keeps its recovery receipt, even if the
    // client clock was adjusted backward. Never prune a modified/unknown node.
    next[INDEX] = clone(index);
    while (old.length + 1 > op.keep) {
      var removed=old.shift(),removedId=next.deployBackups[removed].id;
      delete next.deployBackups[removed];
      next[INDEX][removedId].receiptStatus='pruned';next[INDEX][removedId].prunedBy=op.id;next[INDEX][removedId].prunedAtRevision=next[STATE].revision;
    }
    next[INDEX][op.id] = {schema: 'guide-operation-result', version: 1, producer: PRODUCER, id: op.id, inputHash: op.inputHash, at: op.at, kind: op.kind, revision: next[STATE].revision, targets: targets, receiptStatus:'retained'};
    if (verification) next[INDEX][op.id].receiptHash = verification.receiptHash;
    return {next: next, replayed: false, receipt: receipt, currentMatchesAfter: true};
  }
  function classify(error) {
    if (error instanceof PublishError) return error;
    if (/permission|unauthorized|denied/i.test((error && error.code) || '')) return new PublishError('permission_denied', '고객자료와 복구 기록을 함께 저장할 권한이 없습니다. 현재 자료와 초안을 유지했습니다.', 'blocked');
    return new PublishError('result_unknown', '저장 결과를 확인하지 못했습니다. 같은 작업 ID를 보관했습니다. 다시 확인해도 중복 배포하지 않습니다.', 'unknown');
  }
  async function recoveryEvidence(current,op,plan){
    var index=current[INDEX]||{},saved=index[op.id],backups=current.deployBackups||{},key='g-'+op.id;
    function damaged(code){return {recoveryState:'damaged',recoveryIssue:{code:code},receipt:null};}
    if(typeof saved.receiptHash!=='string'||!/^[a-f0-9]{64}$/.test(saved.receiptHash))return damaged('receipt_hash_missing');
    if(has(backups,key)){
      var full=backups[key];
      if(!isReceipt(full))return damaged('receipt_schema_invalid');
      if(full.id!==op.id||full.inputHash!==op.inputHash||full.kind!==op.kind)return damaged('receipt_identity_mismatch');
      try{if(await digest(full)!==saved.receiptHash)return damaged('receipt_hash_mismatch');}
      catch(_){return damaged('receipt_validation_unavailable');}
      return {recoveryState:'verified',recoveryIssue:null,receipt:clone(full)};
    }
    var state=current[STATE]||{},pruner=index[saved.prunedBy];
    var intentional=saved.receiptStatus==='pruned'&&Number.isSafeInteger(saved.prunedAtRevision)&&saved.prunedAtRevision>saved.revision&&pruner&&pruner.schema==='guide-operation-result'&&pruner.version===1&&pruner.producer===PRODUCER&&pruner.id===saved.prunedBy&&pruner.revision===saved.prunedAtRevision&&state.revision>=saved.prunedAtRevision&&state.lastOperationId!==op.id&&!plan.currentMatchesAfter;
    if(intentional)return {recoveryState:'pruned',recoveryIssue:null,receipt:clone(saved)};
    return damaged(plan.currentMatchesAfter||state.lastOperationId===op.id?'receipt_missing_current':'receipt_missing_unverified');
  }
  async function committedResult(current,op,plan,replayed){
    var evidence=await recoveryEvidence(current,op,plan);
    return {state:'committed',replayed:replayed,historical:!plan.currentMatchesAfter,currentMatchesAfter:plan.currentMatchesAfter,team:clone(current&&current.data),publicationState:clone(current&&current[STATE]),recoveryState:evidence.recoveryState,recoveryIssue:evidence.recoveryIssue,receipt:evidence.receipt};
  }
  async function inspectOperation(current,op){var plan=applyOperation(current,op);if(!plan.replayed)return {state:'not_recorded'};return committedResult(current,op,plan,true);}
  async function commitOperation(ref, op) {
    var applied, failure;
    var keepParent = function () {};
    try {
      // A one-shot RTDB read can release its cache before the SDK invokes the
      // transaction callback. Keep the parent subscribed through confirmation.
      ref.on('value', keepParent, keepParent);
      var current = (await ref.once('value')).val();
      var preview = applyOperation(current, op);
      if (preview.replayed) return await committedResult(current,op,preview,true);
      var verification = {receipt: preview.receipt, receiptHash: await digest(preview.receipt), backups: {},backupIndexes:{}};
      for (var key of Object.keys((current && current.deployBackups) || {})) {
        var backup = current.deployBackups[key], saved = backup && ((current && current[INDEX]) || {})[backup.id];
        if (isReceipt(backup) && key === 'g-' + backup.id && saved && saved.schema === 'guide-operation-result' && saved.producer === PRODUCER && saved.inputHash === backup.inputHash && saved.receiptHash === await digest(backup)){verification.backups[key] = clone(backup);verification.backupIndexes[key]=clone(saved);}
      }
      var result = await ref.transaction(function (fresh) {
        try { applied = applyOperation(fresh, op, verification); failure = null; return applied.replayed ? undefined : applied.next; }
        catch (error) { failure = error; return undefined; }
      }, undefined, false);
      if (!result.committed && !(applied && applied.replayed)) throw failure || new PublishError('not_committed', '원자 저장이 확정되지 않았습니다. 초안과 작업 ID를 유지했습니다.', 'conflict');
      var final = result.snapshot.val(), finalApply = applyOperation(final, op);
      return await committedResult(final,op,finalApply,!!(applied&&applied.replayed));
    } catch (error) { throw classify(error); }
    finally { ref.off('value', keepParent); }
  }
  function legacyRecovery(backup) {
    if (isReceipt(backup)) fail('not_legacy', '새 복구 기록은 정상 판본 확인 복원을 사용하세요.');
    var source = clone(backup && backup.team); teamItems(source);
    if (!source) fail('legacy_empty', '확인 가능한 팀 자료가 없는 이전 백업입니다.');
    var pub = (backup && backup.pub) || {}, projected = projection(source, false), verified = [], blocked = [];
    array(source.categories).forEach(function (cat) { cat.items = array(cat.items).filter(function (item) {
      if (item.cards == null) { verified.push(item.id); return true; }
      if (!has(pub, item.id) || has(pub[item.id], '_card3') || !equal(pub[item.id], projected[item.id])) { blocked.push({id: item.id, reason: '팀·공개본의 정확한 대응을 확인하지 못함'}); return false; }
      try { array(item.cards).forEach(safeCard); } catch (_) { blocked.push({id: item.id, reason: '안전한 이미지 파생본 제작 기록이 없음'}); return false; }
      verified.push(item.id); return true;
    }); });
    return {format: 'beancraft-guide-legacy-recovery', version: 1, mode: 'unsaved-review', team: source, verifiedItemIds: verified, blocked: blocked};
  }
  return {PublishError: PublishError, clone: clone, wire: wire, equal: equal, teamItems: teamItems, assetIdentity: assetIdentity, safeCard: safeCard, projection: projection, assertCurrentPublicOwnership: assertCurrentPublicOwnership, historicalRestoreIds: historicalRestoreIds, isReceipt: isReceipt, digest: digest, prepareDeploy: prepareDeploy, prepareRestore: prepareRestore, resumeOperation: resumeOperation, applyOperation: applyOperation, commitOperation: commitOperation, inspectOperation: inspectOperation, legacyRecovery: legacyRecovery, stateKey: STATE, indexKey: INDEX};
});
