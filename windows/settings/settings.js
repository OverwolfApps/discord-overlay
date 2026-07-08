// Discord Overlay Settings Redirect
let selfWinId = null;
let settingsManagerId = null;

const els = {
  close: document.getElementById('close'),
  launchBtn: document.getElementById('launch-btn'),
  statusMsg: document.getElementById('status-msg'),
};

overwolf.windows.getCurrentWindow((r) => {
  if (r.status === 'success') selfWinId = r.window.id;
});

els.close.onclick = () => {
  if (selfWinId) overwolf.windows.hide(selfWinId);
};

function checkSettingsManager() {
  overwolf.extensions.getExtensions((r) => {
    if (r && r.extensions) {
      const sm = r.extensions.find(e => e.meta && e.meta.name === 'Settings Manager');
      if (sm) {
        settingsManagerId = sm.id;
        els.launchBtn.disabled = false;
        els.statusMsg.textContent = "Settings Manager is installed.";
        els.statusMsg.style.color = "#48d597";
      } else {
        els.launchBtn.disabled = true;
        els.statusMsg.textContent = "Settings Manager is required but not installed.";
        els.statusMsg.style.color = "#ff5c6c";
      }
    } else {
      els.launchBtn.disabled = true;
      els.statusMsg.textContent = "Failed to query installed extensions.";
      els.statusMsg.style.color = "#ff5c6c";
    }
  });
}

els.launchBtn.onclick = () => {
  if (settingsManagerId) {
    overwolf.extensions.launch(settingsManagerId, (result) => {
      if (result.status === 'success') {
        if (selfWinId) overwolf.windows.hide(selfWinId);
      } else {
        console.error('Failed to launch Settings Manager:', result.error);
      }
    });
  }
};

checkSettingsManager();
setInterval(checkSettingsManager, 3000);
