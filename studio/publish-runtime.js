/* The studio's normal publication handler. UI/Firebase/Storage are injected so
 * the same real handler can be checked without any operating account or asset.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./publish-owner.js'));
  else root.GuidePublisherRuntime = factory(root.GuidePublishing);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Owner) {
  'use strict';
  function problem(code, message, state) { return new Owner.PublishError(code, message, state); }
  function strip(team) { return JSON.parse(JSON.stringify(team, function (key, value) { return key.charAt(0) === '_' ? undefined : value; })); }
  function create(options) {
    var inFlight = null;
    async function confirmedOrUnknown(intent, operation) {
      if (intent.transport !== 'server-v1') {
        // A legacy operation whose actor differs from the current verified
        // account can only be reconciled read-only with its original hash.
        var saved = (await options.parentRef().once('value')).val();
        var prior = await Owner.inspectOperation(saved, operation);
        if (prior.state === 'committed') return prior;
        throw problem('legacy_intent_pending', '이전 Studio가 준비한 작업의 저장을 확인하지 못했습니다. 원래 초안을 유지했습니다.');
      }
      if (typeof options.submitPublication !== 'function') throw problem('publication_endpoint_missing', 'GUIDE 게시 서버 연결이 필요합니다. 원래 작업을 유지했습니다.');
      var request = operation.kind === 'restore' ?
        {action: 'restore', id: operation.id, at: operation.at, receiptId: operation.restoreFrom.id} :
        {action: 'publish', id: operation.id, at: operation.at, baseTeam: operation.baseTeam,
          baseState: operation.baseState, team: operation.team,
          ...(operation.baseState == null ? {previous: operation.previous} : {})};
      var timer,clock=options.clock||globalThis;
      try {
        return await Promise.race([
          options.submitPublication(request, intent.actor.uid),
          new Promise(function(_,reject){timer=clock.setTimeout(function(){reject(problem('result_unknown','저장 응답을 아직 확인하지 못했습니다. 작업 ID를 유지했습니다. 원래 요청은 나중에 완료될 수 있으므로 같은 작업을 확인해 주세요.','unknown'));},45000);})
        ]);
      } finally { if(timer!==undefined)clock.clearTimeout(timer); }
      // A deadline cannot cancel a server commit. Keep the operation ID for
      // reconciliation if the reply arrives after the editor's deadline.
    }
    function requireOwner(intent) {
      var actor = options.actor();
      if (!actor || !actor.uid || (intent && actor.uid !== intent.actor.uid)) throw problem('account_changed', '작업을 시작한 관리자 계정이 달라졌습니다. 원래 계정의 준비 자료를 유지했습니다.');
      return actor;
    }
    async function persist(intent) {
      requireOwner(intent);
      intent.storageKey = 'publish_' + intent.capture.key;
      intent.journalKey = 'publish-intent_' + intent.capture.key + '_' + intent.id;
      // A latest-pointer may be shared by standalone tabs. The durable per-ID
      // journal is written first and never overwritten by another operation.
      await options.write(intent.journalKey, Owner.clone(intent));
      await options.write(intent.storageKey, Owner.clone(intent));
    }
    async function uploaded(intent, itemId, sourceKey, role, dataUrl) {
      var entry = intent.assets[sourceKey], plans = entry.plans || (entry.plans = {}), plan = plans[role];
      if (!plan) {
        if (typeof dataUrl !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) throw problem('conversion_failed', '블러·워터마크 변환 결과를 확인하지 못했습니다. 원본은 공개하지 않았습니다.');
        var hash = await Owner.digest(dataUrl);
        plan = plans[role] = {operationId: intent.id, role: role, contentHash: hash, name: 'g-' + intent.id + '-' + role + '-' + hash + '.jpg', dataUrl: dataUrl};
        await persist(intent); // Keep the exact input/path before a possibly unknown upload.
      }
      requireOwner(intent);
      var value = await options.upload(itemId, plan.dataUrl, plan);
      if (!Owner.assetIdentity(value)) throw problem('invalid_asset', '이미지 업로드 결과 주소를 확인하지 못했습니다.');
      entry[role] = value; delete plan.dataUrl; await persist(intent);
      return value;
    }
    async function candidate(intent, previous) {
      var next = Owner.clone(intent.snapshot), warnings = [];
      Owner.teamItems(next); // Validate IDs before any asset work.
      var bases = new Map(Owner.teamItems(intent.base.team).map(function (item) { return [item.id, item]; }));
      for (var item of Owner.teamItems(next)) {
        if (item._cards == null && item.cards == null) continue;
        var cards = item._cards != null ? item._cards : (Array.isArray(item.cards) ? item.cards : Object.values(item.cards || {})).map(function (c, i) { return {title: c.title || '', url: c.file, blur: c.blur, wm: c.wm, derivatives: c.derivatives, committed: true, revealed: !!c.revealed, ord: c.ord == null ? i : c.ord}; });
        cards = cards.slice().sort(function (a, b) { return (Number(!!b.revealed) - Number(!!a.revealed)) || ((a.ord || 0) - (b.ord || 0)); });
        var ready = [];
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i], clear = Owner.assetIdentity(card.url), proofCard = {file: card.url, blur: card.blur, wm: card.wm, derivatives: card.derivatives, revealed: card.revealed};
          var safe = false; try { Owner.safeCard(proofCard); safe = !!card.committed; } catch (_) {}
          var result;
          if (safe) result = {file: card.url, blur: card.blur, wm: card.wm || null, derivatives: Owner.clone(card.derivatives)};
          else {
            if (!clear && (typeof card.url !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(card.url))) throw problem('invalid_source', '변환할 원본 이미지를 다시 첨부해 주세요.');
            var cacheKey = item.id + '-' + await Owner.digest(card.url), entry = intent.assets[cacheKey] || (intent.assets[cacheKey] = {itemId: item.id, source: card.url, plans: {}});
            if (!entry.clear) {
              if (clear && card.committed) { entry.clear = card.url; await persist(intent); }
              else await uploaded(intent, item.id, cacheKey, 'clear', card.url);
            }
            options.busy('카드 준비 중… (' + (i + 1) + '/' + cards.length + ')');
            if (!entry.blur) {
              var blurPlan = entry.plans.blur;
              var bd = blurPlan && blurPlan.dataUrl ? blurPlan.dataUrl : await options.blur(card.url);
              await uploaded(intent, item.id, cacheKey, 'blur', bd);
            }
            if (!entry.watermarkAttempted) {
              var wmPlan = entry.plans.wm;
              var wd = wmPlan && wmPlan.dataUrl ? wmPlan.dataUrl : await options.watermark(card.url);
              if (wd) await uploaded(intent, item.id, cacheKey, 'wm', wd);
              entry.watermarkAttempted = true; await persist(intent);
            }
            result = {file: entry.clear, blur: entry.blur, wm: entry.wm || null, derivatives: {schema: 1, method: 'guide-canvas-v1', source: Owner.assetIdentity(entry.clear), blur: Owner.assetIdentity(entry.blur), wm: Owner.assetIdentity(entry.wm), operationId: intent.id}};
            Owner.safeCard({...result, revealed: card.revealed});
            if (card.revealed && !result.wm) warnings.push(card.title || '카드 ' + (i + 1));
          }
          var sourceCard = Object.values(bases.get(item.id)?.cards || {}).find(function (prior) {
            return prior.ord === card.ord && prior.title === card.title && prior.file === card.url;
          });
          var publicCard = sourceCard && Object.values(previous?.[item.id]?.cards || {}).find(function (prior) { return prior.ord === sourceCard.ord; });
          var accent = card.accent_color || sourceCard?.accent_color || publicCard?.accent_color;
          ready.push({...result, title: card.title || '', revealed: !!card.revealed, ord: card.ord == null ? i : card.ord,
            ...(typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? {accent_color: accent} : {})});
        }
        item.cards = ready; item.type = 'market'; delete item._cards; delete item.files;
      }
      next.updated = intent.labelDate; next.updatedAt = intent.at;
      return {team: strip(next), warnings: warnings};
    }
    async function run(kind, restoreReceipt, confirmedCapture) {
      var actor = requireOwner(), intent = options.intent();
      if (options.ready && !options.ready()) throw problem('publication_access_unavailable', '편집 자료는 열었지만 배포 소유 기록을 읽을 권한을 확인하지 못했습니다. 계정 연결을 확인한 뒤 자료를 다시 읽어 주세요.');
      if (!['deploy', 'restore'].includes(kind)) throw problem('invalid_operation', '배포 작업 종류를 확인해 주세요.');
      if (intent && confirmedCapture) throw problem('pending_operation', '확인 이후 다른 준비 작업이 생겼습니다. 배포 내용을 다시 확인해 주세요.');
      if (intent && (intent.actor?.uid !== actor.uid || intent.kind !== kind || (kind === 'restore' && intent.restoreReceipt?.id !== restoreReceipt?.id))) throw problem('pending_operation', '이전에 준비한 배포 작업의 결과를 먼저 확인해 주세요. 새 작업으로 바꾸지 않았습니다.');
      if (!intent?.operation && options.submitPublication?.checkAvailability) {
        await options.submitPublication.checkAvailability();
        requireOwner({actor: actor});
        if (options.intent() !== intent) throw problem('pending_operation', '준비 중인 작업이 바뀌었습니다. 새 작업을 시작하지 않았습니다.');
      }
      if (!intent) {
        var currentCapture = options.capture(),capture = confirmedCapture?Owner.clone(confirmedCapture):currentCapture;
        if(capture.uid!==actor.uid||capture.key!==currentCapture.key||capture.writerId!==currentCapture.writerId)throw problem('confirmation_owner_changed','확인창을 연 계정이나 편집 창이 달라졌습니다. 내용을 다시 확인해 주세요.');
        intent = {version: 1, transport: 'server-v1', id: globalThis.crypto.randomUUID(), kind: kind, actor: Owner.clone(actor), at: Date.now(), labelDate: options.today(), snapshot: Owner.clone(capture.data), base: Owner.clone(capture.base), capture: capture, assets: {}, phase: 'preparing', storageKey: 'publish_' + capture.key};
        if (restoreReceipt) intent.restoreReceipt = Owner.clone(restoreReceipt);
        await persist(intent); options.setIntent(intent);
      } else {
        // A reload can adopt only the exact same submitted draft/base. Newer
        // input is never consumed by reconciliation of an older operation.
        var now = options.capture();
        if (intent.capture?.key !== now.key || !/^[a-zA-Z0-9_-]{8,100}$/.test(intent.id || '')) throw problem('invalid_operation', '보관한 배포의 계정·작업 경로가 다릅니다.');
        if (Owner.equal(now.data, intent.snapshot) && Owner.equal(now.base, intent.base)) intent.capture = now;
      }
      requireOwner(intent); options.busy('배포 준비 중…');
      if (!intent.transport && !intent.operation) {
        // No signed/hashed operation was submitted by RC2. Keep its existing
        // staged input and identity, now using the server submission route.
        intent.transport = 'server-v1';
        await persist(intent);
      }
      if (!intent.operation) {
        if (kind === 'deploy' && !intent.base?.known) throw problem('base_unknown', '이 초안의 원격 시작 판본이 없습니다. 최신 자료와 비교·확인하기 전에는 업로드나 배포를 시작하지 않습니다.');
        if (kind === 'restore') intent.operation = await Owner.prepareRestore(intent.restoreReceipt, {id: intent.id, actor: intent.actor, at: intent.at});
        else {
          var previous;
          if (!intent.base.state) {
            var current = (await options.parentRef().once('value')).val() || {};
            requireOwner(intent);
            if (!Owner.equal(current.data, intent.base.team) || current[Owner.stateKey]) throw problem('stale_base', '편집 후 GUIDE 자료가 변경되었습니다. 최신 판본과 비교해 주세요.', 'conflict');
            var ids = Owner.teamItems(intent.snapshot).filter(function (item) { return item.cards != null || item._cards != null; }).map(function (item) { return item.id; });
            previous = Owner.assertCurrentPublicOwnership(current, ids);
          }
          var prepared = await candidate(intent, previous); intent.warnings = prepared.warnings;
          intent.operation = await Owner.prepareDeploy({id: intent.id, actor: intent.actor, at: intent.at, base: intent.base, team: prepared.team, previous: previous});
        }
        intent.phase = 'ready'; await persist(intent);
      } else {
        intent.operation = await Owner.resumeOperation(intent.operation);
        if (!intent.transport && intent.operation.actor?.uid === actor.uid &&
            actor.email && intent.operation.actor.email === actor.email) {
          // The server derives these exact actor fields from the verified
          // token, so an older prepared operation keeps its original ID/hash.
          intent.transport = 'server-v1';
          await persist(intent);
        }
      }
      requireOwner(intent); options.busy('판본·소유 범위를 확인해 저장하는 중…');
      var result = await confirmedOrUnknown(intent, intent.operation);
      // The cloud result and later local cleanup are distinct outcomes.
      if (options.actor()?.uid !== intent.actor.uid) return result;
      if(result.recoveryState==='damaged'){
        result.localCleanup='retained';
        options.warning('배포 저장은 확인했지만 복구 기록이 없거나 손상되었습니다. 초안과 원래 작업 기록을 보관했습니다. 다시 배포하지 않고 복구 기록을 먼저 확인해 주세요.');
        return result;
      }
      try {
        var accepted = await options.accept(result, intent.capture, intent.snapshot);
        if (intent.journalKey) await options.remove(intent.journalKey, function (record) { return record.id === intent.id && record.actor?.uid === intent.actor.uid; });
        await options.remove(intent.storageKey, function (record) { return record.id === intent.id && record.actor?.uid === intent.actor.uid; });
        if (options.intent()?.id === intent.id) options.setIntent(null);
      } catch (_) {
        options.warning('클라우드 저장은 확인했지만 로컬 초안 정리를 마치지 못했습니다. 작업 ID를 유지했으므로 다시 확인해도 중복 배포하지 않습니다.');
        result.localCleanup = 'incomplete'; return result;
      }
      if (!result.currentMatchesAfter) options.warning('이 작업은 이미 저장된 기록입니다. 그 뒤 GUIDE 자료가 변경되어 현재 초안을 유지했습니다. 최신 자료와 비교해 주세요.');
      else if (accepted && accepted.needsComparison) options.warning('원래 작업의 저장을 확인했습니다. 현재 다른 작성자의 초안과 시작 판본은 유지했으니 최신 자료와 비교해 주세요.');
      else options.completed(kind, intent.warnings || [], result, intent.capture);
      return result;
    }
    function start(kind, receipt, confirmedCapture) {
      if (inFlight) return inFlight;
      inFlight = run(kind, receipt, confirmedCapture).catch(function (error) { options.error(error); return {state: error.state || 'blocked', error: error}; }).finally(function () { inFlight = null; options.idle(); });
      return inFlight;
    }
    async function restoreBackup(key) {
      if (inFlight) { options.warning('진행 중인 배포 결과를 먼저 확인해 주세요.'); return null; }
      if (typeof key !== 'string' || !key || /[.#$\[\]/\u0000-\u001f]/.test(key)) { options.error(problem('invalid_backup_id', '복구 기록 ID를 확인해 주세요.')); return null; }
      try {
        requireOwner();
        var backup = await options.readBackup(key);
        if (!backup) throw problem('missing_backup', '백업을 찾을 수 없습니다.');
        if (!Owner.isReceipt(backup)) {
          var recovery = Owner.legacyRecovery(backup);
          options.legacy(recovery); return {state: 'review_only', recovery: recovery};
        }
        if (!options.confirm('GUIDE가 변경한 자료만 직전 상태로 복원합니다. 이후 같은 GUIDE 판본이 변경되었으면 복원을 중단합니다.\n현재 편집 초안은 저장 성공 전까지 유지됩니다.\n\n진행할까요?')) return null;
        return start('restore', backup);
      } catch (error) { options.error(error); return {state: error.state || 'blocked', error: error}; }
    }
    return {deploy: function (confirmedCapture) { return start('deploy',undefined,confirmedCapture); }, resume: function () { var intent = options.intent(); if (!intent) return Promise.resolve(null); return start(intent.kind, intent.restoreReceipt); }, busy: function () { return !!inFlight; }, restoreBackup: restoreBackup};
  }
  // Reuse already converted assets without overwriting any newer title/order/
  // removal/replacement typed while the cloud operation was in flight.
  function rebaseAssets(working, submitted, committed) {
    var oldItems = new Map(Owner.teamItems(submitted).map(function (x) { return [x.id, x]; }));
    var newItems = new Map(Owner.teamItems(committed).map(function (x) { return [x.id, x]; }));
    Owner.teamItems(working).forEach(function (item) {
      var old = oldItems.get(item.id), ready = newItems.get(item.id); if (!old || !ready || !item._cards) return;
      var original = old._cards || (Array.isArray(old.cards) ? old.cards : Object.values(old.cards || {})).map(function (c) { return {url: c.file, ord: c.ord, revealed: !!c.revealed}; });
      var ordered = original.slice().sort(function (a, b) { return (Number(!!b.revealed) - Number(!!a.revealed)) || ((a.ord || 0) - (b.ord || 0)); });
      item._cards.forEach(function (c) { var i = ordered.findIndex(function (a) { return a.url === c.url; }); var r = i >= 0 && ready.cards && ready.cards[i]; if (r) { c.url = r.file; c.blur = r.blur; c.wm = r.wm; c.derivatives = Owner.clone(r.derivatives); c.committed = true; } });
    });
  }
  return {create: create, rebaseAssets: rebaseAssets};
});
