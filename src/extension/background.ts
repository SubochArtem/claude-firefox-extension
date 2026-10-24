browser.runtime.onInstalled.addListener((details) => {
  const { version } = browser.runtime.getManifest();
  console.log(`Claude Firefox Extension ${version} installed (reason: ${details.reason})`);
});
