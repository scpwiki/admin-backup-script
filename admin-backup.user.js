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
// @version     v0.1.8
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
  // Special case
  if (!value) {
    return { enable: 'default' };
  }

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
  console.debug('Making an AJAX module request', moduleName, params);
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
  console.info('Fetching basic site information');

  // From variables
  const id = WIKIREQUEST.info.siteId;
  const slug = WIKIREQUEST.info.domain.replace(/\.wikidot\.com$/, '');
  // ^ This is verified to always be the *.wikidot.com domain
  const lang = WIKIREQUEST.info.lang;

  // From the 'general module'
  const html = await requestModuleHtml('managesite/ManageSiteGeneralModule');
  const description = html.getElementById('site-description-field').value;
  const textFields = html.querySelectorAll('.controls input');
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
  console.info('Fetching domain settings');
  const html = await requestModuleHtml('managesite/ManageSiteDomainModule');
  const customDomain = html.getElementById('sm-domain-field').value;
  const customDomainOnly = html.getElementById('sm-domain-default').checked;
  const redirectElements = html.querySelectorAll('#sm-redirects-box input');
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

async function fetchAccessPolicy() {
  console.info('Fetching access policy');
  const html = await requestModuleHtml('managesite/ManageSiteAccessPolicyModule');
  const accessModeElement = html.querySelector('#sm-private-form input[type=radio][checked]');
  const enableApplications = html.getElementById('sm-membership-apply').checked;
  const autoAccept = html.getElementById('sm-membership-automatic').value;
  const enablePassword = html.getElementById('sm-membership-password').checked;
  const passwordValue = html.querySelector('input[name=password]').value;
  const blockClones = html.getElementById('sm-block-clone-checkbox').checked;
  const blockIncludes = html.getElementById('sm-block-csi-checkbox').checked;
  // ^ cross-site includes
  const allowHotlinks = html.getElementById('sm-allow-hotlinking-checkbox').checked;
  // NOTE: private site options are not being saved

  let accessMode;
  switch (accessModeElement.id) {
    case 'sm-access-open':
      accessMode = 'open';
      break;
    case 'sm-access-closed':
      accessMode = 'closed';
      break;
    case 'sm-access-private':
      accessMode = 'private';
      break;
    default:
      throw new Error(`Unknown selected access mode ID: ${accessModeElement.id}`);
  }

  return {
    accessMode,
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

async function fetchHttpsPolicy() {
  console.info('Fetching HTTPS settings');
  const html = await requestModuleHtml('managesite/ManageSiteSecureAccessModule');
  const element = html.getElementById('sm-ssl-mode-select');
  for (const option of element.children) {
    // options are:
    // ''         - disabled
    // 'ssl'      - HTTP & HTTPS
    // 'ssl_only' - HTTPS only
    if (option.selected) {
      switch (option.value) {
        case '':
          return { http: true, https: false };
        case 'ssl':
          return { http: true, https: true };
        case 'ssl_only':
          return { http: false, https: true };
        default:
          throw new Error(`Unknown value in selected option '${option.value}' for secure access mode`);
      }
    }
  }

  throw new Error("Couldn't find selected option for secure access mode");
}

async function fetchApiAccess() {
  console.info('Fetching API access settings');
  const html = await requestModuleHtml('managesite/ManageSiteApiModule');
  const memberReadElement = html.querySelector('input[name=read-1]');
  const adminReadElement = html.querySelector('input[name=read-2]');
  const memberWriteElement = html.querySelector('input[name=write-1]');
  const adminWriteElement = html.querySelector('input[name=write-2]');

  return {
    member: {
      read: memberReadElement.checked,
      write: memberWriteElement.checked,
    },
    admin: {
      read: adminReadElement.checked,
      write: adminWriteElement.checked,
    }
  };
}

async function fetchUserIconPolicy() {
  console.info('Fetching user icon policy');
  const html = await requestModuleHtml('managesite/ManageSiteUserIconsModule');
  const element = html.querySelector('#sm-usericons-form input[checked]');
  switch (element.value) {
    // "Avatar, Karma, Pro icons"
    case 'aks':
      return {
        avatar: true,
        karma: true,
        pro: true,
      };
    // "avatar, Pro icons (skip karma)"
    case 'as':
      return {
        avatar: true,
        karma: false,
        pro: true,
      };
    // "avatar, karma (skip Pro icons)"
    case 'ak':
      return {
        avatar: true,
        karma: true,
        pro: false,
      };
    // "only avatar"
    case 'a':
      return {
        avatar: true,
        karma: false,
        pro: false,
      };
    // "just names, nothing graphical"
    case '':
      return {
        avatar: false,
        karma: false,
        pro: false,
      };
    // error
    default:
      throw new Error(`Unexpected user icon display value: '${element.value}'`);
  }
}

async function fetchBlockLinkPolicy() {
  console.info('Fetching link block policy');
  const html = await requestModuleHtml('managesite/abuse/ManageSiteOptionAbuseModule');
  const anonymousElement = html.querySelector('input[name=blockLink]');
  const karmaElement = html.querySelector('select[name=karmaLevel] option[selected]');
  const blockKarmaLevel = parseInt(karmaElement.value);
  if (isNaN(blockKarmaLevel)) {
    throw new Error(`Invalid karma level value: ${karmaElement.value}`);
  }

  return {
    blockAnonymous: anonymousElement.checked,
    blockKarmaLevel,
  };
}

async function fetchIcons() {
  console.info('Fetching site icons');
  const filenameRegex = /\/local--\w+\/(\w+\.\w+)\?\d+/;

  async function fetchIcon(module) {
    console.info(`Fetching favicon for module ${module}`);
    const html = await requestModuleHtml(module);
    const alreadyUploadedElement = html.querySelector('h2');
    if (alreadyUploadedElement === null) {
      // There is an <h2> with "You have already uploaded a favicon"
      // or similar if an icon has been uploaded. So if it's absent,
      // then we say no icon has been uploaded and can return null.
      return null;
    }

    const imageElement = html.querySelector('td img');
    const filename = imageElement.src.match(filenameRegex)[1];
    const response = await fetch(imageElement.src);
    if (response.status !== 200) {
      throw new Error(`Unable to fetch image, got HTTP ${response.status}`);
    }

    const blob = await response.blob();
    return { filename, blob };
  }

  return Promise.all([
    fetchIcon('managesite/icons/ManageSiteFaviconModule'),
    fetchIcon('managesite/icons/ManageSiteIosIconModule'),
    fetchIcon('managesite/icons/ManageSiteWindowsIconModule'),
  ]);
}

async function fetchCategorySettings() {
  console.info('Fetching category settings');

  // Fetch category JSON
  const result = await requestModule('managesite/ManageSiteLicenseModule');
  const rawCategories = result['categories'];
  console.debug(rawCategories);

  // License values
  const html = parseHtml(result['body']);
  const licenseElements = html.querySelectorAll('#sm-license-lic option');
  const licenses = {};
  for (const licenseElement of licenseElements) {
    const licenseId = licenseElement.value;
    const licenseText = licenseElement.innerText;
    licenses[licenseId] = licenseText;
  }

  // TODO rest of the category stuff

  // Build category data
  const categories = {};
  for (const raw of rawCategories) {
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
  console.info('Fetching user ban data');
  const html = await requestModuleHtml('managesite/blocks/ManageSiteUserBlocksModule');
  const ubans = html.querySelectorAll('table tr');
  const bans = [];
  // skip the first row, is header
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
  console.info('Fetching IP ban data');
  const html = await requestModuleHtml('managesite/blocks/ManageSiteIpBlocksModule');
  const ibans = html.querySelectorAll('table tr');

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

async function fetchSiteMembers() {
  console.info('Fetching site members');

  async function fetchUsers(module) {
    console.info(`Requesting user data from module ${module}`);

    const users = [];
    let page = 1;
    let maxPages;

    do {
      console.debug(`Retrieving page ${page} of ${maxPages || '<unknown>'}`);
      const html = await requestModuleHtml(module, { page });
      const entries = html.querySelectorAll('table tr');
      // skip the first row, is header
      for (let i = 1; i < entries.length; i++) {
        const entry = entries[i];
        const userElement = entry.querySelector('td span.printuser a');
        const userId = parseUserElement(userElement);
        users.push(userId);
      }

      // If there's a pager, there are multiple pages, iterate through each one.
      // We only try this on the first iteration, obviously.
      if (page === 1) {
        const pagerElement = html.querySelector('.pager');
        if (pagerElement === null) {
          // no more pages
          break;
        }

        // First, get the maximum number of pages.
        // The pager is laid out like this:
        // [previous] [1] [2] ... [398] [399] [400] [401] [402] ... [998] [999] [next]
        //
        // Where the page number buttons (and number of them) differ depending on one's position.
        // However, it always ends with "next", and second-to-last is the final page number.
        // We can use this to get the last page number.
        const buttonChildren = pagerElement.querySelectorAll('.target');
        const lastButton = buttonChildren[buttonChildren.length - 2];
        const lastButtonText = lastButton.innerText
        maxPages = parseInt(lastButtonText);
        if (isNaN(maxPages)) {
          throw new Error(`Invalid value for page index: ${lastButtonText}`);
        }
      }

      page++;
    } while (page <= maxPages); // 1-indexing

    return users;
  }

  const [members, moderators, admins] = await Promise.all([
    fetchUsers('managesite/members/ManageSiteMembersListModule'),
    fetchUsers('managesite/members/ManageSiteModeratorsModule'),
    fetchUsers('managesite/members/ManageSiteAdminsModule'),
  ]);
  return { members, moderators, admins };
}

// Main

async function runBackupInner() {
  // Fetch data
  const siteInfo = await fetchBasicInfo();
  siteInfo.domains = await fetchDomainSettings();
  siteInfo.access = await fetchAccessPolicy();
  siteInfo.tls = await fetchHttpsPolicy();
  siteInfo.api = await fetchApiAccess();
  siteInfo.userIcons = await fetchUserIconPolicy();
  siteInfo.blockLinks = await fetchBlockLinkPolicy();
  const icons = await fetchIcons();
  const categories = await fetchCategorySettings();
  const userBans = await fetchUserBans();
  const ipBans = await fetchIpBans();
  const members = await fetchSiteMembers();
  // TODO other data

  // Build and download ZIP
  const zipFiles = [
    { name: 'site.json', input: JSON.stringify(siteInfo) },
    { name: 'categories.json', input: JSON.stringify(categories) },
    { name: 'bans.json', input: JSON.stringify({ user: userBans, ip: ipBans }) },
    { name: 'members.json', input: JSON.stringify(members) },
  ];

  // Add favicons
  for (const icon of icons) {
    if (icon !== null) {
      zipFiles.push({ name: icon.filename, input: icon.blob });
    }
  };

  console.info('Building output ZIP');
  const { downloadZip } = await import('https://cdn.jsdelivr.net/npm/client-zip/index.js');
  const zipBlob = await downloadZip(zipFiles).blob();
  promptFileDownload(`${siteInfo.slug}.zip`, zipBlob);
  URL.revokeObjectURL(zipBlob);

  for (const icon of icons) {
    if (icon !== null) {
      URL.revokeObjectURL(icon.blob);
    }
  }
}

async function runBackup(backupButton, backupProgress) {
  await showConfirmation('run backup', 'Are you sure you want to start an admin panel backup?');

  console.info('Starting backup!');
  backupButton.innerText = 'Backup Running';
  backupButton.setAttribute('disabled', '');
  backupProgress.classList.remove('hidden');

  try {
    await runBackupInner();
  } catch (error) {
    alert(`Error while running backup:\n\n${error}`);
  } finally {
    backupButton.innerText = 'Run Admin Panel Backup';
    backupButton.removeAttribute('disabled');
    backupProgress.classList.add('hidden');
  }
}

function main() {
  const backupProgress = document.createElement('progress');
  backupProgress.classList.add('hidden');
  backupProgress.style = 'margin-left: 1em';

  const backupButton = document.createElement('button');
  backupButton.innerText = 'Run Admin Panel Backup';
  backupButton.classList.add('btn');
  backupButton.addEventListener('click', () => runBackup(backupButton, backupProgress));

  const headerElement = document.querySelector('.page-header');
  if (!headerElement) {
    throw new Error('Invalid DOM or page load error');
  }

  headerElement.appendChild(backupButton);
  headerElement.appendChild(backupProgress);
}

main();
