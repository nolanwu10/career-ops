import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const additionsDir = path.join(root, 'batch', 'tracker-additions');
const trackerPath = path.join(root, 'data', 'applications.md');

const files = fs.existsSync(additionsDir)
  ? fs.readdirSync(additionsDir).filter((name) => name.endsWith('.tsv')).sort()
  : [];

for (const name of files) {
  const line = fs.readFileSync(path.join(additionsDir, name), 'utf8').trim();
  if (!line) continue;
  const [number, date, company, role, status, score, pdf, report, notes] = line.split('\t');
  const row = `| ${number} | ${date} | ${company} | ${role} | ${score} | ${status} | ${pdf} | ${report} | ${notes} |`;
  fs.appendFileSync(trackerPath, `\n${row}`, 'utf8');
  fs.rmSync(path.join(additionsDir, name));
}

