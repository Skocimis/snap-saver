require('dotenv').config();
const express = require('express');
const cors = require('cors');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { buildContractMap, buildSignatureMap } = require('./build-maps');

// Build clear signing maps on startup
console.log('Building clear signing maps...');
const map1 = buildContractMap(); // chainId:address -> file
const map2 = buildSignatureMap(); // selector -> file
console.log(`  Map1 (contract deployments): ${Object.keys(map1).length} entries`);
console.log(`  Map2 (function signatures): ${Object.keys(map2).length} entries`);

// Save maps to JSON files for inspection (not used by the app)
fs.writeFileSync(path.join(__dirname, 'map1.json'), JSON.stringify(map1, null, 2));
fs.writeFileSync(path.join(__dirname, 'map2.json'), JSON.stringify(map2, null, 2));
console.log('  Maps saved to map1.json and map2.json for inspection');

// Load the proto file
const PROTO_PATH = path.join(__dirname, 'proto', 'parser', 'parser.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.join(__dirname, 'proto')]
});

const parserProto = grpc.loadPackageDefinition(packageDefinition).parser;

// Create gRPC client
const client = new parserProto.ParserService(
    '64.226.71.84:44020',
    grpc.credentials.createInsecure()
);

// Create Express app
const app = express();

// Enable CORS for all origins
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// POST /parse-visualsign endpoint
app.post('/parse-visualsign', async (req, res) => {
    try {
        console.log(`\n[${new Date().toISOString()}] Parsing visualsign...`);
        const { data, chainId } = req.body;

        if (!data) {
            return res.status(400).json({
                ok: false,
                error: 'Missing "data" field in request body'
            });
        }

        if (!chainId) {
            return res.status(400).json({
                ok: false,
                error: 'Missing "chainId" field in request body'
            });
        }

        console.log(`\n[${new Date().toISOString()}] Parsing transaction...`);
        console.log('  Data:', data.substring(0, 66) + '...');
        console.log('  Data Length:', data.length, 'characters');
        console.log('  Chain ID:', chainId);

        // Create parse request for gRPC
        const request = {
            unsigned_payload: data,
            chain: 'CHAIN_ETHEREUM',
            chain_metadata: {
                ethereum: {
                    // Chain ID is already in the transaction
                }
            }
        };

        // Send to parser
        client.Parse(request, (error, grpcResponse) => {
            if (error) {
                console.error('  Parser Error:', error.message);
                return res.status(500).json({
                    ok: false,
                    error: error.message,
                    details: error.details
                });
            }

            try {
                const parsed = JSON.parse(grpcResponse.parsed_transaction.payload.signable_payload);
                console.log('  ✓ Successfully parsed', parsed, "\n");

                return res.json({
                    ok: true,
                    parsed: parsed
                });
            } catch (parseError) {
                console.error('  JSON Parse Error:', parseError.message);
                return res.status(500).json({
                    ok: false,
                    error: 'Failed to parse response',
                    details: parseError.message
                });
            }
        });

    } catch (error) {
        console.error('  Error:', error.message);
        return res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// POST /parse-clearsigning endpoint
app.post('/parse-clearsigning', async (req, res) => {
    try {
        const { data, chainId } = req.body;

        console.log({ data, chainId })

        if (!data) {
            return res.status(400).json({
                ok: false,
                error: 'Missing "data" field in request body'
            });
        }

        if (!chainId) {
            return res.status(400).json({
                ok: false,
                error: 'Missing "chainId" field in request body'
            });
        }

        console.log(`\n[${new Date().toISOString()}] Parsing clear signing...`);
        console.log('  Data:', data.substring(0, 66) + '...');
        console.log('  Chain ID:', chainId);

        // Parse the transaction to extract calldata and contract address
        const txData = ethers.utils.parseTransaction(data);
        const calldata = txData.data;
        const contractAddress = txData.to ? txData.to.toLowerCase() : null;

        if (!calldata || calldata === '0x') {
            return res.status(400).json({
                ok: false,
                error: 'No calldata found in transaction'
            });
        }

        // Extract function selector (first 4 bytes)
        const selector = calldata.substring(0, 10); // 0x + 8 hex chars
        console.log('  Selector:', selector);
        console.log('  Contract:', contractAddress);

        // Try to resolve descriptor file using maps
        let descriptorPath = null;

        // First try map1 (chainId:address -> file)
        if (contractAddress) {
            const contractKey = `${chainId}:${contractAddress}`;
            descriptorPath = map1[contractKey];
            if (descriptorPath) {
                console.log('  Resolved via Map1 (contract deployment)');
            }
        }

        // If not found, try map2 (selector -> file)
        if (!descriptorPath) {
            descriptorPath = map2[selector];
            if (descriptorPath) {
                console.log('  Resolved via Map2 (function signature)');
            }
        }

        // If still not found, return empty response (no error)
        if (!descriptorPath) {
            console.log('  No descriptor found, returning empty response');
            return res.json({
                ok: true,
                intent: 'Unknown action',
                functionSignature: null,
                fields: [],
                metadata: {
                    contractAddress: contractAddress,
                    calldata: calldata
                }
            });
        }

        // Load the descriptor
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
        console.log('  Descriptor:', path.relative(__dirname, descriptorPath));

        // Find matching format in descriptor
        const formats = descriptor.display.formats;

        let matchingFormat = null;
        let matchingSig = null;
        let paramDefs = [];

        for (const [sigOrHash, format] of Object.entries(formats)) {
            let matched = false;

            // Check if key is already a hash (starts with 0x and is 10 chars)
            if (sigOrHash.startsWith('0x') && sigOrHash.length === 10) {
                // Direct hash match
                if (sigOrHash === selector) {
                    matchingFormat = format;
                    matchingSig = sigOrHash;
                    matched = true;
                    // For hash-based keys, we need to get ABI from context to decode params
                    // For now, we'll handle this case specially
                }
            } else {
                // Parse signature: "functionName(type1 name1, type2 name2, ...)"
                const funcMatch = sigOrHash.match(/^(\w+)\((.*)\)$/);
                if (!funcMatch) continue;

                const funcName = funcMatch[1];
                const paramsStr = funcMatch[2];

                // Parse parameters and extract types
                const params = paramsStr ? paramsStr.split(',').map(p => p.trim()) : [];
                const paramTypes = params.map(p => {
                    const parts = p.split(' ');
                    return parts[0]; // First part is the type
                });
                const paramNames = params.map(p => {
                    const parts = p.split(' ');
                    return parts[1] || `param${params.indexOf(p)}`; // Second part is the name
                });

                // Create canonical signature for keccak
                const canonicalSig = `${funcName}(${paramTypes.join(',')})`;
                const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalSig));
                const computedSelector = hash.substring(0, 10); // 0x + 8 hex chars

                if (computedSelector === selector) {
                    matchingFormat = format;
                    matchingSig = sigOrHash;
                    paramDefs = params.map((p, i) => ({
                        type: paramTypes[i],
                        name: paramNames[i]
                    }));
                    matched = true;
                }
            }

            if (matched) break;
        }

        if (!matchingFormat) {
            return res.status(404).json({
                ok: false,
                error: `No clear signing format found for selector ${selector}`,
                availableFunctions: Object.keys(formats)
            });
        }

        console.log('  Matched function:', matchingSig);

        // Decode calldata - try to get parameter names from ABI in context
        let paramTypes = [];
        let paramNames = [];

        if (paramDefs.length > 0) {
            // We have params from signature parsing
            paramTypes = paramDefs.map(p => p.type);
            paramNames = paramDefs.map(p => p.name);
        }

        // Try to get better parameter names from ABI if available
        const abi = descriptor.context?.contract?.abi;
        if (abi && Array.isArray(abi)) {
            // Find matching function in ABI
            const abiFunction = abi.find(item => {
                if (item.type === 'function') {
                    const abiSig = `${item.name}(${item.inputs.map(i => i.type).join(',')})`;
                    const abiHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(abiSig)).substring(0, 10);
                    return abiHash === selector;
                }
                return false;
            });

            if (abiFunction) {
                paramTypes = abiFunction.inputs.map(i => i.type);
                paramNames = abiFunction.inputs.map(i => i.name || `param${abiFunction.inputs.indexOf(i)}`);
            }
        }

        const calldataBytes = Buffer.from(calldata.substring(10), 'hex'); // Skip 0x and selector

        let decodedParams;
        try {
            const decoded = ethers.utils.defaultAbiCoder.decode(paramTypes, calldataBytes);
            decodedParams = {};
            paramNames.forEach((name, i) => {
                decodedParams[name] = decoded[i];
            });
        } catch (e) {
            return res.status(400).json({
                ok: false,
                error: `Failed to decode calldata: ${e.message}`
            });
        }

        // Format fields according to descriptor
        const fields = matchingFormat.fields || [];
        const required = matchingFormat.required || [];
        const excluded = matchingFormat.excluded || [];

        const formattedFields = [];

        for (const field of fields) {
            const fieldPath = field.path;

            // Skip excluded fields
            if (excluded.includes(fieldPath)) {
                continue;
            }

            // Handle special @ paths for transaction-level fields
            let value;
            if (fieldPath.startsWith('@.')) {
                const txField = fieldPath.substring(2); // Remove '@.'
                if (txField === 'value') {
                    value = txData.value || '0x0';
                } else if (txField === 'to') {
                    value = txData.to;
                } else if (txField === 'from') {
                    value = txData.from;
                }
            } else {
                value = decodedParams[fieldPath];
            }

            const label = field.label || fieldPath;
            const format = field.format || 'raw';
            const isRequired = required.includes(fieldPath);

            let formattedValue;

            // Format value based on type
            if (format === 'amount') {
                // Format ETH amount from wei
                if (value) {
                    const valueStr = value.toString();
                    const weiValue = ethers.BigNumber.from(valueStr);
                    formattedValue = ethers.utils.formatEther(weiValue) + ' ETH';
                } else {
                    formattedValue = '0 ETH';
                }
            } else if (format === 'tokenAmount') {
                // For now, just show the raw value (would need token decimals for proper formatting)
                const max = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
                if (value && value.toString() === max) {
                    formattedValue = field.params?.message || 'Max';
                } else {
                    formattedValue = value ? value.toString() : '0';
                }
            } else if (format === 'addressName') {
                formattedValue = value || '0x0';
            } else if (format === 'enum') {
                // Look up enum value
                const enumRef = field.params?.$ref;
                if (enumRef) {
                    const enumPath = enumRef.replace('$.metadata.enums.', '');
                    const enumValues = descriptor.metadata?.enums?.[enumPath];
                    if (enumValues && value) {
                        formattedValue = enumValues[value.toString()] || value.toString();
                    } else {
                        formattedValue = value ? value.toString() : '';
                    }
                } else {
                    formattedValue = value ? value.toString() : '';
                }
            } else {
                // raw format
                formattedValue = value !== undefined ? value.toString() : '';
            }

            formattedFields.push({
                path: fieldPath,
                label: label,
                value: formattedValue,
                rawValue: value !== undefined ? value.toString() : '',
                format: format,
                required: isRequired
            });
        }

        // Get metadata
        const metadata = descriptor.metadata || {};

        console.log('  ✓ Successfully parsed clear signing');

        return res.json({
            ok: true,
            intent: matchingFormat.intent || 'Unknown action',
            functionSignature: matchingSig,
            fields: formattedFields,
            metadata: {
                owner: metadata.owner,
                info: metadata.info,
                contractAddress: txData.to,
                calldata: calldata
            }
        });

    } catch (error) {
        console.error('  Error:', error.message);
        console.error(error.stack);
        return res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'healthy' });
});

// Start server
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`\n🚀 Parser API Server listening on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /parse-visualsign - Parse with VisualSign (gRPC)`);
    console.log(`  POST /parse-clearsigning - Parse with ERC-7730 Clear Signing`);
    console.log(`       Body: {"data": "0x<rlp_encoded_tx>", "chainId": <number>}`);
    console.log(`  GET  /health - Health check`);
    console.log();
});

require("./build-maps")
