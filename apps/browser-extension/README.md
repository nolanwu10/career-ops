# Career Ops Companion

## Local installation

1. Start the Career Ops web app:
   `cd apps/desktop && npm start`
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select this `browser-extension` folder.
5. Open a job application page and click the extension toolbar icon to open the compact Career Ops panel. Click the icon again or use the close button to hide it.
6. Open the extension options and save any demographic answers you want autofilled.
7. After updating the extension, click **Reload** on `chrome://extensions` and refresh any already-open application tabs.

The extension can scan any normal website and its accessible embedded frames for supported application fields. If none are found, it reports that no supported fields matched. Chrome blocks extensions from internal pages such as `chrome://extensions` and the Chrome Web Store.

The compact companion panel opens only when you click the extension toolbar icon. It is injected only into the top-level page, not into embedded application frames.

Autofill also attaches the selected primary resume to confidently labeled Resume/CV file fields. When the current tracked job has a linked cover letter, it attaches that document to confidently labeled Cover Letter fields. Supported upload formats are PDF, DOC, DOCX, RTF, and TXT.

The extension never submits an application. It fills high-confidence fields and requires confirmation before logging an application as Applied.
