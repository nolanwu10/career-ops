const assert = require('node:assert/strict');
const test = require('node:test');
const {
  pageSignals,
  pageMetadata,
  classifyField,
  classifyDocumentField,
  documentFieldDescriptor,
  fillPage,
  optionMatches,
  extractPhoneCountryCode
} = require('./shared');

function field(attributes = {}, label = '') {
  return {
    id: attributes.id || '',
    type: attributes.type || 'text',
    ownerDocument: {
      querySelector: () => label ? { textContent: label } : null,
      getElementById: () => null
    },
    getAttribute(name) { return attributes[name] || null; },
    closest() { return null; }
  };
}

function ashbyRadio(question, answer, name) {
  const fieldset = {
    tagName: 'FIELDSET',
    textContent: `${question} Yes No`,
    querySelector: () => null
  };
  const option = {
    tagName: 'DIV',
    textContent: answer,
    parentElement: fieldset
  };
  const span = {
    tagName: 'SPAN',
    textContent: '',
    parentElement: option
  };
  return {
    id: `${name}-${answer}`,
    name,
    type: 'radio',
    tagName: 'INPUT',
    value: '',
    checked: false,
    disabled: false,
    readOnly: false,
    parentElement: span,
    ownerDocument: { querySelector: () => null },
    getAttribute(attribute) {
      if (attribute === 'name') return name;
      return null;
    },
    closest(selector) {
      if (selector === 'fieldset') return fieldset;
      if (selector === 'label') return null;
      return null;
    },
    click() {
      this.checked = true;
    }
  };
}

test('pageSignals recognizes an ATS application form', () => {
  const doc = {
    body: { innerText: 'Apply for this role Submit application' },
    querySelectorAll(selector) {
      if (selector === 'form') return [{}];
      if (selector === 'input, select, textarea') return [{}, {}, {}, {}];
      return [];
    }
  };
  const result = pageSignals(doc, 'https://jobs.ashbyhq.com/example/123');
  assert.equal(result.isApplicationPage, true);
  assert.equal(result.ats, true);
});

test('classifyField prioritizes a grouped phone country selector over adjacent phone text', () => {
  const country = field({ id: 'country-selector', role: 'combobox' }, 'Country');
  country.closest = (selector) => selector.includes('[data-field-entry]')
    ? { textContent: 'Country Phone +1 669-377-4521' }
    : null;

  assert.equal(classifyField(country), 'phoneCountryCode');
});

test('pageSignals recognizes a submission confirmation', () => {
  const doc = {
    body: { innerText: 'Thank you for applying. We have received your application.' },
    querySelectorAll: () => []
  };
  assert.equal(pageSignals(doc, 'https://example.com/thanks').success, true);
});

test('classifyField detects contact and demographic fields', () => {
  assert.equal(classifyField(field({ autocomplete: 'email' })), 'email');
  assert.equal(classifyField(field({ autocomplete: 'address-line1' })), 'addressLine1');
  assert.equal(classifyField(field({ autocomplete: 'address-line2' })), 'addressLine2');
  assert.equal(classifyField(field({ autocomplete: 'address-level2' })), 'city');
  assert.equal(classifyField(field({ autocomplete: 'address-level1' })), 'state');
  assert.equal(classifyField(field({ id: 'phone_type' }, 'Phone type')), 'phoneType');
  assert.equal(classifyField(field({ autocomplete: 'tel-country-code' })), 'phoneCountryCode');
  assert.equal(classifyField(field({ id: 'phone_country_code' }, 'Phone country code')), 'phoneCountryCode');
  assert.equal(classifyField(field({ id: 'sponsor' }, 'Will you require visa sponsorship?')), 'sponsorship');
  assert.equal(classifyField(field({ id: 'veteran' }, 'Protected veteran status')), 'veteranStatus');
  assert.equal(classifyField(field({ id: 'race' }, 'Race or ethnicity')), 'raceEthnicity');
  assert.equal(classifyField(field({ name: 'uuid__systemfield_eeoc_gender' })), 'gender');
  assert.equal(
    classifyField(ashbyRadio('At the moment, do you require sponsorship to work in the United States?', 'No', 'uuid')),
    'sponsorship'
  );
});

test('classifyDocumentField distinguishes resume and cover letter uploads', () => {
  assert.equal(classifyDocumentField(field({ type: 'file', id: 'resume' }, 'Resume/CV')), 'resume');
  assert.equal(classifyDocumentField(field({ type: 'file', id: 'cover-letter' }, 'Cover Letter')), 'coverLetter');
  assert.equal(classifyDocumentField(field({ type: 'file', id: 'portfolio' }, 'Portfolio sample')), '');
});

test('classifyDocumentField finds a hidden resume input from its upload container', () => {
  const resumeInput = field({ type: 'file', id: 'upload-input' });
  resumeInput.parentElement = {
    tagName: 'DIV',
    textContent: 'Resume/CV Attach Dropbox Google Drive Enter manually',
    parentElement: { tagName: 'FORM', textContent: '' }
  };
  assert.match(documentFieldDescriptor(resumeInput), /Resume\/CV/);
  assert.equal(classifyDocumentField(resumeInput), 'resume');
});

test('extractPhoneCountryCode returns only the international dialing code', () => {
  assert.equal(extractPhoneCountryCode('+1-669-377-4521'), '+1');
  assert.equal(extractPhoneCountryCode('+442071838750'), '+44');
  assert.equal(extractPhoneCountryCode('+91 98765 43210'), '+91');
  assert.equal(extractPhoneCountryCode('669-377-4521'), '');
});

test('fillPage puts only the dialing code in a phone country-code field', async () => {
  const countryCode = field({ autocomplete: 'tel-country-code' }, 'Country code');
  countryCode.tagName = 'INPUT';
  countryCode.disabled = false;
  countryCode.readOnly = false;
  countryCode.value = '';
  countryCode.dispatchEvent = () => {};

  const result = await fillPage({
    querySelectorAll: () => [countryCode]
  }, {
    autofill: {
      identity: { phone: '+1-669-377-4521' },
      demographics: {}
    }
  });

  assert.equal(countryCode.value, '+1');
  assert.equal(result.filled.length, 1);
});

test('fillPage keeps grouped country code and phone values separate', async () => {
  const fieldEntry = { textContent: 'Country Phone +1 669-377-4521' };
  const country = field({ id: 'country-selector', role: 'combobox' }, 'Country');
  country.tagName = 'INPUT';
  country.disabled = false;
  country.readOnly = false;
  country.value = '';
  country.click = () => {};
  country.dispatchEvent = () => {};
  country.closest = (selector) => selector.includes('[data-field-entry]') ? fieldEntry : null;

  const phone = field({ id: 'phone', autocomplete: 'tel' }, 'Phone');
  phone.tagName = 'INPUT';
  phone.disabled = false;
  phone.readOnly = false;
  phone.value = '';
  phone.dispatchEvent = () => {};
  phone.closest = (selector) => selector.includes('[data-field-entry]') ? fieldEntry : null;

  const countryOption = {
    textContent: 'United States (+1)',
    value: '+1',
    click() { country.value = '+1'; },
    getAttribute: () => null
  };
  const doc = {
    querySelectorAll(selector) {
      if (selector.includes('input') && selector.includes('[role="combobox"]')) return [country, phone];
      if (selector === '[role="option"]') return [countryOption];
      return [];
    }
  };
  country.ownerDocument.defaultView = { Event };
  phone.ownerDocument.defaultView = { Event };

  const result = await fillPage(doc, {
    autofill: {
      identity: { phone: '+1-669-377-4521' },
      demographics: {}
    }
  });

  assert.equal(country.value, '+1');
  assert.equal(phone.value, '+1-669-377-4521');
  assert.equal(result.filled.length, 2);
});

test('pageMetadata prefers JobPosting JSON-LD for company and role', () => {
  const jobPosting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Product Data Science Intern',
    hiringOrganization: { '@type': 'Organization', name: 'Acme Analytics' }
  };
  const doc = {
    title: 'Apply now',
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === 'script[type="application/ld+json"]'
        ? [{ textContent: JSON.stringify(jobPosting) }]
        : [];
    }
  };
  assert.deepEqual(pageMetadata(doc, 'https://jobs.example.com/123'), {
    url: 'https://jobs.example.com/123',
    role: 'Product Data Science Intern',
    company: 'Acme Analytics'
  });
});

test('pageMetadata parses application titles and ATS company slugs', () => {
  const doc = {
    title: 'Application for Data Science Intern at Example Labs',
    querySelector: () => null,
    querySelectorAll: () => []
  };
  assert.deepEqual(pageMetadata(doc, 'https://jobs.ashbyhq.com/example-labs/123#apply'), {
    url: 'https://jobs.ashbyhq.com/example-labs/123',
    role: 'Data Science Intern',
    company: 'Example Labs'
  });
});

test('optionMatches supports saved values and decline aliases', () => {
  assert.equal(optionMatches('Prefer not to say', 'I decline to self-identify', 'gender'), true);
  assert.equal(optionMatches('he/him', 'He/Him', 'pronouns'), true);
  assert.equal(optionMatches('No sponsorship required', 'Yes, I require sponsorship', 'sponsorship'), false);
  assert.equal(optionMatches('Male', 'Female', 'gender'), false);
  assert.equal(optionMatches('No, I do not have a disability', 'No, I do not wish to answer', 'disabilityStatus'), false);
  assert.equal(optionMatches('No, I do not have a disability', "No, I don't have a disability and have not had one in the past", 'disabilityStatus'), true);
  assert.equal(optionMatches('I am not a protected veteran', 'I have never served in the military', 'veteranStatus'), true);
  assert.equal(optionMatches('Asian', 'Asian (United States of America)', 'raceEthnicity'), true);
  assert.equal(optionMatches('No', 'No, I do not identify as Hispanic or Latino', 'hispanicLatino'), true);
  assert.equal(optionMatches('No', 'Yes, Hispanic or Latino', 'hispanicLatino'), false);
});

test('fillPage selects button-style demographic dropdowns from nearby question text', async () => {
  function dropdown(question, options) {
    const parent = { tagName: 'DIV', textContent: `${question} Select One`, parentElement: { tagName: 'FORM' } };
    const button = {
      id: '',
      type: 'button',
      tagName: 'BUTTON',
      textContent: 'Select One',
      disabled: false,
      parentElement: parent,
      ownerDocument: { querySelector: () => null, getElementById: () => null },
      getAttribute(attribute) {
        if (attribute === 'role') return 'button';
        if (attribute === 'aria-haspopup') return 'listbox';
        return null;
      },
      closest(selector) {
        if (selector === 'label' || selector === 'fieldset') return null;
        return null;
      },
      click() {
        activeOptions = options.map((text) => ({
          textContent: text,
          value: '',
          getAttribute(attribute) {
            return attribute === 'role' ? 'option' : null;
          },
          click() {
            button.textContent = text;
            activeOptions = [];
          }
        }));
      }
    };
    return button;
  }

  let activeOptions = [];
  const hispanic = dropdown('Please indicate if you identify yourself as Hispanic or Latino.', [
    'Yes, Hispanic or Latino',
    'No, I do not identify as Hispanic or Latino',
    'I do not wish to answer'
  ]);
  const ethnicity = dropdown('Please select the ethnicity which most accurately describes how you identify yourself.', [
    'Asian',
    'Black or African American',
    'White'
  ]);
  const veteran = dropdown('Please indicate your veteran status.', [
    'I am not a protected veteran',
    'I identify as a protected veteran',
    'I do not wish to answer'
  ]);
  const gender = dropdown('Please indicate your gender.', ['Male', 'Female', 'I do not wish to answer']);
  const controls = [hispanic, ethnicity, veteran, gender];

  const result = await fillPage({
    querySelectorAll(selector) {
      if (selector === '[role="option"]') return activeOptions;
      return controls;
    }
  }, {
    autofill: {
      identity: {},
      demographics: {
        raceEthnicity: 'Asian',
        veteranStatus: 'I am not a protected veteran',
        gender: 'Male'
      }
    }
  });

  assert.equal(hispanic.textContent, 'No, I do not identify as Hispanic or Latino');
  assert.equal(ethnicity.textContent, 'Asian');
  assert.equal(veteran.textContent, 'I am not a protected veteran');
  assert.equal(gender.textContent, 'Male');
  assert.equal(result.filled.length, 4);
});

test('fillPage reports when a page has no supported fields', async () => {
  const result = await fillPage({
    querySelectorAll: () => [
      field({ id: 'search', name: 'search', type: 'search' }, 'Search')
    ]
  }, { autofill: { identity: { email: 'nolan@example.com' }, demographics: {} } });

  assert.deepEqual(result, {
    filled: [],
    skipped: [],
    matchedCount: 0,
    scannedCount: 1
  });
});

test('fillPage selects Ashby-style demographic radio controls', async () => {
  const gender = [
    ashbyRadio('Gender', 'Male', 'eeoc_gender'),
    ashbyRadio('Gender', 'Female', 'eeoc_gender')
  ];
  const sponsorship = [
    ashbyRadio('At the moment, do you require sponsorship to work in the United States?', 'Yes', 'sponsorship'),
    ashbyRadio('At the moment, do you require sponsorship to work in the United States?', 'No', 'sponsorship')
  ];
  const elements = [...gender, ...sponsorship];
  const result = await fillPage({
    querySelectorAll: () => elements
  }, {
    autofill: {
      identity: {},
      demographics: {
        gender: 'Male',
        sponsorship: 'No, I do not require sponsorship'
      }
    }
  });

  assert.equal(gender[0].checked, true);
  assert.equal(gender[1].checked, false);
  assert.equal(sponsorship[0].checked, false);
  assert.equal(sponsorship[1].checked, true);
  assert.equal(result.filled.length, 2);
});
