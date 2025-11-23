const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// Recursively find all JSON files in a directory
function findJsonFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findJsonFiles(filePath, fileList);
    } else if (file.endsWith('.json') && !file.includes('.schema.json')) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

// Build map1: chainId+contractAddress -> file path
function buildContractMap() {
  const registryDir = path.join(__dirname, 'clear-signing', 'registry');
  const contractMap = {};

  if (!fs.existsSync(registryDir)) {
    // console.log('Registry directory not found:', registryDir);
    return contractMap;
  }

  const jsonFiles = findJsonFiles(registryDir);
  // console.log(`\nFound ${jsonFiles.length} files in registry`);

  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const descriptor = JSON.parse(content);

      // Check if this descriptor has contract deployments
      const deployments = descriptor.context?.contract?.deployments;

      if (deployments && Array.isArray(deployments)) {
        for (const deployment of deployments) {
          const { chainId, address } = deployment;

          if (chainId && address) {
            // Normalize address to lowercase
            const normalizedAddress = address.toLowerCase();
            const key = `${chainId}:${normalizedAddress}`;

            contractMap[key] = filePath;
            // console.log(`  ${key} -> ${path.relative(__dirname, filePath)}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error.message);
    }
  }

  return contractMap;
}

// Get priority for file based on filename
function getFilePriority(filePath) {
  const fileName = path.basename(filePath).toLowerCase();

  // Higher priority = more preferred
  if (fileName.includes('erc20') || fileName.includes('erc-20')) return 100;
  if (fileName.includes('erc721') || fileName.includes('erc-721')) return 90;
  if (fileName.includes('erc1155') || fileName.includes('erc-1155')) return 80;
  if (fileName.includes('token')) return 70;
  if (fileName.includes('erc')) return 50;

  // Registry files get lowest priority
  if (filePath.includes('registry')) return 5;

  return 10; // Default priority
}

// Build map2: signatureHash -> file path
function buildSignatureMap() {
  const ercsDir = path.join(__dirname, 'clear-signing', 'ercs');
  const registryDir = path.join(__dirname, 'clear-signing', 'registry');
  const signatureMap = {};
  const conflicts = {}; // Track conflicts for logging

  // Collect files from both ercs and registry directories
  const ercsFiles = fs.existsSync(ercsDir) ? findJsonFiles(ercsDir) : [];
  const registryFiles = fs.existsSync(registryDir) ? findJsonFiles(registryDir) : [];
  const allFiles = [...ercsFiles, ...registryFiles];

  // Sort files by priority (ERCs first, registry last)
  const sortedFiles = allFiles.sort((a, b) => {
    return getFilePriority(b) - getFilePriority(a);
  });

  for (const filePath of sortedFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const descriptor = JSON.parse(content);

      // Get function signatures from display.formats
      const formats = descriptor.display?.formats;

      if (formats && typeof formats === 'object') {
        for (const signatureOrHash of Object.keys(formats)) {
          let selector;

          // Check if key is already a hash (starts with 0x and is 10 chars)
          if (signatureOrHash.startsWith('0x') && signatureOrHash.length === 10) {
            // Already a selector hash
            selector = signatureOrHash;
          } else {
            // Parse signature to get canonical form
            const funcMatch = signatureOrHash.match(/^(\w+)\((.*)\)$/);
            if (!funcMatch) {
              console.warn(`  Invalid signature format: ${signatureOrHash}`);
              continue;
            }

            const funcName = funcMatch[1];
            const paramsStr = funcMatch[2];

            // Extract parameter types (remove names)
            const params = paramsStr ? paramsStr.split(',').map(p => p.trim()) : [];
            const paramTypes = params.map(p => {
              const parts = p.split(' ');
              return parts[0]; // First part is the type
            });

            // Create canonical signature
            const canonicalSig = `${funcName}(${paramTypes.join(',')})`;

            // Calculate keccak256 hash
            const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalSig));
            selector = hash.substring(0, 10); // 0x + 8 hex chars
          }

          // Check if selector already exists
          if (signatureMap[selector]) {
            const existingFile = signatureMap[selector];
            const existingPriority = getFilePriority(existingFile);
            const newPriority = getFilePriority(filePath);

            // Track conflict
            if (!conflicts[selector]) {
              conflicts[selector] = {
                signature: signatureOrHash,
                files: [existingFile]
              };
            }
            conflicts[selector].files.push(filePath);

            // Only replace if new file has higher priority
            if (newPriority > existingPriority) {
              signatureMap[selector] = filePath;
              // console.log(`  ${selector} (${signatureOrHash}) -> ${path.relative(__dirname, filePath)} [REPLACED, priority ${newPriority} > ${existingPriority}]`);
            } else {
              // console.log(`  ${selector} (${signatureOrHash}) -> ${path.relative(__dirname, filePath)} [SKIPPED, priority ${newPriority} <= ${existingPriority}]`);
            }
          } else {
            signatureMap[selector] = filePath;
            // console.log(`  ${selector} (${signatureOrHash}) -> ${path.relative(__dirname, filePath)}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error.message);
    }
  }

  // Log conflicts
  if (Object.keys(conflicts).length > 0) {
    // console.log('\n' + '-'.repeat(80));
    // console.log('CONFLICTS DETECTED (resolved by priority):');
    // console.log('-'.repeat(80));
    for (const [selector, conflict] of Object.entries(conflicts)) {
      // console.log(`\n${selector} (${conflict.signature}):`);
      conflict.files.forEach((file) => {
        const priority = getFilePriority(file);
        const chosen = signatureMap[selector] === file ? ' ← CHOSEN' : '';
        // console.log(`  [P${priority}] ${path.relative(__dirname, file)}${chosen}`);
      });
    }
  }

  return signatureMap;
}

// Main function
function main() {
  // console.log('Building clear signing maps...\n');
  // console.log('='.repeat(80));
  // console.log('MAP 1: Contract Deployments (chainId:address -> file)');
  // console.log('='.repeat(80));

  const contractMap = buildContractMap();

  // console.log('\n' + '='.repeat(80));
  // console.log('MAP 2: Function Signatures (selector -> file)');
  // console.log('='.repeat(80));

  const signatureMap = buildSignatureMap();

  // Save maps to JSON files
  const map1Path = path.join(__dirname, 'map1.json');
  const map2Path = path.join(__dirname, 'map2.json');

  fs.writeFileSync(map1Path, JSON.stringify(contractMap, null, 2));
  fs.writeFileSync(map2Path, JSON.stringify(signatureMap, null, 2));

  // console.log('\n' + '='.repeat(80));
  // console.log('Summary');
  // console.log('='.repeat(80));
  // console.log(`Contract deployments: ${Object.keys(contractMap).length}`);
  // console.log(`Function signatures: ${Object.keys(signatureMap).length}`);
  // console.log(`\nMaps saved to:`);
  // console.log(`  ${map1Path}`);
  // console.log(`  ${map2Path}`);
}

// Export functions for use in other modules
module.exports = {
  buildContractMap,
  buildSignatureMap
};

// Run main only if executed directly
if (require.main === module) {
  main();
}
