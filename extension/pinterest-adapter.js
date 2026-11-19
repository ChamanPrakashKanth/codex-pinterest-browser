(() => {
  'use strict';

  const selectors = {
    imageInput: 'input[type="file"][accept*="image"],input[type="file"][accept*=".jpg"],[data-test-id="pin-draft-media-upload"] input[type="file"]',
    preview: '[data-test-id="pin-draft-image"] img,img[data-test-id="pin-draft-image"],[data-test-id="pin-draft-media-preview"] img,[data-test-id="media-preview"] img,img[alt="Pin preview"]',
    title: '[data-test-id="pin-draft-title"] input,input[id*="pin-draft-title"],input[placeholder="Add a title"],input[aria-label="Title"]',
    description: '[data-test-id="pin-draft-description"] textarea,[data-test-id="pin-draft-description"] [contenteditable="true"],textarea[placeholder="Add a detailed description"],textarea[placeholder*="Tell everyone"],textarea[aria-label="Description"],[contenteditable="true"][aria-label="Description"],[contenteditable="true"][data-placeholder*="Tell everyone"],[contenteditable="true"][placeholder*="Tell everyone"]',
    link: '[data-test-id="pin-draft-link"] input,input[id*="pin-draft-link"],input[placeholder="Add a destination link"],input[placeholder="Add a link"],input[aria-label="Link"]',
    altText: '[data-test-id="pin-draft-alt-text"] textarea,textarea[aria-label="Alt text"],textarea[placeholder="Add alt text"],textarea[placeholder*="what people can see"],input[aria-label="Alt text"]',
    board: '[data-test-id="board-dropdown-select-button"],[data-test-id="board-dropdown-button"]',
    boardSearch: 'input[type="search"],input[aria-label="Search boards"],input[placeholder="Search boards"],input[placeholder="Search"]',
    boardRow: '[data-test-id="board-row"],[data-test-id="board-dropdown-item"],[data-test-id="board-selection-item"],[role="option"],[role="menuitem"]',
    boardPanel: '[data-test-id="board-dropdown"],[data-test-id="board-dropdown-select"],[role="listbox"],[role="menu"],[role="dialog"]',

    publish: '[data-test-id="board-dropdown-save-button"],[data-test-id="pin-draft-publish-button"]',
    error: '[role="alert"],[data-test-id="pin-draft-error"],[data-test-id="media-upload-error"],[data-test-id="form-error"],[aria-invalid="true"]',
    progress: '[role="progressbar"],[data-test-id="media-upload-progress"],[aria-busy="true"][data-test-id*="upload"]',
    success: '[role="status"],[role="alert"],[data-test-id="toast"],[data-test-id="pin-published-toast"]',
    challenge: 'iframe[src*="captcha" i],iframe[src*="recaptcha" i],#captcha,[data-test-id*="captcha" i],input[type="password"]',
  };
  const buttons = 'button,[role="button"]';
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const normalizeValue = text => String(text ?? '').replace(/\r\n?/g, '\n');
  const query = (selector, root = document) => [...root.querySelectorAll(selector)];
  const visible = element => element && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible';
  const enabled = element => visible(element) && !element.disabled &&
    !element.closest('[aria-disabled="true"],[inert]');
  const name = element => clean(element.getAttribute('aria-label') || element.innerText);
  const textMatches = (element, expected) => name(element) === expected || clean(element.innerText) === expected;
  const visibleMatches = (selector, root = document) => query(selector, root).filter(visible);
  const one = matches => matches.length === 1 ? matches[0] : undefined;
  const exact = (names, root = document) => one(visibleMatches(buttons, root).filter(item =>
    names.some(expected => textMatches(item, expected))));
  const control = (selector, names) => {
    const direct = [...new Set(visibleMatches(selector).map(item => item.closest(buttons)).filter(Boolean))];
    return direct.length ? one(direct) : exact(names);
  };
  const field = key => one(visibleMatches(selectors[key]));
  const imageInput = () => one(query(selectors.imageInput).filter(item => !item.disabled));
  const boardButton = () => control(selectors.board, ['Board', 'Choose a board', 'Select a board']);
  const publishNames = ['Publish', 'Publish Pin'];
  const publishButton = () => control(selectors.publish, publishNames);
  const read = element => normalizeValue(element.isContentEditable ? element.innerText : element.value);
  const source = image => image?.currentSrc || image?.src || '';
  let interacted = false;

  class AdapterError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const fail = code => { throw new AdapterError(code); };

  function checkPage() {
    if (location.origin !== 'https://www.pinterest.com' ||
        !/^\/pin-(?:creation-tool|builder)(?:\/|$)/.test(location.pathname)) fail('WRONG_PAGE');
    if (visibleMatches(selectors.challenge).length ||
        visibleMatches('h1,h2,[role="heading"],[role="alert"]').some(item =>
          /^(?:log in|sign up|verify (?:that )?you(?:’|'| a)?re human|security check|unusual activity)\b/i.test(name(item)))) {
      fail('CHALLENGE');
    }
  }

  function errorVisible() {
    return visibleMatches(selectors.error).some(element => {
      if (element.matches('[aria-invalid="true"]')) return true;
      const text = clean(element.innerText);
      return Boolean(text && (element.matches('[data-test-id]') ||
        /(?:can't|couldn.t|failed|error|invalid|unsupported|try again|not supported|too large|required|wrong)/i.test(text)));
    });
  }

  function waitFor(readState, code, timeout = 12_000) {
    return new Promise((resolve, reject) => {
      let timer;
      const events = ['load', 'error', 'input', 'change', 'transitionend'];
      const observer = new MutationObserver(check);
      function finish(error, value) {
        clearTimeout(timer);
        observer.disconnect();
        for (const event of events) document.removeEventListener(event, check, true);
        if (error) reject(error);
        else resolve(value);
      }
      function check() {
        try {
          const value = readState();
          if (value) finish(null, value);
        } catch (error) { finish(error); }
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      for (const event of events) document.addEventListener(event, check, true);
      timer = setTimeout(() => finish(new AdapterError(code)), timeout);
      check();
    });
  }

  function setField(element, value, blur = true) {
    element.focus();
    if (element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // Editing command delivers browser input events to rich-text editors.
      if (!document.execCommand(value ? 'insertText' : 'delete', false, value) && read(element) !== value) {
        fail('FIELD_MISMATCH');
      }
      selection.removeAllRanges();
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (blur) element.blur();
  }

  async function populate(key, value) {
    const element = await waitFor(() => { checkPage(); return field(key); }, 'FORM_LAYOUT');
    setField(element, value);
    await waitFor(() => { checkPage(); const current = field(key); return current && read(current) === value; }, 'FIELD_MISMATCH', 4_000);
  }

  function observePreview(input) {
    const ancestors = [];
    for (let region = input.parentElement; region && region !== document.body && ancestors.length < 6;
         region = region.parentElement) ancestors.push(region);
    return () => {
      const known = visibleMatches(selectors.preview);
      if (known.length) return known;
      for (const region of ancestors) {
        if (!region.isConnected || region.querySelector(selectors.title + ',' + selectors.description)) continue;
        const nearby = visibleMatches('img', region).filter(img => /^(blob:|data:image\/|https:\/\/i\.pinimg\.com\/)/.test(source(img)));
        if (nearby.length) return nearby;
      }
      return [];
    };
  }

  function boardTrigger() {
    return waitFor(() => { checkPage(); const button = boardButton(); return enabled(button) && button; }, 'FORM_LAYOUT');
  }

  function openBoardPicker(trigger) {
    const existing = new Set(visibleMatches(selectors.boardPanel));
    trigger.click();
    return () => {
      const explicit = visibleMatches('[data-test-id="board-dropdown"],[data-test-id="board-dropdown-select"],[role="listbox"]');
      return explicit.length ? explicit : visibleMatches(selectors.boardPanel).filter(panel => !existing.has(panel));
    };
  }

  async function listBoards() {
    const panels = openBoardPicker(await boardTrigger());
    return waitFor(() => {
      checkPage();
      const rows = panels().flatMap(panel => visibleMatches(selectors.boardRow, panel)).filter(enabled);
      const names = [...new Set(rows.map(name).filter(value => value && value.length <= 100 &&
        !/^(?:create (?:a )?board|search|close|cancel)$/i.test(value)))];
      return names.length && names.slice(0, 100);
    }, 'BOARD_NOT_FOUND');
  }

  async function selectBoard(expected) {
    expected = clean(expected);
    const trigger = await boardTrigger();
    if (textMatches(trigger, expected)) return trigger;
    const panels = openBoardPicker(trigger);
    let searched = false;
    const option = await waitFor(() => {
      checkPage();
      const openPanels = panels();
      const matches = [...new Set(openPanels.flatMap(panel => visibleMatches(selectors.boardRow + ',button', panel))
        .filter(item => textMatches(item, expected) && enabled(item) &&
          !/^create (?:a )?board$/i.test(name(item))))];
      const leafMatches = matches.filter(item => !matches.some(other => item !== other && item.contains(other)));
      if (leafMatches.length > 1) fail('AMBIGUOUS_BOARD');
      if (!leafMatches.length && !searched) {
        const search = one([...new Set(openPanels.flatMap(panel => visibleMatches(selectors.boardSearch, panel)))]
          .filter(enabled));
        if (search) {
          searched = true;
          setField(search, expected, false);
        }
      }
      return one(leafMatches);
    }, 'BOARD_NOT_FOUND');
    option.click();
    return waitFor(() => {
      checkPage();
      const selected = boardButton() ?? (trigger.isConnected ? trigger :
        one(visibleMatches('button[aria-haspopup],[role="button"][aria-haspopup]').filter(item => textMatches(item, expected))));
      return enabled(selected) && textMatches(selected, expected) && selected;
    }, 'FIELD_MISMATCH');
  }

  async function prepare(image, bytes, fields) {
    checkPage();
    if (interacted) fail('COMPOSER_NOT_CLEAN');
    interacted = true;
    const input = await waitFor(() => { checkPage(); return imageInput(); }, 'FORM_LAYOUT');
    const previews = observePreview(input);
    const existing = new Map(previews().map(img => [img, source(img)]));
    if (input.files?.length || existing.size || ['title', 'description', 'link', 'altText'].some(key => {
      const item = field(key);
      return item && clean(read(item));
    })) fail('COMPOSER_NOT_CLEAN');

    const payload = Uint8Array.fromBase64 ? Uint8Array.fromBase64(bytes) :
      Uint8Array.from(atob(bytes), character => character.charCodeAt(0));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    const digest = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== image.sha256 || payload.length !== image.size) fail('UPLOAD_FAILED');
    checkPage();
    if (!input.isConnected || input.files?.length) fail('COMPOSER_NOT_CLEAN');

    const transfer = new DataTransfer();
    transfer.items.add(new File([payload], image.filename, { type: image.mime }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const preview = await waitFor(() => {
      checkPage();
      if (errorVisible()) fail('UPLOAD_FAILED');
      if (visibleMatches(selectors.progress).length) return null;
      return one(previews().filter(img => img.complete && img.naturalWidth > 0 && source(img) !== existing.get(img)));
    }, 'UPLOAD_TIMEOUT', 45_000);

    await populate('title', fields.title);
    await populate('description', fields.description);
    if (fields.destinationUrl || field('link')) await populate('link', fields.destinationUrl);
    if (!field('altText')) {
      const more = await waitFor(() => { checkPage(); return exact(['More options', 'Add alt text', 'Alt text']); }, 'FORM_LAYOUT');
      more.click();
    }
    if (!field('altText')) {
      const add = exact(['Add alt text']);
      if (add) add.click();
    }
    await populate('altText', fields.altText);
    const selected = await selectBoard(fields.board);
    const proof = { preview, previewSource: source(preview), previews, selected, fields };
    await waitFor(() => verify(proof, false), 'FORM_ERROR');
    return proof;
  }

  function verify({ preview, previewSource, previews, selected, fields }, strict = true) {
    checkPage();
    if (errorVisible()) fail('FORM_ERROR');
    const current = publishButton();
    const board = boardButton() ?? selected;
    const sameImage = preview.isConnected && previews().includes(preview) && source(preview) === previewSource &&
      preview.complete && preview.naturalWidth > 0 && previews().length === 1;
    const checks = { title: fields.title, description: fields.description,
      link: fields.destinationUrl, altText: fields.altText };
    const sameFields = Object.entries(checks).every(([key, value]) => {
      const item = field(key);
      return item ? read(item) === value : key === 'link' && !value;
    });
    if (sameImage && sameFields && enabled(board) && textMatches(board, clean(fields.board)) &&
        !visibleMatches(selectors.progress).length && enabled(current) && publishNames.some(label => textMatches(current, label))) return current;
    if (strict) fail('DRAFT_CHANGED');
    return undefined;
  }

  function successLinks() {
    const links = new Set();
    for (const notice of visibleMatches(selectors.success)) {
      if (!/^(?:you (?:successfully )?(?:created|published|saved) (?:a|your|this) pin|(?:your )?pin (?:was |has been )?(?:published|created|saved)|successfully published)\b/i.test(clean(notice.innerText))) continue;
      for (const link of visibleMatches('a[href]', notice)) {
        if (/^https:\/\/www\.pinterest\.com\/pin\/\d+\/?(?:[?#].*)?$/.test(link.href)) {
          links.add('https://www.pinterest.com' + new URL(link.href).pathname.replace(/\/?$/, '/'));
        }
      }
    }
    return links;
  }

  async function publish(proof) {
    let button;
    let before;
    try { button = verify(proof); before = successLinks(); }
    catch (error) { return { state: 'blocked', code: error.code ?? 'DRAFT_CHANGED', pinUrl: null }; }
    try {
      button.click();
      const pinUrl = await waitFor(() => {
        checkPage();
        const fresh = [...successLinks()].filter(link => !before.has(link));
        if (fresh.length === 1) return fresh[0];
        if (errorVisible()) fail('PINTEREST_ERROR');
        return null;
      }, 'PUBLISH_UNVERIFIED', 22_000);
      return { state: 'published', code: null, pinUrl };
    } catch (error) {
      return { state: 'uncertain', code: error.code ?? 'PUBLISH_UNVERIFIED', pinUrl: null };
    }
  }

  globalThis.pinterestAdapter = { prepare, checkPage, listBoards, publish };
})();
