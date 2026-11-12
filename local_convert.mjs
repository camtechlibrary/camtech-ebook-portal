import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const inputDir = process.argv[2] || path.join(process.env.HOME, 'Downloads/epubs');
const outputDir = path.join(process.cwd(), 'converted_pdfs');

if (!fs.existsSync(inputDir)) {
  console.error(`❌ Input directory not found: ${inputDir}`);
  process.exit(1);
}

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const converter = execSync('find /Volumes /Applications ~/Downloads -maxdepth 5 -name "ebook-convert" 2>/dev/null | head -n 1')
  .toString()
  .trim();

if (!converter) {
  console.error("❌ Calibre CLI (ebook-convert) not found.");
  process.exit(1);
}

const files = fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.epub'));
console.log(`📚 Found ${files.length} local EPUB file(s) in ${inputDir}`);

let successCount = 0;
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const epubPath = path.join(inputDir, file);
  const pdfName = file.replace(/\.epub$/i, '.pdf');
  const pdfPath = path.join(outputDir, pdfName);

  if (fs.existsSync(pdfPath)) {
    console.log(`[${i + 1}/${files.length}] ⏭️  Skipping existing: ${pdfName}`);
    continue;
  }

  console.log(`[${i + 1}/${files.length}] ⚙️  Converting ${file}...`);
  try {
    execSync(`"${converter}" "${epubPath}" "${pdfPath}" --paper-size letter`, { stdio: 'ignore' });
    console.log(`✅ Converted: ${pdfName}`);
    successCount++;
  } catch (err) {
    console.error(`❌ Failed: ${file}`);
  }
}

console.log(`\n🎉 Finished! Converted ${successCount} PDFs.`);
console.log(`📁 All output files are located in: ${outputDir}`);
