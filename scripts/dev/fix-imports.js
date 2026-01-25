#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to recursively find all .ts files
function findTSFiles(dir, files = []) {
  const entries = fs.readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.git')) {
      findTSFiles(fullPath, files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// Function to fix imports in a file
function fixImports(filePath) {
  console.log(`Processing: ${filePath}`);
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  
  // Fix relative imports that don't end with .js
  const importRegex = /import\s+.*?\s+from\s+['"](\.[^'"]+)['"];?/g;
  
  content = content.replace(importRegex, (match, importPath) => {
    // Skip if already has .js extension
    if (importPath.endsWith('.js')) {
      return match;
    }
    
    // Skip node_modules imports
    if (!importPath.startsWith('.')) {
      return match;
    }
    
    // Add .js extension for local imports
    const newImportPath = importPath.endsWith('/index') ? 
      importPath.replace('/index', '/index.js') : 
      importPath + '.js';
    
    const newMatch = match.replace(importPath, newImportPath);
    
    if (newMatch !== match) {
      console.log(`  Fixed: ${importPath} → ${newImportPath}`);
      changed = true;
    }
    
    return newMatch;
  });
  
  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✅ Updated ${filePath}`);
  }
  
  return changed;
}

// Main execution
const srcDir = path.join(__dirname, 'src');
const tsFiles = findTSFiles(srcDir);

console.log(`Found ${tsFiles.length} TypeScript files to process...\n`);

let totalChanged = 0;
for (const file of tsFiles) {
  if (fixImports(file)) {
    totalChanged++;
  }
}

console.log(`\n✅ Processing complete! Fixed imports in ${totalChanged} files.`);