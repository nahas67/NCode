/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
// @ts-ignore
import { GeminiDOM } from '../extension/gemini-dom.js';

describe('GeminiDOM integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('targets rich-textarea contenteditable editor with fallback', () => {
    document.body.innerHTML = `
      <rich-textarea>
        <div contenteditable="true" role="textbox"></div>
      </rich-textarea>
    `;
    const editor = GeminiDOM.getEditor();
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('contenteditable')).toBe('true');
  });

  it('injects text with synthetic input and change events', () => {
    document.body.innerHTML = `
      <rich-textarea>
        <div contenteditable="true" role="textbox"></div>
      </rich-textarea>
    `;
    let inputFired = false;
    let changeFired = false;

    const editor = GeminiDOM.getEditor()!;
    editor.addEventListener('input', () => { inputFired = true; });
    editor.addEventListener('change', () => { changeFired = true; });

    const success = GeminiDOM.injectText('Hello from NCode');
    expect(success).toBe(true);
    expect(editor.textContent).toContain('Hello from NCode');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it('targets Send button and triggers click or Enter fallback', () => {
    let sent = false;
    document.body.innerHTML = `
      <rich-textarea>
        <div contenteditable="true"></div>
      </rich-textarea>
      <button aria-label="Send message">Send</button>
    `;
    const btn = GeminiDOM.getSendButton()!;
    btn.addEventListener('click', () => { sent = true; });

    const submitted = GeminiDOM.submit();
    expect(submitted).toBe(true);
    expect(sent).toBe(true);
  });

  it('detects active generation state from Stop button presence', () => {
    document.body.innerHTML = `
      <button aria-label="Send message">Send</button>
    `;
    expect(GeminiDOM.isGenerating()).toBe(false);

    document.body.innerHTML = `
      <button aria-label="Stop response">Stop</button>
    `;
    expect(GeminiDOM.isGenerating()).toBe(true);
  });

  it('discovers models from bard-mode-switcher and filters out locked upgrade tiers', async () => {
    document.body.innerHTML = `
      <bard-mode-switcher>
        <button>Gemini 1.5 Pro</button>
      </bard-mode-switcher>
      <div class="mat-mdc-menu-panel">
        <button role="menuitem" aria-checked="true">
          <div>Gemini 1.5 Pro</div>
          <div>Complex reasoning and coding</div>
        </button>
        <button role="menuitem">
          <div>Gemini 1.5 Flash</div>
          <div>Fast responses for daily tasks</div>
        </button>
        <button role="menuitem" aria-disabled="true">
          <div>Gemini Ultra (Upgrade to Advanced)</div>
          <div>Upgrade required</div>
        </button>
      </div>
    `;

    const discovery = await GeminiDOM.discoverModels();
    expect(discovery.models).toHaveLength(2);
    expect(discovery.models.map((m: any) => m.id)).toEqual(['gemini-1-5-pro', 'gemini-1-5-flash']);
    expect(discovery.activeModel).toBe('gemini-1-5-pro');
  });

  it('switches model by clicking matching menu item', async () => {
    let clickedFlash = false;
    document.body.innerHTML = `
      <bard-mode-switcher>
        <button>Gemini 1.5 Pro</button>
      </bard-mode-switcher>
      <div class="mat-mdc-menu-panel">
        <button role="menuitem" id="btn-pro">
          <div>Gemini 1.5 Pro</div>
        </button>
        <button role="menuitem" id="btn-flash">
          <div>Gemini 1.5 Flash</div>
        </button>
      </div>
    `;

    document.getElementById('btn-flash')!.addEventListener('click', () => {
      clickedFlash = true;
    });

    const switched = await GeminiDOM.switchModel('gemini-1-5-flash');
    expect(switched).toBe(true);
    expect(clickedFlash).toBe(true);
  });
});
