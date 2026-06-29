(() => {
  async function request(path, options = {}) {
    const response = await fetch(path, {
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...options
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) throw new Error('The app returned an invalid response. Restart Career Ops and try again.');
      }
    }
    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function post(path, payload = {}) {
    return request(path, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  function chooseFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
      input.click();
    });
  }

  window.careerOps = {
    load: () => request('/api/dashboard'),
    cloudStatus: () => request('/api/cloud/status'),
    cloudLogin: () => post('/api/cloud/login'),
    cloudLogout: () => post('/api/cloud/logout'),
    syncCloudFeed: () => post('/api/cloud/sync'),
    cloudFeedback: (payload) => post('/api/cloud/feedback', payload),
    scan: () => post('/api/scan'),
    addPendingJob: (payload) => post('/api/pending-job', payload),
    importDiscoverySource: async (payload) => {
      try {
        return await post('/api/discovery-source', payload);
      } catch (error) {
        if (error.status === 404) {
          throw new Error('The Discovery importer server is out of date. Restart Career Ops, then try the import again.');
        }
        throw error;
      }
    },
    refreshDiscovery: () => post('/api/discovery-refresh'),
    deleteDiscoverySource: (payload) => post('/api/discovery-source/delete', payload),
    updateDiscoverySource: (payload) => post('/api/discovery-source/update', payload),
    addDashboardJob: async (payload) => {
      try {
        return await post('/api/dashboard-job', payload);
      } catch (error) {
        if (error.status === 404) {
          throw new Error('Restart Career Ops to activate dashboard job saving, then submit this link again.');
        }
        throw error;
      }
    },
    openExternal: (url) => {
      if (window.careerOpsDesktop) return window.careerOpsDesktop.openExternal(url);
      window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve({ ok: true });
    },
    openPath: (targetPath) => {
      if (window.careerOpsDesktop) return window.careerOpsDesktop.openPath(targetPath);
      window.open(`/api/open-path?path=${encodeURIComponent(targetPath)}`, '_blank', 'noopener,noreferrer');
      return Promise.resolve({ ok: true });
    },
    updateStatus: (payload) => post('/api/update-status', payload),
    updateApplicationNotes: (payload) => post('/api/application-notes', payload),
    generateApplicationReport: (payload) => post('/api/application-report', payload),
    saveSettings: (payload) => post('/api/settings', payload),
    saveSetupSettings: (payload) => post('/api/setup-settings', payload),
    testSetup: () => post('/api/test-setup'),
    extensionContext: () => request('/api/extension/context'),
    saveResume: (payload) => post('/api/resume', payload),
    uploadResume: async () => {
      const file = await chooseFile('.pdf,.docx,.md,.txt');
      if (!file) return null;
      const form = new FormData();
      form.append('resume', file);
      return request('/api/resume/upload', { method: 'POST', body: form });
    },
    getResume: (id) => request(`/api/resumes/${encodeURIComponent(id)}`),
    setPrimaryResume: (payload) => post('/api/resumes/primary', payload),
    renameResume: (payload) => post('/api/resumes/rename', payload),
    deleteResume: (payload) => post('/api/resumes/delete', payload),
    getResumeBuilder: () => request('/api/resume-builder'),
    getResumeBuilderVariant: (id) => request(`/api/resume-builder/${encodeURIComponent(id)}`),
    createMasterResume: (payload) => post('/api/resume-builder/master', payload),
    createTailoredResume: (payload) => post('/api/resume-builder/tailored', payload),
    reviewResumeForJob: (payload) => post('/api/resume-builder/review', payload),
    generateTailoredResume: (payload) => post('/api/resume-builder/generate', payload),
    saveResumeBuilderVariant: (payload) => post('/api/resume-builder/save', payload),
    decideResumeBuilderSuggestion: (payload) => post('/api/resume-builder/suggestion', payload),
    deleteResumeBuilderVariant: (payload) => post('/api/resume-builder/delete', payload),
    exportResumeBuilderVariant: (payload) => post('/api/resume-builder/export', payload),
    getKnowledge: () => request('/api/knowledge'),
    uploadKnowledgeDocument: async () => {
      const file = await chooseFile('.pdf,.docx,.md,.txt');
      if (!file) return null;
      const form = new FormData();
      form.append('document', file);
      return request('/api/knowledge/upload', { method: 'POST', body: form });
    },
    addKnowledgeFact: (payload) => post('/api/knowledge/facts', payload),
    updateKnowledgeFact: (payload) => post('/api/knowledge/facts/update', payload),
    updateKnowledgeRecord: (payload) => post('/api/knowledge/records/update', payload),
    chatKnowledge: (payload) => post('/api/knowledge/chat', payload),
    setKnowledgeFactStatus: (payload) => post('/api/knowledge/facts/status', payload),
    deleteKnowledgeFact: (payload) => post('/api/knowledge/facts/delete', payload),
    clearKnowledge: () => post('/api/knowledge/clear'),
    rebuildKnowledge: () => post('/api/knowledge/rebuild'),
    saveAiSettings: (payload) => post('/api/ai-settings', payload),
    testAi: () => post('/api/test-ai'),
    pickCoverLetterFolder: async () => {
      if (window.careerOpsDesktop) {
        const outputDir = await window.careerOpsDesktop.pickFolder('Choose the cover letter output folder');
        if (!outputDir) return null;
        return post('/api/cover-letter-folder', { outputDir });
      }
      const outputDir = window.prompt('Server folder for generated cover letters');
      if (!outputDir) return null;
      return post('/api/cover-letter-folder', { outputDir });
    },
    coverLetter: (row) => post('/api/cover-letter', row),
    saveCoverLetter: (payload) => post('/api/cover-letter/save', payload),
    exportCoverLetterPdf: (payload) => post('/api/cover-letter/pdf', payload),
    generateAutofillPrompt: async (payload) => {
      const result = await post('/api/autofill-prompt', payload);
      if (result.content && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.content);
        result.copied = true;
      }
      return result;
    },
    evaluatePending: (payload) => post('/api/evaluate-pending', payload),
    runBulkQueue: (payload) => post('/api/bulk-queue', payload),
    onBulkQueueProgress: (callback) => {
      const events = new EventSource('/api/bulk-events');
      events.onmessage = (event) => callback(JSON.parse(event.data));
      return () => events.close();
    },
    discardPending: (payload) => post('/api/discard-pending', payload),
    checkPendingAvailability: (payload) => post('/api/check-pending-availability', payload),
    pickRoot: async () => {
      if (window.careerOpsDesktop) {
        const rootPath = await window.careerOpsDesktop.pickRoot();
        if (!rootPath) return null;
        const result = await post('/api/root', { rootPath });
        return result.root;
      }
      const rootPath = window.prompt('Server path to the Career Ops data/runtime folder');
      if (!rootPath) return null;
      const result = await post('/api/root', { rootPath });
      return result.root;
    }
  };
})();
