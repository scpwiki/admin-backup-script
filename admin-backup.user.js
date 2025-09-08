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
// @version     v0.1.1
// @updateURL   https://github.com/scpwiki/admin-backup-script/raw/main/admin-backup.user.js
// @downloadURL https://github.com/scpwiki/admin-backup-script/raw/main/admin-backup.user.js
// @include     http://*.wikidot.com/_admin
// @include     https://*.wikidot.com/_admin
// ==/UserScript==

// Data processing

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
  for (const klass of element.classList) {
    if (klass.startsWith('time_')) {
      return parseInt(klass.substring(5));
    }
  }
  throw new Error('Unable to find timestamp in odate element');
}

function parseRating(value) {
  // Example strings:
  // - draP (disabled)
  // - raP  (default/inherited)
  // - ervS (registered, visible votes, five-star)
  // - ervM (registered, visible votes, plus/minus)
  // - eraM (registered, hidden votes, plus/minus)
  // - emvP (site members, visible votes, plus-only)
  // - emaP (site members, hidden votes, plus-only)

  // Overall status
  //   d - disabled
  //   e - enabled
  //   If neither, then 'default'
  //   Always the first character
  let enable;
  switch (value[0]) {
    case 'e':
      enable = true;
      break;
    case 'd':
      enable = false;
      break;
    default: // lol
      enable = 'default';
  }

  // Eligible voters
  //   r - registered wikidot users
  //   m - site members
  let eligibility;
  if (value.includes('r')) {
    eligibility = 'registered';
  } else if (value.includes('m')) {
    eligibility = 'members';
  } else {
    throw new Error(`Invalid vote eligibility in spec str: ${value}`);
  }

  // Vote visibility
  //   a - anonymous
  //   v - visible
  const visibility = value.includes('v');

  // Vote type
  //   S - five-star
  //   M - plus/minus
  //   P - plus only
  let voteType;
  if (value.includes('S')) {
    voteType = 'fivestar';
  } else if (value.includes('M')) {
    voteType = 'plusminus';
  } else if (value.includes('P')) {
    voteType = 'plusonly';
  } else {
    throw new Error(`Invalid vote type in spec str: ${value}`);
  }

  return { enable, eligibility, visibility, voteType };
}

function parsePermissions(enable, value) {
  // Example strings:
  // - v:armo;e:m;c:m;m:m;d:m;a:m;r:m;z:m;o:rm
  // - v:armo;c:;e:;m:;d:;a:;r:;z:;o:
  // - v:arm;e:;c:;m:;d:;a:;r:;z:;o:
  // - v:armo;c:;e:arm;m:rm;d:rm;a:m;r:o;z:o;o:

  // Permission action:
  //   v - View pages
  //   c - Create pages
  //   e - Edit pages
  //   m - Move pages
  //   d - Delete pages
  //   a - Add files
  //   r - Rename files
  //   z - Replace, move, and delete files
  //   o - Show page options

  function parseAction(value) {
    switch (value) {
      case 'v': return 'viewPages';
      case 'c': return 'createPages';
      case 'e': return 'editPages';
      case 'm': return 'movePages';
      case 'd': return 'deletePages';
      case 'a': return 'uploadFiles';
      case 'r': return 'renameFiles';
      case 'z': return 'replaceDeleteFiles';
      case 'o': return 'showPageOptions';
    }
  }

  // User scopes:
  //   a - Anonymous users (no account)
  //   r - Registered users (has account)
  //   m - Site members
  //   o - Page creators ("owners"), regardless of the above

  function parseScope(value) {
    const anonymous = value.includes('a');
    const registered = value.includes('r');
    const members = value.includes('m');
    const pageCreators = value.includes('o');
    return { anonymous, registered, members, pageCreators };
  }

  // Parse each permission group

  const permissions = { enable };
  for (const group of value.split(';')) {
    const [perm, scope] = group.split(':');
    const action = parseAction(perm);
    const options = parseScope(scope);
    permissions[action] = options;
  }

  return permissions;
}

// Utilities

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
  return result;
}

async function requestModuleHtml(moduleName) {
  const result = await requestModule(moduleName);
  return parseHtml(result['body']);
}

function promptFileDownload(filename, blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  link.remove();
}

// Backup tasks

async function fetchBasicInfo() {
  // From variables
  const id = WIKIREQUEST.info.siteId;
  const slug = WIKIREQUEST.info.domain.replace(/\.wikidot\.com$/, '');
  // ^ This is verified to always be the *.wikidot.com domain
  const lang = WIKIREQUEST.info.lang;

  // From the 'general module'
  const element = await requestModuleHtml('managesite/ManageSiteGeneralModule');
  const description = element.getElementById('site-description-field').value;
  const textFields = element.querySelectorAll('.controls input');
  if (textFields.length !== 4) {
    throw new Error(`Unexpected number of text fields for general site info: ${textFields.length} (wanted 4)`);
  }

  return {
    dumpGeneratedAt: new Date().toISOString(), // why not, might come in handy
    id,
    slug,
    lang,
    description,
    name: textFields[0].value,
    tagline: textFields[1].value,
    homePage: textFields[2].value,
    welcomePage: textFields[3].value,
  };
}

async function fetchDomainSettings() {
  const element = await requestModuleHtml('managesite/ManageSiteDomainModule');
  const customDomain = element.getElementById('sm-domain-field').value;
  const customDomainOnly = element.getElementById('sm-domain-default').checked;
  const redirectElements = element.querySelectorAll('#sm-redirects-box input');
  const extraDomains = [];
  for (const redirectElement of redirectElements) {
    if (redirectElement.value) {
      extraDomains.push(redirectElement.value);
    }
  }

  return {
    customDomain,
    customDomainOnly,
    extraDomains,
  };
}

async function fetchCategorySettings() {
  // Fetch category JSON
  const result = await requestModule('managesite/ManageSiteLicenseModule');

  // License values
  const element = parseHtml(result['body']);
  const licenseElements = element.querySelectorAll('#sm-license-lic option');
  const licenses = {};
  for (const licenseElement of licenseElements) {
    const licenseId = licenseElement.value;
    const licenseText = licenseElement.innerText;
    licenses[licenseId] = licenseText;
  }

  // TODO rest of the licensing stuff

  // Build category data
  const categories = {};
  for (const raw of result['categories']) {
    categories[raw.name] = {
      id: raw.categry_id,
      name: raw.name,
      theme: {
        id: raw.theme_id,
        default: raw.theme_default,
        externalUrl: raw.theme_external_url,
      },
      layout: {
        id: raw.layout_id,
        default: raw.layout_default,
      },
      license: {
        id: raw.license_id,
        default: raw.license_default,
        custom: raw.license_other,
        name: licenses[raw.license_id],
      },
      perPageDiscussion: {
        enable: raw.per_page_discussion,
        default: raw.per_page_discussion_default,
      },
      nav: {
        default: raw.nav_default,
        topBar: raw.top_bar_page_name,
        sideBar: raw.side_bar_page_name,
      },
      template: {
        id: raw.template_id,
        pageTitle: raw.page_title_template,
      },
      autonumerate: raw.autonumerate,
      rating: parseRating(raw.rating),
      permissions: parsePermissions(raw.permissions_default, raw.permissions),
    };
  }

  return categories;
}

async function fetchUserBans() {
  const element = await requestModuleHtml('managesite/blocks/ManageSiteUserBlocksModule');
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

async function fetchIpBans() {
  const element = await requestModuleHtml('managesite/blocks/ManageSiteIpBlocksModule');
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

async function fetchAccessPolicy() {
  const element = await requestModuleHtml('managesite/ManageSiteAccessPolicyModule');
  const enableApplications = element.getElementById('sm-membership-apply').checked;
  const autoAccept = element.getElementById('sm-membership-automatic').value;
  const enablePassword = element.getElementById('sm-membership-password').checked;
  const passwordValue = element.querySelector('input[name=password]').value;
  const blockClones = element.getElementById('sm-block-clone-checkbox').checked;
  const blockIncludes = element.getElementById('sm-block-csi-checkbox').checked;
  // ^ cross-site includes
  const allowHotlinks = element.getElementById('sm-allow-hotlinking-checkbox').checked;
  // NOTE: private site options are not being saved
  return {
    enableApplications,
    autoAccept,
    membershipPassword: {
      enable: enablePassword,
      value: passwordValue,
    },
    blockClones,
    blockIncludes,
    allowHotlinks,
  };
}

// Main

async function runBackup(backupButton) {
  await showConfirmation('run backup', 'Are you sure you want to start an admin panel backup?');

  backupButton.innerText = 'Backup Running';
  backupButton.setAttribute('disabled', '');

  // Fetch data
  const siteInfo = await fetchBasicInfo();
  siteInfo.domains = await fetchDomainSettings();
  siteInfo.access = await fetchAccessPolicy();
  const categories = await fetchCategorySettings();
  const userBans = await fetchUserBans();
  const ipBans = await fetchIpBans();
  // TODO other data

  // Build and download ZIP
  const zipFiles = [
    { name: 'site.json', input: JSON.stringify(siteInfo) },
    { name: 'categories.json', input: JSON.stringify(categories) },
    { name: 'bans.json', input: JSON.stringify({ user: userBans, ip: ipBans }) },
  ];

  const { downloadZip } = await import('https://cdn.jsdelivr.net/npm/client-zip/index.js');
  const zipBlob = await downloadZip(zipFiles).blob();
  promptFileDownload(`${siteInfo.slug}.zip`, zipBlob);
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
