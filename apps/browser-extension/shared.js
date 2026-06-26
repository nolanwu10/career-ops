(function initCareerOpsExtension(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CareerOpsExtension = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  const atsHosts = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com'];
  const successPatterns = [
    /application (?:was )?(?:submitted|received|complete)/i,
    /thank you for (?:applying|your application)/i,
    /we(?:'|’)ve received your application/i
  ];
  const fieldPatterns = [
    ['fullName', /\b(full name|legal name|candidate name)\b/i],
    ['firstName', /\b(first|given) name\b/i],
    ['lastName', /\b(last|family|sur)name\b/i],
    ['email', /\b(e-?mail address|email)\b/i],
    ['phoneType', /\b(phone|telephone|contact number)\s*(type|category)\b/i],
    ['phoneCountryCode', /\b(?:(?:phone|telephone|mobile)\s*)?(?:country|calling|dial(?:ing)?)\s*(?:code|prefix)\b/i],
    ['phone', /\b(phone|mobile|telephone)\b/i],
    ['addressLine2', /\b(address\s*(line)?\s*2|apartment|apt\.?|suite|unit)\b/i],
    ['addressLine1', /\b(address\s*(line)?\s*1|street address|street)\b/i],
    ['city', /\b(city|town|municipality)\b/i],
    ['state', /\b(state|province|region)\b/i],
    ['location', /\b(current location|location|city and state)\b/i],
    ['linkedin', /\blinked\s?in\b/i],
    ['portfolio', /\b(portfolio|personal website|website url)\b/i],
    ['github', /\bgithub\b/i],
    ['pronouns', /\bpronouns?\b/i],
    ['workAuthorization', /\b(authorized|authorization|legally eligible|right to work)\b/i],
    ['sponsorship', /\b(sponsor|sponsorship|visa support)\b/i],
    ['veteranStatus', /\b(veteran|military service)\b/i],
    ['disabilityStatus', /\b(disability|disabled|cc-305)\b/i],
    ['gender', /\b(gender|gender identity|sex)\b/i],
    ['hispanicLatino', /\b(hispanic|latino|latina|latinx)\b/i],
    ['raceEthnicity', /\b(race|ethnicity|ethnic background|hispanic|latino)\b/i]
  ];

  function pageSignals(doc, url) {
    const href = String(url || '');
    const text = String(doc?.body?.innerText || '').slice(0, 60000);
    const forms = doc?.querySelectorAll?.('form')?.length || 0;
    const fields = doc?.querySelectorAll?.('input, select, textarea')?.length || 0;
    const applyText = /\b(apply|application|submit application)\b/i.test(text);
    const ats = atsHosts.some((host) => href.includes(host));
    const success = successPatterns.some((pattern) => pattern.test(text));
    const score = (ats ? 2 : 0) + (forms ? 1 : 0) + (fields >= 3 ? 2 : 0) + (applyText ? 1 : 0);
    return { isApplicationPage: score >= 3, success, score, ats, forms, fields };
  }

  function pageMetadata(doc, url) {
    const structured = structuredJobPosting(doc);
    const heading = firstText(doc, [
      '[data-testid="job-title"]',
      '.posting-headline h2',
      '.app-title',
      '.job-title',
      'main h1',
      'h1'
    ]);
    const metaTitle = firstMeta(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']);
    const rawTitle = clean(structured.role || cleanRoleCandidate(heading) || cleanRoleCandidate(metaTitle) || doc?.title);
    const title = stripApplicationPrefix(rawTitle);
    const split = splitJobTitle(title);
    const companyMeta = firstMeta(doc, ['meta[name="company"]']);
    const siteMeta = firstMeta(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
    const company = clean(
      structured.company
      || cleanCompanyCandidate(companyMeta)
      || firstText(doc, ['[data-testid="company-name"]', '.company-name', '.posting-headline .company', '.job-company'])
      || split.company
      || inferAtsCompany(doc, url)
      || cleanCompanyCandidate(siteMeta)
      || inferCompanyFromHost(url)
    );
    return {
      url: String(url || '').split('#')[0],
      role: clean(structured.role || split.role || title),
      company
    };
  }

  function structuredJobPosting(doc) {
    const scripts = [...(doc?.querySelectorAll?.('script[type="application/ld+json"]') || [])];
    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent || '{}');
        const posting = findJobPosting(parsed);
        if (!posting) continue;
        return {
          role: clean(posting.title),
          company: clean(posting.hiringOrganization?.name || posting.organization?.name)
        };
      } catch {
        // Ignore malformed third-party structured data.
      }
    }
    return { role: '', company: '' };
  }

  function findJobPosting(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => String(type).toLowerCase() === 'jobposting')) return value;
    if (value['@graph']) return findJobPosting(value['@graph']);
    return null;
  }

  function firstMeta(doc, selectors) {
    for (const selector of selectors) {
      const value = clean(doc?.querySelector?.(selector)?.content);
      if (value) return value;
    }
    return '';
  }

  function firstText(doc, selectors) {
    for (const selector of selectors) {
      const value = clean(doc?.querySelector?.(selector)?.textContent);
      if (value) return value;
    }
    return '';
  }

  function splitJobTitle(value) {
    const title = stripApplicationPrefix(value);
    const patterns = [
      /^(.+?)\s+(?:at|@)\s+(.+)$/i,
      /^(.+?)\s+[|]\s+(.+)$/,
      /^(.+?)\s+[-–—]\s+(.+)$/
    ];
    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (!match) continue;
      return { role: clean(match[1]), company: cleanCompanyCandidate(match[2]) };
    }
    return { role: title, company: '' };
  }

  function stripApplicationPrefix(value) {
    return clean(value)
      .replace(/^(?:job\s+)?application\s+(?:for|to)\s+/i, '')
      .replace(/^apply(?:ing)?\s+(?:for|to)\s+/i, '');
  }

  function cleanCompanyCandidate(value) {
    const candidate = clean(value)
      .replace(/\s+(?:careers|jobs|application|job application)$/i, '')
      .replace(/\s+[|]\s+.*$/, '');
    if (/^(?:greenhouse|lever|ashby|workable|smartrecruiters|workday|jobs?|careers?)$/i.test(candidate)) return '';
    return candidate;
  }

  function cleanRoleCandidate(value) {
    const candidate = stripApplicationPrefix(value);
    if (/^(?:apply(?: now)?|apply for this job|job application|application|careers?|jobs?)$/i.test(candidate)) return '';
    return candidate;
  }

  function inferAtsCompany(doc, url) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (/greenhouse\.io$/i.test(parsed.hostname)) {
        const boardsIndex = segments.findIndex((segment) => ['boards', 'embed', 'job-boards'].includes(segment));
        const candidate = boardsIndex >= 0 ? segments[boardsIndex + 1] : segments[0];
        return titleCase(String(candidate || '').replace(/[-_]+/g, ' '));
      }
      if (/lever\.co$/i.test(parsed.hostname) || /ashbyhq\.com$/i.test(parsed.hostname)) {
        return titleCase(String(segments[0] || '').replace(/[-_]+/g, ' '));
      }
      if (/smartrecruiters\.com$/i.test(parsed.hostname)) {
        return titleCase(String(segments[0] || '').replace(/[-_]+/g, ' '));
      }
      return '';
    } catch {
      return '';
    }
  }

  function inferCompanyFromHost(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const first = host.split('.')[0];
      return atsHosts.some((ats) => host.includes(ats)) ? '' : titleCase(first.replace(/[-_]+/g, ' '));
    } catch {
      return '';
    }
  }

  function fieldDescriptor(element) {
    const labels = [];
    if (element.id && element.ownerDocument) {
      const direct = element.ownerDocument.querySelector(`label[for="${cssEscape(element.id)}"]`);
      if (direct) labels.push(direct.textContent);
    }
    const wrapping = element.closest?.('label');
    if (wrapping) labels.push(elementText(wrapping));
    const fieldset = element.closest?.('fieldset');
    if (fieldset) {
      labels.push(elementText(fieldset.querySelector('legend')));
      labels.push(elementText(fieldset));
    }
    const fieldEntry = element.closest?.('.ashby-application-form-field-entry, [data-field-entry], [data-testid*="field"]');
    if (fieldEntry && fieldEntry !== fieldset) labels.push(elementText(fieldEntry));
    const nearbyQuestion = nearestQuestionText(element, fieldEntry || fieldset);
    if (nearbyQuestion) labels.push(nearbyQuestion);
    const labelledBy = String(element.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const describedBy = String(element.getAttribute?.('aria-describedby') || '').split(/\s+/).filter(Boolean);
    for (const id of [...labelledBy, ...describedBy]) {
      labels.push(element.ownerDocument?.getElementById?.(id)?.textContent);
    }
    labels.push(
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('name'),
      element.getAttribute?.('id'),
      element.getAttribute?.('autocomplete')
    );
    return labels.map(clean).filter(Boolean).join(' ');
  }

  function ownFieldDescriptor(element) {
    const labels = [];
    if (element.id && element.ownerDocument) {
      labels.push(element.ownerDocument.querySelector(`label[for="${cssEscape(element.id)}"]`)?.textContent);
    }
    const labelledBy = String(element.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    for (const id of labelledBy) labels.push(element.ownerDocument?.getElementById?.(id)?.textContent);
    labels.push(
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('name'),
      element.getAttribute?.('id'),
      element.getAttribute?.('autocomplete')
    );
    return labels.map(clean).filter(Boolean).join(' ');
  }

  function classifyField(element) {
    const descriptor = fieldDescriptor(element).replace(/[_-]+/g, ' ');
    const ownDescriptor = ownFieldDescriptor(element).replace(/[_-]+/g, ' ');
    const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase();
    if (autocomplete === 'name') return 'fullName';
    if (autocomplete === 'given-name') return 'firstName';
    if (autocomplete === 'family-name') return 'lastName';
    if (autocomplete === 'email') return 'email';
    if (autocomplete === 'tel-country-code') return 'phoneCountryCode';
    if (autocomplete === 'tel') return 'phone';
    if (/\b(?:country|calling|dial(?:ing)?)\s*(?:code|prefix)?\b/i.test(ownDescriptor)
      && /\b(?:phone|mobile|telephone)\b/i.test(descriptor)) return 'phoneCountryCode';
    if (autocomplete === 'address-line1' || autocomplete === 'street-address') return 'addressLine1';
    if (autocomplete === 'address-line2') return 'addressLine2';
    if (autocomplete === 'address-level2') return 'city';
    if (autocomplete === 'address-level1') return 'state';
    const match = fieldPatterns.find(([, pattern]) => pattern.test(descriptor));
    return match?.[0] || '';
  }

  async function fillPage(doc, context) {
    const identity = context?.autofill?.identity || {};
    const demographics = context?.autofill?.demographics || {};
    const values = { ...identity, ...nonEmpty(demographics) };
    const inferredHispanicLatino = demographics.hispanicLatino || inferHispanicLatino(demographics.raceEthnicity);
    if (inferredHispanicLatino) values.hispanicLatino = inferredHispanicLatino;
    const phoneCountryCode = extractPhoneCountryCode(identity.phone);
    if (phoneCountryCode) values.phoneCountryCode = phoneCountryCode;
    const savedLocation = [identity.city, identity.state].map(clean).filter(Boolean).join(', ');
    if (savedLocation) values.location = savedLocation;
    const filled = [];
    const skipped = [];
    let matchedCount = 0;
    const seenRadioGroups = new Set();
    const elements = [...new Set(doc.querySelectorAll(customFieldSelector()))];

    for (const element of elements) {
      if (!isFillable(element)) continue;
      if (isCustomDropdown(element)) continue;
      const key = classifyField(element);
      if (!key) continue;
      matchedCount += 1;
      const value = clean(values[key]);
      if (!value) {
        skipped.push({ key, label: fieldDescriptor(element), reason: 'No saved preference' });
        continue;
      }
      if (element.type === 'radio') {
        const group = element.name || fieldDescriptor(element);
        if (seenRadioGroups.has(group)) continue;
        seenRadioGroups.add(group);
        const radios = elements.filter((item) => item.type === 'radio' && (item.name || fieldDescriptor(item)) === group);
        const matched = radios.find((radio) => optionMatches(value, optionText(radio), key));
        if (matched) {
          setControlValue(matched, true);
          filled.push({ key, label: fieldDescriptor(matched) });
        } else {
          skipped.push({ key, label: fieldDescriptor(element), reason: 'No confident option match' });
        }
        continue;
      }
      if (element.tagName === 'SELECT') {
        const option = [...element.options].find((item) => optionMatches(value, `${item.textContent} ${item.value}`, key));
        if (!option) {
          skipped.push({ key, label: fieldDescriptor(element), reason: 'No confident option match' });
          continue;
        }
        setControlValue(element, option.value);
      } else if (element.type === 'checkbox') {
        const desired = /^(?:yes|true|checked)$/i.test(value) || optionMatches(value, optionText(element), key);
        setControlValue(element, desired);
      } else {
        setControlValue(element, value);
      }
      filled.push({ key, label: fieldDescriptor(element) });
    }

    for (const element of elements.filter(isCustomDropdown)) {
      if (!isFillable(element)) continue;
      const key = classifyField(element);
      if (!key) continue;
      matchedCount += 1;
      const value = clean(values[key]);
      if (!value) {
        skipped.push({ key, label: fieldDescriptor(element), reason: 'No saved preference' });
        continue;
      }
      const matched = await chooseCustomDropdownOption(doc, element, value, key);
      if (matched) filled.push({ key, label: fieldDescriptor(element) });
      else skipped.push({ key, label: fieldDescriptor(element), reason: 'No confident option match' });
    }
    return { filled, skipped, matchedCount, scannedCount: elements.length };
  }

  function classifyDocumentField(element) {
    if (String(element?.type || '').toLowerCase() !== 'file') return '';
    const descriptor = documentFieldDescriptor(element);
    if (/\bcover\s*(?:letter|note)\b/i.test(descriptor)) return 'coverLetter';
    if (/\b(?:resume|résumé|cv|curriculum vitae)\b/i.test(descriptor)) return 'resume';
    return '';
  }

  function documentFieldDescriptor(element) {
    const labels = [fieldDescriptor(element)];
    let current = element?.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (['FORM', 'BODY', 'HTML'].includes(current.tagName)) break;
      const text = elementText(current);
      if (text && text.length <= 500) labels.push(text);
      if (/\b(?:resume|résumé|cv|curriculum vitae|cover\s*(?:letter|note))\b/i.test(text)) break;
    }
    return labels.map(clean).filter(Boolean).join(' ');
  }

  async function chooseCustomDropdownOption(doc, element, value, key) {
    element.click?.();
    if (element.tagName === 'INPUT') {
      setNativeValue(element, value);
      const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
      element.dispatchEvent(new EventCtor('input', { bubbles: true }));
    }
    const options = await waitForOptions(doc);
    const matched = options.find((option) => optionMatches(value, optionText(option), key));
    if (!matched) {
      const KeyboardEventCtor = element.ownerDocument?.defaultView?.KeyboardEvent;
      if (KeyboardEventCtor) element.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
    matched.click?.();
    return true;
  }

  async function waitForOptions(doc) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const options = [...doc.querySelectorAll('[role="option"]')]
        .filter((option) => option.getAttribute?.('aria-disabled') !== 'true');
      if (options.length) return options;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }

  function optionMatches(saved, candidate, key = '') {
    const left = normalize(saved);
    const right = normalize(candidate);
    if (!left || !right) return false;
    if (left === right || containsPhrase(right, left) || containsPhrase(left, right)) return true;

    const savedIntent = demographicIntent(key, left);
    const candidateIntent = demographicIntent(key, right);
    return Boolean(savedIntent && candidateIntent && savedIntent === candidateIntent);
  }

  function demographicIntent(key, value) {
    if (matchesAny(value, ['prefer not', 'decline', 'do not wish', 'choose not', 'dont wish', 'not disclose', 'not answer'])) {
      return 'decline';
    }
    if (key === 'workAuthorization') {
      if (matchesAny(value, ['not authorized', 'not eligible', 'no authorization', 'no right to work'])) return 'no';
      if (matchesAny(value, ['authorized', 'eligible', 'right to work', 'legally work', 'us citizen', 'u s citizen'])) return 'yes';
      if (containsPhrase(value, 'no')) return 'no';
      if (containsPhrase(value, 'yes')) return 'yes';
    }
    if (key === 'sponsorship') {
      if (matchesAny(value, ['do not require', 'dont require', 'no sponsorship', 'without sponsorship', 'not require sponsorship'])) return 'no';
      if (matchesAny(value, ['require sponsorship', 'need sponsorship', 'will require', 'yes sponsorship'])) return 'yes';
      if (containsPhrase(value, 'no')) return 'no';
      if (containsPhrase(value, 'yes')) return 'yes';
    }
    if (key === 'veteranStatus') {
      if (matchesAny(value, ['not a protected veteran', 'not protected veteran', 'not a veteran', 'never served', 'no military service'])) return 'no';
      if (matchesAny(value, ['identify as a protected veteran', 'protected veteran', 'active duty wartime', 'armed forces service medal', 'disabled veteran', 'recently separated veteran'])) return 'yes';
      if (containsPhrase(value, 'no')) return 'no';
      if (containsPhrase(value, 'yes')) return 'yes';
    }
    if (key === 'disabilityStatus') {
      if (matchesAny(value, ['do not have a disability', 'dont have a disability', 'don t have a disability', 'no disability', 'not disabled'])
        || /\bno\b.*\bdisabilit/.test(value)) return 'no';
      if (matchesAny(value, ['have a disability', 'has a disability', 'yes disability', 'disability or previously had'])) return 'yes';
      if (containsPhrase(value, 'no')) return 'no';
      if (containsPhrase(value, 'yes')) return 'yes';
    }
    if (key === 'gender') {
      if (containsPhrase(value, 'non binary') || containsPhrase(value, 'nonbinary')) return 'nonbinary';
      if (containsPhrase(value, 'female') || containsPhrase(value, 'woman')) return 'female';
      if (containsPhrase(value, 'male') || containsPhrase(value, 'man')) return 'male';
      if (matchesAny(value, ['other', 'self describe', 'self identify'])) return 'other';
    }
    if (key === 'hispanicLatino') {
      if (matchesAny(value, ['not hispanic', 'not latino', 'not latina', 'no hispanic', 'no latino'])
        || /\bno\b.*\b(?:hispanic|latino|latina|latinx)\b/.test(value)) return 'no';
      if (matchesAny(value, ['hispanic', 'latino', 'latina', 'latinx'])) return 'yes';
      if (containsPhrase(value, 'no')) return 'no';
      if (containsPhrase(value, 'yes')) return 'yes';
    }
    if (key === 'raceEthnicity') {
      const groups = [
        ['american-indian', ['american indian', 'alaska native', 'indigenous']],
        ['asian', ['asian']],
        ['black', ['black', 'african american']],
        ['hispanic', ['hispanic', 'latino', 'latina', 'latinx']],
        ['pacific-islander', ['native hawaiian', 'pacific islander']],
        ['white', ['white', 'caucasian']],
        ['multiracial', ['two or more', 'multiracial', 'multi racial']]
      ];
      return groups.find(([, terms]) => matchesAny(value, terms))?.[0] || '';
    }
    if (key === 'pronouns') {
      if (matchesAny(value, ['he him', 'he his'])) return 'he';
      if (matchesAny(value, ['she her', 'she hers'])) return 'she';
      if (matchesAny(value, ['they them', 'they theirs'])) return 'they';
      if (matchesAny(value, ['other', 'self describe'])) return 'other';
    }
    if (key === 'phoneType') {
      if (matchesAny(value, ['mobile', 'cell', 'cellular'])) return 'mobile';
      if (containsPhrase(value, 'home')) return 'home';
    }
    return '';
  }

  function matchesAny(value, terms) {
    return terms.some((term) => containsPhrase(value, normalize(term)));
  }

  function containsPhrase(value, phrase) {
    return ` ${value} `.includes(` ${phrase} `);
  }

  function setControlValue(element, value) {
    if (element.type === 'radio') {
      if (value && !element.checked) element.click();
      return;
    }
    if (element.type === 'checkbox') {
      const desired = Boolean(value);
      if (element.checked !== desired) element.click();
      return;
    }
    setNativeValue(element, value);
    const EventCtor = element.ownerDocument?.defaultView?.Event || Event;
    element.dispatchEvent(new EventCtor('input', { bubbles: true }));
    element.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function isFillable(element) {
    const type = String(element.type || '').toLowerCase();
    if (isCustomDropdown(element)) return !element.disabled && element.getAttribute?.('aria-disabled') !== 'true';
    return !element.disabled && !element.readOnly && !['hidden', 'submit', 'button', 'file', 'password'].includes(type);
  }

  function customFieldSelector() {
    return [
      'input',
      'select',
      'textarea',
      '[role="combobox"]',
      '[role="button"][aria-haspopup="listbox"]',
      '[role="button"][aria-haspopup="true"]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="true"]'
    ].join(', ');
  }

  function isCustomDropdown(element) {
    return isCustomCombobox(element) || isListboxButton(element);
  }

  function isCustomCombobox(element) {
    return String(element.getAttribute?.('role') || '').toLowerCase() === 'combobox'
      && element.tagName !== 'SELECT';
  }

  function isListboxButton(element) {
    const ariaHasPopup = String(element.getAttribute?.('aria-haspopup') || '').toLowerCase();
    if (!['listbox', 'true'].includes(ariaHasPopup)) return false;
    const role = String(element.getAttribute?.('role') || '').toLowerCase();
    return element.tagName === 'BUTTON' || role === 'button';
  }

  function optionText(element) {
    if (String(element.getAttribute?.('role') || '').toLowerCase() === 'option') {
      return `${element.getAttribute?.('aria-label') || ''} ${element.textContent || ''} ${element.value || ''}`;
    }
    return `${element.value || ''} ${element.closest?.('label')?.textContent || ''} ${nearestOptionText(element)} ${element.nextElementSibling?.textContent || ''}`;
  }

  function nearestOptionText(element) {
    let current = element.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      if (current.tagName === 'FIELDSET') break;
      const text = clean(current.textContent);
      if (text) return text;
    }
    return '';
  }

  function nonEmpty(object) {
    return Object.fromEntries(Object.entries(object || {}).filter(([, value]) => clean(value)));
  }

  function inferHispanicLatino(raceEthnicity) {
    const value = normalize(raceEthnicity);
    if (!value) return '';
    if (demographicIntent('raceEthnicity', value) === 'hispanic') return 'Yes';
    return 'No';
  }

  function extractPhoneCountryCode(value) {
    const phone = clean(value);
    const separated = phone.match(/^\+\s*(\d{1,3})(?=[\s().-])/);
    if (separated) return `+${separated[1]}`;

    const digits = phone.match(/^\+(\d{1,15})$/)?.[1] || '';
    if (!digits) return '';
    const callingCodes = new Set([
      '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
      '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90',
      '91', '92', '93', '94', '95', '98', '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226',
      '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243',
      '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262',
      '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299', '350', '351', '352', '353', '354',
      '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382',
      '383', '385', '386', '387', '389', '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508',
      '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675', '676',
      '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850', '852',
      '853', '855', '856', '880', '886', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972',
      '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998'
    ]);
    for (const length of [1, 2, 3]) {
      const candidate = digits.slice(0, length);
      if (callingCodes.has(candidate)) return `+${candidate}`;
    }
    return '';
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function elementText(element) {
    return element ? clean(element.innerText || element.textContent) : '';
  }

  function nearestQuestionText(element, alreadyCaptured) {
    let current = element?.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (['FORM', 'BODY', 'HTML'].includes(current.tagName)) break;
      if (current === alreadyCaptured) continue;
      const text = elementText(current);
      if (!text || text.length > 700) continue;
      if (/\b(?:select one|choose one|please select|please indicate|required)\b/i.test(text)) return text;
    }
    return '';
  }

  function normalize(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function titleCase(value) {
    return clean(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  return {
    pageSignals,
    pageMetadata,
    structuredJobPosting,
    splitJobTitle,
    fieldDescriptor,
    ownFieldDescriptor,
    classifyField,
    classifyDocumentField,
    documentFieldDescriptor,
    fillPage,
    optionMatches,
    extractPhoneCountryCode
  };
});
