import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

if (fs.existsSync('.env.local')) dotenv.config({ path: '.env.local' });
else dotenv.config();

const folderId = process.env.VITE_GDRIVE_FOLDER_ID || process.env.VITE_DRIVE_FOLDER_ID || '15UGQUzCe7yz3xGlyZp_5fq11gD59fx1';
const apiKey = process.env.VITE_GDRIVE_API_KEY || process.env.VITE_DRIVE_API_KEY;

if (!apiKey || apiKey === '[UNSET]') {
  console.error("❌ VITE_GDRIVE_API_KEY is missing or set to '[UNSET]' in .env.local.");
  process.exit(1);
}

const converter = execSync('find /Volumes /Applications ~/Downloads -maxdepth 5 -name "ebook-convert" 2>/dev/null | head -n 1')
  .toString()
  .trim();

if (!converter) {
  console.error("❌ Calibre CLI (ebook-convert) not found.");
  process.exit(1);
}

async function fetchAllEpubs() {
  let files = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&pageSize=1000&fields=nextPageToken,files(id,name,mimeType)&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      throw new Error(`Drive API Error: ${data.error.message}`);
    }
    if (data.files) {
      const epubs = data.files.filter(f => f.name.toLowerCase().endsWith('.epub'));
      files.push(...epubs);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function run() {
  console.log("🔍 Fetching full EPUB list from Google Drive via API Key...");
  const files = await fetchAllEpubs();
  console.log(`\n📚 Found ${files.length} EPUB file(s) in Drive folder.`);

  const outputDir = path.join(process.cwd(), 'converted_pdfs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let successCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pdfName = file.name.replace(/\.epub$/i, '.pdf');
    const pdfPath = path.join(outputDir, pdfName);
    const tempEpubPath = path.join(outputDir, `temp_${file.id}.epub`);

    if (fs.existsSync(pdfPath)) {
      console.log(`[${i + 1}/${files.length}] ⏭️  Skipping (already converted): ${pdfName}`);
      continue;
    }

    console.log(`\n[${i + 1}/${files.length}] 📥 Downloading: ${file.name}`);
    
    let response = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${apiKey}`);
    if (!response.ok) {
      response = await fetch(`https://drive.google.com/uc?export=download&id=${file.id}`);
    }
    
    if (!response.ok) {
      console.error(`❌ Failed to download ${file.name}`);
      continue;
    }
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(tempEpubPath, Buffer.from(buffer));

    console.log(`⚙️  Converting to PDF...`);
    try {
      execSync(`"${converter}" "${tempEpubPath}" "${pdfPath}" --paper-size letter`, { stdio: 'ignore' });
      console.log(`✅ Saved: ${pdfName}`);
      successCount++;
    } catch (err) {
      console.error(`❌ Conversion failed for ${file.name}`);
    } finally {
      if (fs.existsSync(tempEpubPath)) fs.unlinkSync(tempEpubPath);
    }
  }

  console.log(`\n🎉 Processed ${files.length} files. Successfully converted ${successCount} new PDFs!`);
  console.log(`📁 All converted PDFs are saved in: ${outputDir}`);
}

run().catch(console.error);
