const fs = require('fs');
const path = require('path');

const dirs = ['src/main/chapters/en', 'src/main/chapters/ru'];
const basePath = './';

const getFiles = (dir) => fs.readdirSync(path.join(basePath, dir)).filter(f => f.endsWith('.md'));

const enFiles = getFiles('en');
let hasError = false;

enFiles.forEach(file => {
  const ruPath = path.join(basePath, 'ru', file);
  if (!fs.existsSync(ruPath)) {
    console.warn(`⚠️  ${file}: missing in /ru`);
    return;
  }

  const enContent = fs.readFileSync(path.join(basePath, 'en', file), 'utf8');
  const ruContent = fs.readFileSync(ruPath, 'utf8');

  const enLines = enContent.split('\n');
  const ruLines = ruContent.split('\n');

  if (enLines.length !== ruLines.length) {
    console.error(`\n❌ ${file}: en=${enLines.length} lines, ru=${ruLines.length} lines`);

    const maxLines = Math.max(enLines.length, ruLines.length);
    let diffCount = 0;

    for (let i = 0; i < maxLines; i++) {
      const enLine = i < enLines.length ? enLines[i] : '(missing)';
      const ruLine = i < ruLines.length ? ruLines[i] : '(missing)';

      if (enLine !== ruLine) {
        diffCount++;
        if (diffCount <= 5) {
          console.log(`  Line ${i+1}:`);
          console.log(`    en: "${enLine.substring(0, 80)}${enLine.length > 80 ? '...' : ''}"`);
          console.log(`    ru: "${ruLine.substring(0, 80)}${ruLine.length > 80 ? '...' : ''}"`);
        }
      }
    }

    if (diffCount > 5) {
      console.log(`  ... and ${diffCount - 5} more line mismatches`);
    }
    console.log(`  Total mismatched lines: ${diffCount}\n`);
    hasError = true;
  }
});

if (hasError) {
  process.exit(1);
}