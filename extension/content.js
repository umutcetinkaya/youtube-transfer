// YouTube Studio Content Script - Auto Upload Helper

let pendingUpload = null;
let videoIndex = null;
let isProcessing = false;

console.log('[YT Transfer] Content script loaded');

// Check for pending upload
async function checkPendingUpload() {
  try {
    const data = await chrome.storage.local.get(['pendingUpload', 'videoIndex']);

    if (data.pendingUpload && !isProcessing) {
      pendingUpload = data.pendingUpload;
      videoIndex = data.videoIndex;
      console.log('[YT Transfer] Found pending upload:', pendingUpload.title);
      showHelper();
      startAutoProcess();
    }
  } catch (err) {
    console.error('[YT Transfer] Error:', err);
  }
}

// Show helper overlay
function showHelper() {
  const existing = document.getElementById('yt-transfer-helper');
  if (existing) existing.remove();

  const helper = document.createElement('div');
  helper.id = 'yt-transfer-helper';
  helper.innerHTML = `
    <div class="yt-transfer-header">
      <span>📤 YouTube Transfer</span>
      <button id="yt-transfer-close">✕</button>
    </div>
    <div class="yt-transfer-content">
      <div class="yt-transfer-video">
        <strong>${escapeHtml(pendingUpload.title)}</strong>
        ${pendingUpload.isShort ? '<span class="yt-transfer-badge">SHORTS</span>' : ''}
      </div>
      <div class="yt-transfer-status" id="yt-transfer-status">
        ⏳ Starting...
      </div>
      <div class="yt-transfer-filepath" id="yt-transfer-filepath">
        📁 ${escapeHtml(pendingUpload.filePath)}
      </div>
      <button id="yt-transfer-action" class="yt-transfer-btn">
        🚀 Auto Upload
      </button>
    </div>
  `;

  document.body.appendChild(helper);

  document.getElementById('yt-transfer-close').addEventListener('click', finishUpload);
  document.getElementById('yt-transfer-action').addEventListener('click', startAutoProcess);
}

function updateStatus(text, color = '#3ea6ff') {
  const status = document.getElementById('yt-transfer-status');
  if (status) {
    status.textContent = text;
    status.style.color = color;
  }
}

// Main auto process
async function startAutoProcess() {
  if (isProcessing) return;
  isProcessing = true;

  const actionBtn = document.getElementById('yt-transfer-action');
  if (actionBtn) actionBtn.disabled = true;

  try {
    // Step 1: Click upload button if on main page
    updateStatus('⏳ Looking for upload button...');

    const uploadBtn = await waitForElement('ytcp-button#upload-icon', 3000).catch(() => null)
      || document.querySelector('[id="upload-icon"]')
      || document.querySelector('ytcp-icon-button[id="upload-icon"]');

    if (uploadBtn) {
      uploadBtn.click();
      updateStatus('⏳ Waiting for upload dialog...');
      await sleep(1000);
    }

    // Step 2: Click "Select files" button
    updateStatus('⏳ Looking for file selector...');

    const selectFilesBtn = await waitForElement('#select-files-button', 5000).catch(() => null)
      || document.querySelector('ytcp-button#select-files-button');

    if (selectFilesBtn) {
      // Copy filepath to clipboard first
      await copyToClipboard(pendingUpload.filePath);

      updateStatus('📋 File path copied! Use Cmd+Shift+G in Finder to paste', '#ffcc00');

      // Show the filepath prominently
      const filepathEl = document.getElementById('yt-transfer-filepath');
      if (filepathEl) {
        filepathEl.style.background = '#ffcc00';
        filepathEl.style.color = '#000';
        filepathEl.style.padding = '8px';
        filepathEl.style.borderRadius = '4px';
        filepathEl.style.fontWeight = 'bold';
      }

      selectFilesBtn.click();
    }

    // Step 3: Watch for metadata form and auto-fill
    watchForMetadataForm();

  } catch (err) {
    console.error('[YT Transfer] Error:', err);
    updateStatus('❌ Error: ' + err.message, '#e74c3c');
    isProcessing = false;
  }
}

// Watch for metadata form to appear
function watchForMetadataForm() {
  const observer = new MutationObserver(async (mutations) => {
    const titleInput = document.querySelector('#textbox[aria-label*="title"]')
      || document.querySelector('ytcp-social-suggestions-textbox[id="title-textarea"] #textbox')
      || document.querySelector('#title-textarea #textbox');

    if (titleInput && pendingUpload) {
      observer.disconnect();
      await sleep(500);
      await fillAllMetadata();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const checkInterval = setInterval(async () => {
    const titleInput = document.querySelector('#textbox[aria-label*="title"]')
      || document.querySelector('ytcp-social-suggestions-textbox[id="title-textarea"] #textbox')
      || document.querySelector('#title-textarea #textbox');

    if (titleInput && pendingUpload && !titleInput.dataset.filled) {
      clearInterval(checkInterval);
      await sleep(500);
      await fillAllMetadata();
    }
  }, 1000);

  setTimeout(() => {
    observer.disconnect();
    clearInterval(checkInterval);
  }, 120000);
}

// Fill all metadata
async function fillAllMetadata() {
  updateStatus('⏳ Filling metadata...');

  try {
    // Title
    const titleInput = document.querySelector('ytcp-social-suggestions-textbox[id="title-textarea"] #textbox')
      || document.querySelector('#title-textarea #textbox')
      || document.querySelector('#textbox[aria-label*="title"]');

    if (titleInput) {
      titleInput.textContent = '';
      await sleep(100);
      titleInput.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, pendingUpload.title);
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dataset.filled = 'true';
      console.log('[YT Transfer] Title filled');
    }

    await sleep(300);

    // Description
    const descInput = document.querySelector('ytcp-social-suggestions-textbox[id="description-textarea"] #textbox')
      || document.querySelector('#description-textarea #textbox')
      || document.querySelectorAll('ytcp-social-suggestions-textbox #textbox')[1];

    if (descInput && pendingUpload.description) {
      descInput.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, pendingUpload.description);
      descInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[YT Transfer] Description filled');
    }

    await sleep(300);

    // Click "Show more" for tags
    const showMoreBtn = document.querySelector('ytcp-button#toggle-button')
      || document.querySelector('button[aria-label="Show more"]');

    if (showMoreBtn) {
      showMoreBtn.click();
      await sleep(500);
    }

    // Tags
    if (pendingUpload.tags && pendingUpload.tags.length > 0) {
      const tagsInput = document.querySelector('input.ytcp-chip-bar')
        || document.querySelector('input[aria-label="Tags"]')
        || document.querySelector('ytcp-form-input-container input');

      if (tagsInput) {
        const tagsStr = pendingUpload.tags.slice(0, 30).join(',');
        tagsInput.focus();
        tagsInput.value = tagsStr;
        tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
        tagsInput.dispatchEvent(new Event('change', { bubbles: true }));
        tagsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        console.log('[YT Transfer] Tags filled');
      }
    }

    updateStatus('✅ Metadata filled! You can now publish.', '#2ecc71');

    const actionBtn = document.getElementById('yt-transfer-action');
    if (actionBtn) {
      actionBtn.textContent = '✅ Done - Publish Now';
      actionBtn.disabled = false;
      actionBtn.onclick = () => clickPublishButtons();
    }

  } catch (err) {
    console.error('[YT Transfer] Fill error:', err);
    updateStatus('❌ Error: ' + err.message, '#e74c3c');
  }
}

// Try to click through publish flow
async function clickPublishButtons() {
  updateStatus('⏳ Publishing...');

  for (let i = 0; i < 3; i++) {
    await sleep(500);
    const nextBtn = document.querySelector('ytcp-button#next-button')
      || document.querySelector('#next-button');
    if (nextBtn) {
      nextBtn.click();
      console.log('[YT Transfer] Clicked Next');
    }
  }

  await sleep(1000);

  const doneBtn = document.querySelector('ytcp-button#done-button')
    || document.querySelector('#done-button');

  if (doneBtn) {
    doneBtn.click();
    console.log('[YT Transfer] Clicked Done/Publish');
    updateStatus('✅ Published! You can close this window.', '#2ecc71');
    setTimeout(finishUpload, 2000);
  }
}

// Finish and cleanup
async function finishUpload() {
  if (videoIndex !== null) {
    try {
      await fetch(`http://localhost:3000/api/mark-uploaded/${videoIndex}`, { method: 'POST' });
    } catch (e) {}
  }

  await chrome.storage.local.remove(['pendingUpload', 'videoIndex']);
  pendingUpload = null;
  videoIndex = null;
  isProcessing = false;

  const helper = document.getElementById('yt-transfer-helper');
  if (helper) helper.remove();
}

// Utility functions
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) return resolve(element);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout'));
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(checkPendingUpload, 1000));
} else {
  setTimeout(checkPendingUpload, 1000);
}

// Watch for URL changes (SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(checkPendingUpload, 1000);
  }
}).observe(document.body, { subtree: true, childList: true });
