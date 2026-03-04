// Background service worker
// Handles communication between popup and content scripts

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PENDING_UPLOAD') {
    chrome.storage.local.get(['pendingUpload', 'videoIndex'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (message.type === 'CLEAR_PENDING') {
    chrome.storage.local.remove(['pendingUpload', 'videoIndex'], () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
