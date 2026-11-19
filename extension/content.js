(() => {
  'use strict';
  let draft;
  let publishRequested = false;

  chrome.runtime.onMessage.addListener((message, sender, send) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message || !['probe', 'boards', 'prepare', 'publish'].includes(message.type)) {
      return false;
    }
    async function handle() {
      if (message.type === 'probe') {
        pinterestAdapter.checkPage();
        return { ok: true };
      }
      if (message.type === 'boards') return { ok: true, boards: await pinterestAdapter.listBoards() };
      if (message.type === 'prepare') {
        const proof = await pinterestAdapter.prepare(message.image, message.base64, message.fields);
        draft = { receipt: message.receipt, proof };
        return { ok: true };
      }
      if (!draft || draft.receipt !== message.receipt || publishRequested) {
        return { ok: true, result: { state: 'blocked', code: 'DRAFT_CHANGED', pinUrl: null } };
      }
      publishRequested = true;
      return { ok: true, result: await pinterestAdapter.publish(draft.proof) };
    }
    handle().then(send, error => send({ ok: false, code: error.code ?? 'FORM_LAYOUT' }));
    return true;
  });
})();
