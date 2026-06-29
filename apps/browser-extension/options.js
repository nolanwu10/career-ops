const form = document.querySelector('#settingsForm');
const status = document.querySelector('#status');

load();

async function load() {
  const local = await chrome.storage.local.get('apiBaseUrl');
  const result = await chrome.runtime.sendMessage({ type: 'GET_CONTEXT' });
  if (!result.ok) {
    status.textContent = result.error || 'Set the Career Ops app URL, then make sure it is running.';
    form.elements.apiBaseUrl.value = local.apiBaseUrl || 'http://localhost:3000';
    return;
  }
  const settings = result.settings || {};
  form.elements.apiBaseUrl.value = local.apiBaseUrl || settings.apiBaseUrl || 'http://localhost:3000';
  for (const [key, value] of Object.entries(settings.contact || {})) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  for (const [key, value] of Object.entries(settings.demographics || {})) {
    if (form.elements[key]) setSelectValue(form.elements[key], value);
  }
  form.elements.showLogPrompt.checked = settings.showLogPrompt !== false;
  status.textContent = hasSavedDemographics(settings.demographics)
    ? 'Saved demographic preferences loaded.'
    : 'No demographic preferences are saved yet.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = 'Saving...';
  const contact = {};
  for (const name of ['addressLine1', 'addressLine2', 'city', 'state', 'phoneType']) {
    contact[name] = form.elements[name].value.trim();
  }
  const demographics = {};
  for (const name of ['workAuthorization', 'sponsorship', 'veteranStatus', 'disabilityStatus', 'gender', 'raceEthnicity', 'pronouns']) {
    demographics[name] = form.elements[name].value.trim();
  }
  const apiBaseUrl = form.elements.apiBaseUrl.value.trim();
  await chrome.storage.local.set({ apiBaseUrl });
  const result = await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    payload: { enabled: true, showLogPrompt: form.elements.showLogPrompt.checked, apiBaseUrl, contact, demographics }
  });
  status.textContent = result.ok ? 'Preferences saved locally.' : result.error;
});

function setSelectValue(select, value) {
  if (!value) {
    select.value = '';
    return;
  }
  const option = [...select.options].find((item) => item.value === value);
  if (option) {
    select.value = value;
    return;
  }
  const legacy = document.createElement('option');
  legacy.value = value;
  legacy.textContent = `${value} (saved custom value)`;
  select.appendChild(legacy);
  select.value = value;
}

function hasSavedDemographics(demographics = {}) {
  return Object.values(demographics).some((value) => String(value || '').trim());
}
