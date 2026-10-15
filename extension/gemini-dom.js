/**
 * NCode Gemini DOM Integration: DOM selectors, synthetic input, generation monitoring,
 * and automatic subscription model discovery for gemini.google.com.
 */

// Gemini's conversation identity, in one place.
//
// The only helper that used to exist here understood ChatGPT's `/c/<uuid>` shape and nothing
// else, so on `https://gemini.google.com/app/c85317e1183c88b` it either matched nothing or
// returned a stale value, and the worker's `conversationId` was empty for every real Gemini tab.
// Gemini writes the id in two spellings — `/app/<id>` and `/app/c_<id>` — and nests it under a gem
// or a `g/<project>` prefix. Both spellings must normalize to the SAME value or the same
// conversation reads as two different ones after a single navigation.
var GEMINI_CONVERSATION_ID = /^(?:c_)?[0-9a-f-]{8,64}$/i;
var GEMINI_CONVERSATION_PATH =
  /^\/(?:app|gem\/[^/]+|(?:g\/[^/]+\/)?c)\/((?:c_)?[0-9a-f-]{8,64})(?:\/|$)/i;

/**
 * Accepts only a conversation id, in either Gemini spelling, and returns it without the prefix.
 *
 * `c_c85317e1183c88b` and `c85317e1183c88b` are one conversation, so returning the raw match
 * would make the same chat look like a second one the moment the SPA rewrote the URL.
 */
function cleanConversationId(value) {
  var text = String(value == null ? '' : value).trim();
  if (!GEMINI_CONVERSATION_ID.test(text)) return '';
  return text.replace(/^c_/i, '');
}

/** The conversation id in a Gemini pathname, or `''` for the home page and every non-chat route. */
function conversationFromPathname(pathname) {
  try {
    var match = GEMINI_CONVERSATION_PATH.exec(String(pathname == null ? '' : pathname));
    return match ? cleanConversationId(match[1]) : '';
  } catch (err) {
    return '';
  }
}

/**
 * The pathname of the current document, or `''` where there is no readable location.
 *
 * Read through `globalThis` and each hop is guarded: this file also runs in test sandboxes and in
 * the built-in browser's worker preload, where `location` can be absent entirely, and a throw here
 * would take every caller of the Gemini identity with it.
 */
function currentPathname() {
  var href = '';
  try {
    var loc = typeof globalThis !== 'undefined' && globalThis.location ? globalThis.location : null;
    // Some hosts hand this file a `window` that is not `globalThis` (worker preloads, the test
    // sandboxes), so the second read is not redundant here.
    if (!loc && typeof globalThis !== 'undefined' && globalThis.window) loc = globalThis.window.location;
    if (loc && typeof loc.pathname === 'string' && loc.pathname) return loc.pathname;
    if (loc && typeof loc.href === 'string') href = loc.href;
  } catch (err) {
    href = '';
  }
  if (href) {
    try { return new URL(href).pathname; } catch (err) { /* fall through to the manual strip */ }
    // A relative or otherwise unparsable href still carries its path after the origin.
    var slash = href.indexOf('/', href.indexOf('://') + 3);
    if (slash > -1) return href.slice(slash).split('?')[0].split('#')[0];
  }
  return '';
}

// `var`, not `const`: the manifest injects this file AND `background.js` re-injects it when it
// repairs a tab, in the same ISOLATED world. Re-declaring a top-level `const` there is a
// SyntaxError (`Identifier 'GeminiDOM' has already been declared`) that kills the whole
// content_scripts array, taking ncode-content.js down with it.
var GeminiDOM = {
  /**
   * Targets Gemini's rich text editor.
   * Primary: rich-textarea div[contenteditable="true"]
   * Fallback: div[role="textbox"]
   */
  getEditor() {
    return document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div[role="textbox"]');
  },

  /**
   * Targets the Send message button.
   */
  getSendButton() {
    return document.querySelector('button[aria-label*="Send message" i]') ||
      document.querySelector('button[aria-label*="Send" i]') ||
      document.querySelector('button.send-button');
  },

  /**
   * Targets the Stop streaming / generating button.
   */
  getStopButton() {
    return document.querySelector('button[aria-label*="Stop response" i]') ||
      document.querySelector('button[aria-label*="Stop streaming" i]') ||
      document.querySelector('button[aria-label*="Stop generating" i]') ||
      document.querySelector('button[aria-label*="Stop" i]');
  },

  /**
   * Targets the New Chat link or button.
   */
  getNewChatButton() {
    return document.querySelector('a[href="/app"]') ||
      document.querySelector('a[data-test-id="new-chat-button"]') ||
      document.querySelector('button[aria-label*="New chat" i]') ||
      document.querySelector('a[aria-label*="New chat" i]');
  },

  /**
   * Generation state: true when Stop button is mounted; false when Stop unmounts and Send is ready.
   */
  isGenerating() {
    const stop = this.getStopButton();
    return Boolean(stop && (stop.offsetParent !== null || stop.isConnected));
  },

  /**
   * Injects text into Gemini's rich text editor using execCommand followed by
   * synthetic InputEvent and change event so Lit / Angular state synchronizes.
   */
  injectText(text) {
    const editor = this.getEditor();
    if (!editor) return false;

    editor.focus();

    // Select existing contents
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // ignore selection error
    }

    // Insert text via execCommand
    let success = false;
    try {
      success = document.execCommand('insertText', false, text);
    } catch {
      success = false;
    }

    if (!success || !editor.textContent?.includes(text.slice(0, 20))) {
      editor.textContent = text;
    }

    // Dispatch synthetic InputEvent
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    // Dispatch synthetic change event
    editor.dispatchEvent(new Event('change', { bubbles: true }));

    // Notify parent rich-textarea if present
    const richParent = editor.closest('rich-textarea');
    if (richParent) {
      richParent.dispatchEvent(new Event('input', { bubbles: true }));
      richParent.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return true;
  },

  /**
   * Clicks Send message button with Enter key fallback.
   */
  submit() {
    const sendBtn = this.getSendButton();
    if (sendBtn && !sendBtn.disabled && (sendBtn.getAttribute('aria-disabled') !== 'true')) {
      sendBtn.click();
      return true;
    }

    // Fallback: Dispatch Enter keydown & keyup on editor
    const editor = this.getEditor();
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      editor.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      return true;
    }

    return false;
  },

  /**
   * Model and mode discovery, from what the picker actually shows.
   *
   * Only observed titles reach the desktop. This used to answer with a fabricated `gemini-auto`
   * / "Gemini Web" / `gemini-default` whenever the picker could not be read, which named model
   * identities Gemini never displayed; the desktop's own catalog in `src/shared/chat-models.ts`
   * is the one place allowed to hold a fallback, so a picker this cannot read now returns no
   * models at all and lets the host keep that fallback of its own.
   */
  async discoverModels() {
    // Gemini has moved this control between a custom element, data-test-id hooks and Material
    // panels, and a header picker and a composer picker can both exist on one page. Collect from
    // every one of them, then let the id dedupe and the first-seen order decide the list.
    const PICKERS = [
      'bard-mode-switcher',
      '[data-test-id="bard-mode-menu-button"]',
      '[data-test-id*="mode"]'
    ];
    const MENU_ITEMS = [
      '.mat-mdc-menu-panel [role^="menuitem"]',
      '.mat-mdc-menu-panel mat-option',
      '.mat-mdc-select-panel [role^="menuitem"]',
      '.mat-mdc-select-panel mat-option',
      '[role="menuitemradio"]',
      'mat-option[role]'
    ];
    // A menu this large or this wordy is not the model list; it is a runaway panel, and the
    // desktop must not be handed 300 rows it has to store and translate.
    const MAX_MODELS = 24;
    const MAX_TEXT = 120;

    const clip = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const firstOf = (selectors) => {
      for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found) return found;
      }
      return null;
    };
    const modelId = (label) => clip(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const picker = firstOf(PICKERS);
    const button = picker
      ? picker.querySelector('button, [role="button"], [role="combobox"]') || picker
      : null;

    // The selected model is readable from the picker itself, with no menu open at all. Reading it
    // here is what makes `activeModel` available on a page whose menu refuses to render.
    let activeLabel = picker
      ? clip(
        (picker.querySelector('[aria-selected="true"], [aria-checked="true"], .mat-mdc-button-toggle-checked')
          || picker).textContent
      )
      : '';

    const models = [];

    // Open the menu and read what it lists.
    if (button) {
      try {
        button.click();
      } catch {
        // A picker that refuses to open leaves `activeLabel` above as the only truth available.
      }
      await new Promise((resolve) => setTimeout(resolve, 80));

      const items = MENU_ITEMS.flatMap((selector) => {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      });

      const seen = new Set();
      for (const item of items) {
        if (seen.size >= MAX_MODELS) break;
        if (item.hasAttribute('disabled') ||
            item.getAttribute('aria-disabled') === 'true' ||
            item.classList.contains('disabled')) continue;

        // Gemini renders a menu item's title and its subtitle as separate block children, so
        // `innerText` breaks them onto their own lines. Where it arrives as one line anyway, the
        // item's own children are the same split: first child is the name, the rest is the blurb.
        const rendered = typeof item.innerText === 'string' ? item.innerText : String(item.textContent || '');
        const raw = rendered.trim();
        let lines = rendered.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines.length < 2) {
          const parts = Array.from(item.childNodes)
            .map((node) => String(node.textContent || '').trim())
            .filter(Boolean);
          if (parts.length > 1) lines = parts;
        }
        const label = clip(item.getAttribute('aria-label') || lines[0] || '');
        const description = clip(lines.slice(1).join(' '));
        if (!label) continue;
        // "Upgrade to Gemini Advanced" is an offer, not a model this account can run.
        if (/upgrade|subscribe|get\s+advanced/i.test(raw) && item.getAttribute('aria-checked') !== 'true') continue;

        const id = modelId(label);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const isActive = item.getAttribute('aria-checked') === 'true' ||
          item.getAttribute('aria-selected') === 'true' ||
          item.classList.contains('mat-mdc-menu-item-highlighted') ||
          (Boolean(activeLabel) && label === activeLabel);
        if (isActive) activeLabel = label;

        models.push({ id, label, description });
      }

      // Close the menu the way it was found: by escape and by re-clicking its trigger.
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        button.click();
      } catch {
        // ignore
      }
    }

    // The picker button already named the selected model even when no menu item claimed it, so
    // an unreadable menu still reports the model actually in use.
    const active = models.find((model) => model.isActive);
    return {
      activeModel: active ? active.id : (modelId(activeLabel) || null),
      models: models.map((model) => ({ id: model.id, label: model.label, description: model.description }))
    };
  },

  /**
   * Switches the active model by opening the mode switcher and clicking the target menu item.
   */
  async switchModel(targetModelId) {
    const switcher = document.querySelector('bard-mode-switcher');
    if (!switcher) return false;

    const button = switcher.querySelector('button') || switcher;
    button.click();

    await new Promise((resolve) => setTimeout(resolve, 80));

    const menuItems = Array.from(document.querySelectorAll('.mat-mdc-menu-panel [role^="menuitem"], [role="menuitem"]'));
    const normalizedTarget = targetModelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const target = menuItems.find(item => {
      const fullText = (item.textContent || '').trim().toLowerCase();
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const label = lines[0] || '';
      const id = label.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return id === normalizedTarget ||
        id.replace(/-/g, '') === normalizedTarget.replace(/-/g, '') ||
        fullText.includes(targetModelId.toLowerCase().replace(/-/g, ' '));
    });

    if (target) {
      target.click();
      return true;
    }

    // Close menu
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  },

  /**
   * Programmatically navigates or clicks Gemini's "New chat" button.
   */
  newChat() {
    const btn = this.getNewChatButton();
    if (btn) {
      btn.click();
      return true;
    }
    window.location.href = 'https://gemini.google.com/app';
    return true;
  },

  /**
   * Extracts the text of the latest assistant message.
   */
  getLatestAssistantText() {
    const responses = document.querySelectorAll('model-response, .model-response, message-content, .message-content, [data-message-author-role="model"]');
    if (!responses.length) return '';
    const latest = responses[responses.length - 1];
    return (latest.innerText || latest.textContent || '').trim();
  },

  /**
   * The conversation this document is showing, normalized, or `null` on the home page.
   *
   * This is the identity every consumer needs (`clf-page-status`, the `bind` message, Compact &
   * Resume), so it lives on the object rather than being re-derived per caller. `null` is the
   * honest answer for `https://gemini.google.com/app` — an id-less New Chat page is not a
   * conversation, and reading one out of the URL would bind the worker's state to a chat that does
   * not exist yet. A page with no readable `location` answers `null` rather than throwing.
   */
  getConversationIdFromUrl() {
    try {
      return conversationFromPathname(currentPathname()) || null;
    } catch (err) {
      return null;
    }
  }
};

// Content scripts run in a classic script world, so these objects are published on globalThis
// for ncode-content.js. An `export` statement here would be a SyntaxError in MV3 and would
// take the whole content_scripts js array down with it.
if (typeof globalThis !== 'undefined') {
  globalThis.GeminiDOM = GeminiDOM;
}

/**
 * The `CLF_DOM` bridge.
 *
 * `content.js` and `chatgpt-dom.js` are the legacy ChatGPT recorder, and `content.js` calls
 * `CLF_DOM.*` sixty-odd times. It used to get that object from `chatgpt-dom.js`, which the
 * Gemini injection path never loaded, so a Gemini tab threw `ReferenceError: CLF_DOM is not
 * defined` and the whole recorder died. This bridge supplies the same contract against the real
 * Google Gemini DOM so that code never throws, whether or not the legacy recorder is still
 * reached.
 *
 * Every member runs through `safe()`, so a Gemini page that renames an element yields a
 * fallback rather than an exception. That is the whole point: `CLF_DOM.xyz` must never be
 * `undefined` and must never be a non-function.
 */
var CLF_DOM = (function () {
  var TURN = 'model-response, .model-response, message-content, .message-content, [data-message-author-role="model"]';
  var USER_TURN = '.user-query-container, [data-message-author-role="user"], query-text, .query-text';
  var COMPOSER = 'rich-textarea div[contenteditable="true"], rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], div[role="textbox"]';
  var SEND = 'button[aria-label*="Send message" i], button[aria-label*="Send" i], button.send-button';
  var STOP = 'button[aria-label*="Stop" i], button[aria-label*="Stop generating" i]';
  var NEW_CHAT = 'a[href="/app"], a[data-test-id="new-chat-button"], button[aria-label*="New chat" i]';

  /** Run `fn` and fall back rather than throwing, so no caller ever dies on a missing node. */
  function safe(fn, fallback) {
    try {
      var value = fn();
      return value === undefined ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function textOf(node) {
    if (!node) return '';
    return (node.innerText || node.textContent || '').trim();
  }

  function list(selector) {
    return safe(function () {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    }, []);
  }

  function one(selector) {
    return safe(function () {
      return document.querySelector(selector);
    }, null);
  }

  function composerNode() {
    return one(COMPOSER);
  }

  function sendNode() {
    return one(SEND);
  }

  function stopNode() {
    return one(STOP);
  }

  function turnNodes() {
    return list(TURN);
  }

  function isGeneratingNow() {
    if (stopNode()) return true;
    var responses = turnNodes();
    var last = responses[responses.length - 1];
    return !!(last && last.getAttribute('data-generating') === 'true');
  }

  function conversationIdNow() {
    return safe(function () {
      return conversationFromPathname(currentPathname());
    }, '');
  }

  function ensureText(target, value) {
    var node = target || composerNode();
    if (!node) return false;
    node.focus();
    try {
      document.execCommand('selectAll', false, undefined);
      document.execCommand('insertText', false, value);
    } catch (err) {
      node.textContent = value;
    }
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function submitNow() {
    var send = sendNode();
    if (send) {
      send.click();
      return true;
    }
    var editor = composerNode();
    if (!editor) return false;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  }

  /**
   * A turn's stable identity, hoisted out of the returned object on purpose.
   *
   * `messageIdOf` needs the same answer, and reaching for `this.turnIdOf` would make both members
   * throw the moment a caller destructures them off the bridge - the legacy `chatgpt-dom.js` has no
   * `this` anywhere for exactly that reason, and a getter that can throw defeats the whole point
   * of the `safe` wrapper.
   */
  function turnIdOfNow(node) {
    return safe(function () {
      if (!node) return '';
      return node.id || node.getAttribute('data-message-id') || node.getAttribute('data-test-id') || '';
    }, '');
  }

  return {
    TURN_SELECTOR: TURN,
    AUTHORED_SELECTOR: 'rich-textarea [contenteditable="true"], [data-message-author-role="user"] .markdown',

    turnIdOf: function (node) {
      return turnIdOfNow(node);
    },
    messageIdOf: function (node) {
      return turnIdOfNow(node);
    },
    composerAuthoredText: function () {
      return safe(function () { return textOf(composerNode()); }, '');
    },
    userPromptText: function (node) {
      return safe(function () { return textOf(node || list(USER_TURN)[0]); }, '');
    },
    userMessageReaction: function () {
      return safe(function () {
        var btn = one(`${USER_TURN} button, [data-message-author-role="user"] button`);
        return btn ? btn.getAttribute('aria-label') || '' : '';
      }, '');
    },
    presentUserPrompts: function () {
      return safe(function () {
        return list(USER_TURN).map(function (node) {
          return textOf(node);
        }).filter(Boolean);
      }, []);
    },
    composerVisible: function () {
      return safe(function () {
        var node = composerNode();
        if (!node) return false;
        var rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, false);
    },
    conversationLoadFailure: function () {
      return safe(function () {
        var error = one('[role="alert"], .error-message, .loading-error');
        return error ? textOf(error) : '';
      }, '');
    },
    prepareChatModelSurface: function () {
      return safe(function () {
        var switcher = one('bard-mode-switcher, [jsname="UcEHOf"]');
        return !!switcher;
      }, false);
    },
    modelPickerReadable: function () {
      return safe(function () {
        return !!one('bard-mode-switcher [role="button"], bard-mode-switcher');
      }, false);
    },
    newChatControl: function () {
      return safe(function () { return one(NEW_CHAT); }, null);
    },
    projectCreateControl: function () {
      return safe(function () {
        return one('a[href*="/project-create"], button[aria-label*="New project" i]');
      }, null);
    },
    projectCreateForm: function () {
      return safe(function () {
        return one('[role="dialog"] input[type="text"], [role="dialog"] input');
      }, null);
    },
    revealSidebar: function () {
      return safe(function () {
        var toggle = one('button[aria-label*="Hide side" i], button[aria-label*="menu" i]');
        if (toggle) toggle.click();
        return !!toggle;
      }, false);
    },
    projectIdsShown: function () {
      return safe(function () {
        return list('a[href^="/project/"]').map(function (a) {
          var m = a.getAttribute('href').match(/^\/project\/([A-Za-z0-9_-]+)/);
          return m ? m[1] : '';
        }).filter(Boolean);
      }, []);
    },
    fillProjectName: function (name) {
      return safe(function () {
        var input = one('[role="dialog"] input[type="text"], [role="dialog"] input');
        if (!input) return false;
        input.focus();
        input.value = String(name || '');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(name || '') }));
        return true;
      }, false);
    },
    projectHomeId: function () {
      return safe(function () {
        var m = (window.location.pathname || '').match(/^\/project\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
      }, '');
    },
    enterProject: function (id) {
      return safe(function () {
        window.location.href = `https://gemini.google.com/project/${id}`;
        return true;
      }, false);
    },
    visibleModelSelection: function () {
      return safe(function () {
        var switcher = one('bard-mode-switcher [role="button"], bard-mode-switcher');
        return textOf(switcher);
      }, '');
    },
    inspectModelSettings: function () {
      return safe(function () {
        return { model: textOf(one('bard-mode-switcher [role="button"]')) };
      }, {});
    },
    uploadImages: function (files) {
      return safe(function () {
        var input = one('input[type="file"][accept*="image"]');
        if (!input || !files || !files.length) return false;
        input.files = files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, false);
    },
    captureComposerDraft: function () {
      return safe(function () { return textOf(composerNode()); }, '');
    },
    hasComposerAttachments: function () {
      return safe(function () {
        return !!one('rich-textarea [data-test-id="attachment"], rich-textarea img');
      }, false);
    },
    composerAttachmentNames: function () {
      return safe(function () {
        return list('rich-textarea [data-test-id="attachment"]').map(textOf).filter(Boolean);
      }, []);
    },
    pluginRefreshView: function () {
      return safe(function () {
        return !!one('[role="dialog"]');
      }, false);
    },
    setConnectorNames: function () { return safe(function () { return true; }, false); },
    setConnectorApps: function () { return safe(function () { return true; }, false); },
    connectorApps: function () { return safe(function () { return []; }, []); },
    connectorNames: function () { return safe(function () { return []; }, []); },
    pluginInstalledButtons: function () {
      return safe(function () {
        return list('[role="dialog"] button').filter(function (b) {
          return /install|installed/i.test(b.getAttribute('aria-label') || textOf(b));
        });
      }, []);
    },
    pluginManagementIdle: function () {
      return safe(function () { return true; }, true);
    },
    selectModelSettings: function (modelId) {
      return safe(function () {
        return safe(function () {
          return window.GeminiDOM.switchModel(modelId);
        }, false);
      }, false);
    },
    temporaryChatReady: function () {
      return safe(function () {
        var icon = one('svg use[href="#chat-temp-checked"], [data-test-id="temporary-chat"]');
        return !!icon;
      }, false);
    },
    confirmTemporaryChatIntroduction: function () {
      return safe(function () {
        var btn = one('button[aria-label*="Temporary" i], button[aria-label*="Confirm" i]');
        if (btn) btn.click();
        return !!btn;
      }, false);
    },
    conversationId: function () { return conversationIdNow(); },
    conversationFromPath: function (pathname) {
      return safe(function () {
        return conversationFromPathname(pathname);
      }, '');
    },
    conversationIdFromUrl: function () {
      return safe(function () {
        return conversationFromPathname(currentPathname()) || null;
      }, null);
    },
    conversationTitle: function () {
      return safe(function () {
        return textOf(one('bard-chat-title, .conversation-title, h1'));
      }, '');
    },
    turns: function () { return safe(function () { return turnNodes(); }, []); },
    presentationTurns: function () { return safe(function () { return turnNodes(); }, []); },
    messages: function () {
      return safe(function () {
        return list(USER_TURN).concat(turnNodes()).map(textOf).filter(Boolean);
      }, []);
    },
    messagesIn: function (turn) {
      return safe(function () { return [textOf(turn)]; }, []);
    },
    sectionSignature: function (node) {
      return safe(function () {
        return `${textOf(node).length}:${textOf(node).slice(0, 32)}`;
      }, '');
    },
    generating: function () { return isGeneratingNow(); },
    approvalWaiting: function () {
      return safe(function () {
        return !!one('button[aria-label*="Approve" i], [data-test-id="approval-request"]');
      }, false);
    },
    stopButton: function () { return safe(function () { return stopNode(); }, null); },
    stopGeneration: function (current) {
      return safe(function () {
        var btn = stopNode();
        if (btn) btn.click();
        return !!btn;
      }, false);
    },
    sendButton: function () { return safe(function () { return sendNode(); }, null); },
    progressLine: function () {
      return safe(function () { return textOf(one('[role="status"], .progress-line')); }, '');
    },
    progressItems: function () {
      return safe(function () { return list('[role="status"] li, .progress-line li').map(textOf); }, []);
    },
    interrupted: function (turn) {
      return safe(function () { return /stopped|interrupted/i.test(textOf(turn)); }, false);
    },
    markProgress: function (turn, text) {
      return safe(function () {
        if (!turn) return false;
        turn.setAttribute('data-clf-progress', String(text || ''));
        return true;
      }, false);
    },
    toolBlocks: function () {
      return safe(function () { return list('[data-clf-tool], pre'); }, []);
    },
    activityItems: function () {
      return safe(function () { return list('details, .activity-item'); }, []);
    },
    isConnectorBlock: function (node) {
      return safe(function () { return !!(node && /connector|app/i.test(textOf(node))); }, false);
    },
    markLocalBlock: function (node) {
      return safe(function () {
        if (node) node.setAttribute('data-clf-local', 'true');
        return !!node;
      }, false);
    },
    hasConnectorRow: function () { return safe(function () { return connectorNames().length > 0; }, false); },
    connectorRows: function () {
      return safe(function () { return list('[data-test-id="connector-row"]'); }, []);
    },
    fiberRef: function () { return safe(function () { return window.Fiber; }, null); },
    activitySummaryRows: function () { return safe(function () { return list('details > summary'); }, []); },
    thoughtActivityRows: function () {
      return safe(function () {
        return list('details > summary').filter(function (n) { return /think|thought/i.test(textOf(n)); });
      }, []);
    },
    toolLabel: function (node) { return safe(function () { return textOf(node); }, ''); },
    errors: function () {
      return safe(function () {
        return list('[role="alert"], .error-message').map(textOf).filter(Boolean);
      }, []);
    },
    composer: function () { return safe(function () { return composerNode(); }, null); },
    composerSubmitReady: function () {
      return safe(function () {
        var btn = sendNode();
        return !!btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true';
      }, false);
    },
    clearRevivalResidue: function () {
      return safe(function () {
        var count = document.querySelectorAll('[data-clf-revival]').length;
        document.querySelectorAll('[data-clf-revival]').forEach(function (n) { n.remove(); });
        return count;
      }, 0);
    },
    composerWritable: function () {
      return safe(function () {
        var node = composerNode();
        return !!node && node.getAttribute('contenteditable') !== 'false';
      }, false);
    },
    composerBox: function () {
      return safe(function () {
        var node = composerNode();
        if (!node) return null;
        var rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, null);
    },
    pageTheme: function () {
      return safe(function () {
        return document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light';
      }, 'light');
    },
    composerActions: function () {
      return safe(function () { return list('rich-textarea button'); }, []);
    },
    composerStack: function () {
      return safe(function () { return one('rich-textarea'); }, null);
    },
    firstUserMessage: function () {
      return safe(function () { return textOf(list(USER_TURN)[0]); }, '');
    },
    hideProgress: function () { return safe(function () { return true; }, false); },
    hideActivity: function (turn) {
      return safe(function () {
        if (!turn) return false;
        turn.setAttribute('data-clf-hidden', 'true');
        return true;
      }, false);
    },
    activityFold: function (node) {
      return safe(function () {
        if (node && node.tagName === 'DETAILS') node.open = false;
        return !!node;
      }, false);
    },
    collapsedActivityFold: function (node) {
      return safe(function () { return !!(node && node.tagName === 'DETAILS' && !node.open); }, false);
    },
    canHideActivity: function (turn) {
      return safe(function () { return !!turn; }, false);
    },
    replaceActivity: function (turn, html) {
      return safe(function () {
        if (!turn) return false;
        turn.innerHTML = String(html || '');
        return true;
      }, false);
    },
    insertPrompt: function (text) { return safe(function () { return ensureText(composerNode(), text); }, false); },
    clearPromptExact: function () { return safe(function () { return ensureText(composerNode(), ''); }, false); },
    send: function (text) {
      return safe(function () {
        if (typeof text === 'string' && text) ensureText(composerNode(), text);
        return submitNow();
      }, false);
    }
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.CLF_DOM = CLF_DOM;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeminiDOM;
  module.exports.default = GeminiDOM;
  module.exports.GeminiDOM = GeminiDOM;
  module.exports.CLF_DOM = CLF_DOM;
}
