import type {
  OnRpcRequestHandler,
  OnTransactionHandler,
} from '@metamask/snaps-sdk';
import { Box, Text, Bold, Divider } from '@metamask/snaps-sdk/jsx';
import { encode as rlpEncode } from 'rlp';

/**
 * Handle incoming JSON-RPC requests, sent through `wallet_invokeSnap`.
 *
 * @param args - The request handler args as object.
 * @param args.origin - The origin of the request, e.g., the website that
 * invoked the snap.
 * @param args.request - A validated JSON-RPC request object.
 * @returns The result of `snap_dialog`.
 * @throws If the request method is not valid for this snap.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({
  origin,
  request,
}) => {
  switch (request.method) {
    case 'hello':
      return snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Text>
                Hello, <Bold>{origin}</Bold>!
              </Text>
              <Text>
                This custom confirmation is just for display purposes.
              </Text>
              <Text>
                But you can edit the snap source code to make it do something,
                if you want to!
              </Text>
            </Box>
          ),
        },
      });
    default:
      throw new Error('Method not found.');
  }
};

/**
 * Handle an incoming transaction, and return any insights.
 *
 * @param args - The request handler args as object.
 * @param args.transaction - The transaction object.
 * @returns The transaction insights.
 */
export const onTransaction: OnTransactionHandler = async ({
  transaction,
  chainId,
}) => {
  // Helper to convert hex string to Buffer with proper RLP encoding
  const toBuffer = (value: string | undefined): Buffer => {
    if (!value || value === '0x' || value === '0x0') {
      return Buffer.from([]);
    }
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    // Remove leading zeros but keep at least one byte
    const trimmed = hex.replace(/^0+/, '') || '0';
    // Ensure even length
    const padded = trimmed.length % 2 === 0 ? trimmed : '0' + trimmed;
    return Buffer.from(padded, 'hex');
  };

  // Parse CAIP-2 format chainId (e.g., "eip155:42161") to hex
  const parseChainId = (caipChainId: string): string => {
    if (caipChainId.startsWith('eip155:')) {
      const chainIdDecimal = caipChainId.split(':')[1];
      const chainIdNum = parseInt(chainIdDecimal as string, 10);
      return '0x' + chainIdNum.toString(16);
    }
    return caipChainId;
  };

  let rlpHex = '';

  try {
    const txType = (transaction as unknown as { type: any }).type || '0x0';
    const actualChainId = parseChainId(chainId);

    // Get chain ID as decimal number for API
    const chainIdDecimal = parseInt(actualChainId.replace('0x', ''), 16);

    // EIP-1559 (Type 2) transaction
    if (txType === '0x2' || txType === '0x02') {
      const fields = [
        toBuffer(actualChainId),
        toBuffer(transaction.nonce),
        toBuffer(
          (transaction as unknown as { maxPriorityFeePerGas: any })
            .maxPriorityFeePerGas,
        ),
        toBuffer(
          (transaction as unknown as { maxFeePerGas: any }).maxFeePerGas,
        ),
        toBuffer(transaction.gas),
        toBuffer(transaction.to),
        toBuffer(transaction.value),
        toBuffer(transaction.data),
        [], // accessList
      ];

      const encoded = rlpEncode(fields);
      rlpHex = '0x02' + Buffer.from(encoded).toString('hex');
    } else {
      // Legacy transaction
      const fields = [
        toBuffer(transaction.nonce),
        toBuffer((transaction as any).gasPrice),
        toBuffer(transaction.gas),
        toBuffer(transaction.to),
        toBuffer(transaction.value),
        toBuffer(transaction.data),
        toBuffer(actualChainId),
        Buffer.from([]),
        Buffer.from([]),
      ];

      const encoded = rlpEncode(fields);
      rlpHex = '0x' + Buffer.from(encoded).toString('hex');
    }

    // Helper function to check if VisualSign data is relevant
    const isVisualSignRelevant = (data: any): boolean => {
      if (!data.ok || !data.parsed) return false;

      const fields = data.parsed.Fields || [];
      const title = data.parsed.Title || '';

      // Check if we have preview_layout fields first (these contain structured data like Aave, Uniswap, etc.)
      const hasPreviewLayout = fields.some(
        (field: any) => field.Type === 'preview_layout',
      );
      if (hasPreviewLayout) {
        console.log('VisualSign has preview_layout - considered RELEVANT');
        return true;
      }

      // If title is not generic "Ethereum Transaction", it's likely relevant
      // (e.g., "Aave v3 Supply", "Uniswap Swap", etc.)
      if (title !== 'Ethereum Transaction' && title !== '') {
        console.log(
          'VisualSign has custom title:',
          title,
          '- considered RELEVANT',
        );
        return true;
      }

      // Check if we have any meaningful fields beyond basic transaction info
      // VisualSign is considered irrelevant if it only shows basic fields like:
      // Network, To, Value, Gas Limit, Gas Price, Nonce, Contract Call Data
      const irrelevantLabels = [
        'Network',
        'To',
        'Value',
        'Gas Limit',
        'Gas Price',
        'Max Fee Per Gas',
        'Max Priority Fee Per Gas',
        'Nonce',
        'Contract Call Data',
      ];

      const relevantFieldTypes = fields.filter((field: any) => {
        const label = field.Label || '';
        // Skip if it's just basic transaction metadata
        return !irrelevantLabels.includes(label);
      });

      const isRelevant = relevantFieldTypes.length > 0;
      console.log(
        'VisualSign relevance check:',
        isRelevant ? 'RELEVANT' : 'IRRELEVANT',
        'based on fields',
      );
      return isRelevant;
    };

    // Helper function to check if ClearSigning data is relevant
    const isClearSigningRelevant = (data: any): boolean => {
      if (!data.ok) return false;

      const fields = data.fields || [];
      const intent = data.intent || '';

      // ClearSigning is irrelevant if intent is "Unknown action" or no fields
      if (intent === 'Unknown action' || fields.length === 0) {
        return false;
      }

      return true;
    };

    // Try VisualSign first
    let visualSignData;
    let clearSigningData;
    let useVisualSign = false;

    try {
      const vsResponse = await fetch(`http://localhost/parse-visualsign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chainId: chainIdDecimal,
          data: rlpHex,
        }),
      });

      if (vsResponse.ok) {
        visualSignData = await vsResponse.json();
        console.log('VisualSign response:', visualSignData);

        if (isVisualSignRelevant(visualSignData)) {
          useVisualSign = true;
        }
      }
    } catch (vsError) {
      console.log('VisualSign error:', vsError);
    }

    // If VisualSign is not relevant, try ClearSigning
    if (!useVisualSign) {
      try {
        const csResponse = await fetch(`http://localhost/parse-clearsigning`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chainId: chainIdDecimal,
            data: rlpHex,
          }),
        });

        if (csResponse.ok) {
          clearSigningData = await csResponse.json();
          console.log('ClearSigning response:', clearSigningData);

          // If ClearSigning is relevant, use it
          // Otherwise, fall back to VisualSign even if it's irrelevant
          if (isClearSigningRelevant(clearSigningData)) {
            useVisualSign = false;
          } else if (visualSignData) {
            // ClearSigning is also irrelevant, use VisualSign
            useVisualSign = true;
          }
        }
      } catch (csError) {
        console.log('ClearSigning error:', csError);
        // If both fail but we have VisualSign data, use it
        if (visualSignData) {
          useVisualSign = true;
        }
      }
    }

    // If we have no data at all, show error
    if (!visualSignData && !clearSigningData) {
      return {
        content: (
          <Box>
            <Text>
              <Bold>Failed to parse transaction:</Bold>
            </Text>
            <Text>Both parsers failed to return data</Text>
            <Divider />
            <Text>
              <Bold>Chain ID:</Bold>
            </Text>
            <Text>{chainIdDecimal.toString()}</Text>
            <Divider />
            <Text>
              <Bold>RLP Data:</Bold>
            </Text>
            <Text>{rlpHex}</Text>
          </Box>
        ),
      };
    }

    const parsedData = useVisualSign ? visualSignData : clearSigningData;

    // Display the parsed JSON response
    if (!parsedData.ok) {
      return {
        content: (
          <Box>
            <Text>
              <Bold>Parse Error:</Bold>
            </Text>
            <Text>{parsedData.error || 'Unknown error'}</Text>
          </Box>
        ),
      };
    }

    // Handle ClearSigning output
    if (!useVisualSign) {
      const { intent, fields, metadata } = parsedData;

      const renderedFields = [];

      // Add intent
      renderedFields.push(
        <Text>
          <Bold>Action:</Bold> {intent}
        </Text>,
      );

      // Add metadata
      if (metadata?.owner) {
        renderedFields.push(
          <Text>
            <Bold>Protocol:</Bold> {metadata.owner}
          </Text>,
        );
      }

      if (metadata?.contractAddress) {
        renderedFields.push(
          <Text>
            <Bold>Contract:</Bold> {metadata.contractAddress}
          </Text>,
        );
      }

      renderedFields.push(<Divider />);

      // Add fields
      for (const field of fields) {
        const { label, value, required } = field;
        const marker = required ? '★ ' : '';

        renderedFields.push(
          <Text>
            <Bold>
              {marker}
              {label}:
            </Bold>{' '}
            {value}
          </Text>,
        );
      }

      return {
        content: (
          <Box>
            <Text>
              <Bold>Clear Signing</Bold>
            </Text>
            <Divider />
            {renderedFields}
          </Box>
        ),
      };
    }

    // Handle VisualSign output
    const { parsed } = parsedData;
    const fields = parsed.Fields || [];

    // Render fields as JSX elements
    const renderedFields = [];

    for (const field of fields) {
      const { Type, Label, FallbackText } = field;

      if (Type === 'text_v2') {
        renderedFields.push(
          <Text>
            <Bold>{Label}:</Bold> {field.TextV2?.Text || FallbackText}
          </Text>,
        );
      } else if (Type === 'address_v2') {
        const addressData = field.AddressV2;
        const displayText = addressData?.Name
          ? `${addressData.Name} (${addressData.Address})`
          : addressData?.Address || FallbackText;
        renderedFields.push(
          <Text>
            <Bold>{Label}:</Bold> {displayText}
          </Text>,
        );
      } else if (Type === 'amount_v2') {
        const amountData = field.AmountV2;
        const displayText = amountData?.Abbreviation
          ? `${amountData.Amount} ${amountData.Abbreviation}`
          : amountData?.Amount || FallbackText;
        renderedFields.push(
          <Text>
            <Bold>{Label}:</Bold> {displayText}
          </Text>,
        );
      } else if (Type === 'preview_layout') {
        const preview = field.PreviewLayout;
        const expandedFields = preview?.Expanded?.Fields || [];

        renderedFields.push(<Divider />);
        renderedFields.push(
          <Text>
            <Bold>{preview?.Title?.Text || Label}</Bold>
          </Text>,
        );

        if (preview?.Subtitle?.Text) {
          renderedFields.push(<Text>{preview.Subtitle.Text}</Text>);
        }

        for (const subField of expandedFields) {
          const subType = subField.Type;
          const subLabel = subField.Label;
          const subFallback = subField.FallbackText;

          if (subType === 'text_v2') {
            renderedFields.push(
              <Text>
                <Bold>{subLabel}:</Bold> {subField.TextV2?.Text || subFallback}
              </Text>,
            );
          } else if (subType === 'address_v2') {
            const addr = subField.AddressV2?.Address || subFallback;
            renderedFields.push(
              <Text>
                <Bold>{subLabel}:</Bold> {addr}
              </Text>,
            );
          } else if (subType === 'amount_v2') {
            renderedFields.push(
              <Text>
                <Bold>{subLabel}:</Bold> {subFallback}
              </Text>,
            );
          } else {
            renderedFields.push(
              <Text>
                <Bold>{subLabel}:</Bold> {subFallback}
              </Text>,
            );
          }
        }

        renderedFields.push(<Divider />);
      } else {
        // Fallback for unknown types
        renderedFields.push(
          <Text>
            <Bold>{Label}:</Bold> {FallbackText}
          </Text>,
        );
      }
    }

    return {
      content: (
        <Box>
          <Text>
            <Bold>{parsed.Title}</Bold>
          </Text>
          <Divider />
          {renderedFields}
        </Box>
      ),
    };
  } catch (error) {
    return {
      content: (
        <Box>
          <Text>
            <Bold>Error:</Bold>
          </Text>
          <Text>{error instanceof Error ? error.message : String(error)}</Text>
        </Box>
      ),
    };
  }
};
