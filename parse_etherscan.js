require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');

// Hardcoded transaction hash
const txHash = '0x983cbdd3506eee1dec5c0ad2c7328e6d82fafd29c4afd86da8f230d2f799bf43';

async function getUnsignedTransactionData() {
    const apiKey = process.env.ETHERSCAN_API_KEY;

    if (!apiKey) {
        throw new Error('ETHERSCAN_API_KEY not found in .env file');
    }

    console.log('Fetching transaction from Etherscan...');
    console.log('Transaction Hash:', txHash);

    // Fetch transaction details
    const url = `https://api.etherscan.io/v2/api?chainid=42161&module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`;
    const response = await axios.get(url);

    if (response.data.error) {
        throw new Error(`Etherscan API error: ${JSON.stringify(response.data.error)}`);
    }

    if (response.data.status === '0' && response.data.message === 'NOTOK') {
        throw new Error(`Etherscan API error: ${response.data.result}`);
    }

    if (!response.data.result) {
        throw new Error('Transaction not found');
    }

    const tx = response.data.result;
    const chainId = parseInt(tx.chainId, 16) || 1;

    console.log('\nTransaction Details:');
    console.log('  Chain ID:', chainId);
    console.log('  From:', tx.from);
    console.log('  To:', tx.to);
    console.log('  Value:', tx.value);
    console.log('  Nonce:', tx.nonce);
    console.log('  Gas:', tx.gas);

    // Handle different transaction types (Legacy, EIP-2930, EIP-1559)
    const txType = tx.type ? parseInt(tx.type, 16) : 0;

    let txData;

    if (txType === 2) {
        // EIP-1559 transaction
        console.log('  Type: EIP-1559');
        txData = {
            type: 2,
            chainId: chainId,
            nonce: parseInt(tx.nonce, 16),
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            maxFeePerGas: tx.maxFeePerGas,
            gasLimit: tx.gas,
            to: tx.to,
            value: tx.value,
            data: tx.input,
            accessList: tx.accessList || []
        };
    } else if (txType === 1) {
        // EIP-2930 transaction
        console.log('  Type: EIP-2930');
        txData = {
            type: 1,
            chainId: chainId,
            nonce: parseInt(tx.nonce, 16),
            gasPrice: tx.gasPrice,
            gasLimit: tx.gas,
            to: tx.to,
            value: tx.value,
            data: tx.input,
            accessList: tx.accessList || []
        };
    } else {
        // Legacy transaction
        console.log('  Type: Legacy');
        txData = {
            nonce: parseInt(tx.nonce, 16),
            gasPrice: tx.gasPrice,
            gasLimit: tx.gas,
            to: tx.to,
            value: tx.value,
            data: tx.input,
            chainId: chainId
        };
    }

    // Add signature components
    if (tx.v && tx.r && tx.s) {
        txData.v = parseInt(tx.v, 16);
        txData.r = tx.r;
        txData.s = tx.s;
    }

    // Serialize the transaction to RLP format
    const rawTx = ethers.utils.serializeTransaction(txData);

    console.log('\n--- RLP-Encoded Transaction Data ---');
    console.log(rawTx);

    console.log('\n--- Data to send to /parse-visualsign endpoint ---');
    const requestData = {
        data: rawTx,
        chainId: chainId
    };
    console.log(JSON.stringify(requestData, null, 2));

    console.log('\n--- Copy this JSON for testing ---');
    console.log(JSON.stringify(requestData));
}

getUnsignedTransactionData().catch(error => {
    console.error('Error:', error.message);
});
