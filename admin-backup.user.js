/*
 * Wikidot admin panel backup userscript
 *
 * For installation instructions, see https://05command.wikidot.com/user-scripts
 *
 * Contact: https://www.wikidot.com/account/messages#/new/4598089
 */

// ==UserScript==
// @name        Wikidot admin panel backup script
// @description Backs up information from the admin panel of a Wikidot site
// @version     v0.0.4
// @updateURL   https://github.com/scpwiki/admin-backup-script/raw/main/admin-backup.user.js
// @downloadURL https://github.com/scpwiki/admin-backup-script/raw/main/admin-backup.user.js
// @include     http://*.wikidot.com/_admin
// @include     https://*.wikidot.com/_admin
// ==/UserScript==

// Utilities

function parseHtml(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

function parseUserElement(element) {
  // 'span.printuser a' element -> user ID int
  const regex = /WIKIDOT\.page\.listeners\.userInfo\((\d+)\)/;
  const value = element.getAttribute('onclick');
  const result = value.match(regex)[1];
  return parseInt(result);
}

function parseDateElement(element) {
  // odate element -> timestamp int
  for (let i = 0; element.classList; i++) {
    const klass = element.classList[i];
    if (klass.startsWith('time_')) {
      return parseInt(klass.substring(5));
    }
  }
  throw new Error('Unable to find timestamp in odate element');
}

function showConfirmation(actionName, content) {
  return new Promise((resolve, reject) => {
    const win = new OZONE.dialogs.ConfirmationDialog();
    win.content = content;
    win.buttons = ['cancel', actionName];
    win.addButtonListener(actionName, () => {
      win.close();
      resolve();
    });
    win.addButtonListener('cancel', () => {
      win.close();
      reject();
    });
    win.show();
  });
}

async function requestModule(moduleName, params=null) {
  const result = await new Promise((resolve) => {
    OZONE.ajax.requestModule(moduleName, params, resolve);
  });
  if (result['status'] !== 'ok') {
    throw new Error(`${moduleName} request failed`);
  }
  return result['body'];
}

function promptFileDownload(filename, blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  link.remove();
}

// Backup tasks

async function backupUserBans() {
  const result = await requestModule('managesite/blocks/ManageSiteUserBlocksModule', null);
  const element = parseHtml(result);
  const ubans = element.querySelectorAll('table tr');

  // skip the first row, which is a header
  const bans = [];
  for (let i = 1; i < ubans.length; i++) {
    const uban = ubans[i];
    const userElement = uban.querySelector('td span.printuser a');
    const dateElement = uban.querySelector('td span.odate');
    const reasonElement = uban.querySelector('td[style]');
    bans.push({
      userId: parseUserElement(userElement),
      timestamp: parseDateElement(dateElement),
      reason: reasonElement.innerText.trim(),
    });
  }
  return bans;
}

async function backupIpBans() {
  const result = await requestModule('managesite/blocks/ManageSiteIpBlocksModule', null);
  const element = parseHtml(result);
  const ibans = element.querySelectorAll('table tr');

  // skip the first row, which is a header
  const bans = [];
  for (let i = 1; i < ibans.length; i++) {
    const iban = ibans[i];
    const ipElement = iban.querySelector('td');
    const dateElement = iban.querySelector('td span.odate');
    const reasonElement = iban.querySelector('td[style]');
    bans.push({
      ip: ipElement.innerText.trim(),
      timestamp: parseDateElement(dateElement),
      reason: reasonElement.innerText.trim(),
    });
  }
  return bans;
}

// Main

async function runBackup(backupButton) {
  await showConfirmation('run backup', 'Are you sure you want to start an admin panel backup?');

  backupButton.innerText = 'Backup Running';
  backupButton.setAttribute('disabled', '');

  // Fetch data
  const siteId = WIKIREQUEST.info.siteId;
  // verified to always be the wikidot domain
  const siteSlug = WIKIREQUEST.info.domain.replace(/\.wikidot\.com$/, '');
  const siteLang = WIKIREQUEST.info.lang;
  const userBans = await backupUserBans();
  const ipBans = await backupIpBans();

  // TODO

  // Build individual files
  const siteInfo = JSON.stringify({
    id: siteId,
    slug: siteSlug,
    lang: siteLang,
  });
  const bans = JSON.stringify({ user: userBans, ip: ipBans });

  // Build and download ZIP
  const zipFiles = [
    { name: 'info.json', input: siteInfo },
    { name: 'bans.json', input: bans },
  ];

  const { downloadZip } = await import('https://cdn.jsdelivr.net/npm/client-zip/index.js');
  const zipBlob = await downloadZip(zipFiles).blob();
  promptFileDownload(`${siteSlug}.zip`, zipBlob);
  URL.revokeObjectURL(zipBlob);

  backupButton.innerText = 'Run Admin Panel Backup';
  backupButton.removeAttribute('disabled');
}

function main() {
  const backupButton = document.createElement('button');
  backupButton.innerText = 'Run Admin Panel Backup';
  backupButton.classList.add('btn');
  backupButton.addEventListener('click', () => runBackup(backupButton));

  const headerElement = document.querySelector('.page-header');
  if (!headerElement) {
    throw new Error('Invalid DOM or page load error');
  }

  headerElement.appendChild(backupButton);
}

main();
