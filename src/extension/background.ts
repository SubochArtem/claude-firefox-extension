import { connect, RECONNECT_ALARM } from './native-bridge';

browser.runtime.onInstalled.addListener((details) => {
  const { version } = browser.runtime.getManifest();
  console.log(`Claude Firefox Extension ${version} installed (reason: ${details.reason})`);
});

// An event page only runs at browser startup if it listens to runtime.onStartup. Every wake
// re-runs this script, so the top-level connect() below does the actual work and these listeners
// exist to wake the page; connect() ignores calls while a port or a retry is already pending.
browser.runtime.onStartup.addListener(connect);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

connect();
