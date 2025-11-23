#!/usr/bin/env python3
"""
Simulate ERC-7730 clear signing display for a given calldata.

Usage:
    python simulate_clear_signing.py <descriptor_path> <calldata_hex>
    python simulate_clear_signing.py <descriptor_path> --file <calldata_file>
"""

import sys
import json
from pathlib import Path
from typing import Any
from eth_abi import decode


def load_descriptor(descriptor_path: str) -> dict:
    """Load and parse the ERC-7730 descriptor file."""
    with open(descriptor_path, 'r') as f:
        return json.load(f)


def load_calldata(calldata: str | None = None, file_path: str | None = None) -> bytes:
    """Load calldata from hex string or file."""
    if file_path:
        calldata = Path(file_path).read_text().strip()

    if not calldata:
        raise ValueError("No calldata provided")

    # Remove 0x prefix if present
    if calldata.startswith('0x'):
        calldata = calldata[2:]

    return bytes.fromhex(calldata)


def extract_function_signature(calldata: bytes) -> str:
    """Extract the 4-byte function selector from calldata."""
    return '0x' + calldata[:4].hex()


def decode_calldata(calldata: bytes, abi_function: dict) -> dict[str, Any]:
    """Decode calldata using the ABI function definition."""
    # Extract parameter types from ABI
    param_types = [param['type'] for param in abi_function['inputs']]
    param_names = [param['name'] for param in abi_function['inputs']]

    # Skip the 4-byte selector and decode the rest
    try:
        decoded_values = decode(param_types, calldata[4:])
    except Exception as e:
        raise ValueError(f"Failed to decode calldata: {e}")

    # Create a dictionary mapping parameter names to values
    return dict(zip(param_names, decoded_values))


def get_function_abi(descriptor, selector: str) -> dict | None:
    """Find the ABI function definition matching the selector."""
    # Get ABI from descriptor context
    contract_context = descriptor.context

    # For now, we'll need to fetch the ABI from the URL
    # This is a simplified version - you'd need to implement ABI fetching
    print(f"⚠️  Note: ABI fetching not fully implemented in this script")
    print(f"   Selector: {selector}")
    return None


def format_field_value(value: Any, field_format: dict, params: dict) -> str:
    """Format a field value according to its format specification."""
    format_type = field_format.get('format', 'raw')

    if format_type == 'raw':
        return str(value)

    elif format_type == 'tokenAmount':
        # Simplified token amount formatting
        # In reality, would need to fetch token decimals
        return f"{value} (token amount - needs decimal conversion)"

    elif format_type == 'addressName':
        # Simplified address formatting
        if isinstance(value, bytes):
            value = '0x' + value.hex()
        elif isinstance(value, int):
            value = f"0x{value:040x}"
        return value

    elif format_type == 'enum':
        # Look up enum value
        enum_ref = field_format.get('params', {}).get('$ref', '')
        return f"{value} (enum lookup needed for {enum_ref})"

    else:
        return f"{value} (format: {format_type})"


def display_clear_signing(descriptor: dict, calldata: bytes):
    """Display the clear signing output for the given calldata."""
    print("=" * 80)
    print("CLEAR SIGNING SIMULATION")
    print("=" * 80)

    # Extract function selector
    selector = extract_function_signature(calldata)
    print(f"\n📋 Function Selector: {selector}")

    # Convert selector to function signature for lookup
    # In ERC-7730, formats are keyed by full function signature
    display_formats = descriptor.get('display', {}).get('formats', {})

    # Try to find matching format
    matching_format = None
    matching_sig = None

    for sig, format_def in display_formats.items():
        # Calculate selector from signature
        from eth_utils import keccak

        # Extract just the types (remove parameter names)
        # e.g., "supply(address asset, uint256 amount)" -> "supply(address,uint256)"
        import re
        sig_match = re.match(r'(\w+)\((.*)\)', sig)
        if sig_match:
            func_name = sig_match.group(1)
            params_with_names = sig_match.group(2)

            # Remove parameter names, keeping only types
            if params_with_names:
                param_parts = [p.strip() for p in params_with_names.split(',')]
                # Extract just the type (first word before space)
                param_types = [p.split()[0] if ' ' in p else p for p in param_parts]
                canonical_sig = f"{func_name}({','.join(param_types)})"
            else:
                canonical_sig = f"{func_name}()"
        else:
            canonical_sig = sig

        sig_selector = '0x' + keccak(text=canonical_sig)[:4].hex()

        if sig_selector == selector:
            matching_format = format_def
            matching_sig = sig
            break

    if not matching_format:
        print(f"\n❌ No format definition found for selector {selector}")
        print(f"\nAvailable function signatures in descriptor:")
        for sig in display_formats.keys():
            from eth_utils import keccak
            import re

            # Calculate canonical signature
            sig_match = re.match(r'(\w+)\((.*)\)', sig)
            if sig_match:
                func_name = sig_match.group(1)
                params_with_names = sig_match.group(2)
                if params_with_names:
                    param_parts = [p.strip() for p in params_with_names.split(',')]
                    param_types = [p.split()[0] if ' ' in p else p for p in param_parts]
                    canonical_sig = f"{func_name}({','.join(param_types)})"
                else:
                    canonical_sig = f"{func_name}()"
            else:
                canonical_sig = sig

            sig_selector = '0x' + keccak(text=canonical_sig)[:4].hex()
            print(f"   {sig_selector}: {canonical_sig}")
        return

    print(f"\n✅ Matched function: {matching_sig}")

    # Display intent
    intent = matching_format.get('intent', 'Unknown action')
    print(f"\n🎯 INTENT: {intent}")

    # Get metadata
    metadata = descriptor.get('metadata', {})
    owner = metadata.get('owner')
    if owner:
        print(f"📍 Contract Owner: {owner}")

    # Parse function signature to get parameter info
    import re
    func_match = re.match(r'(\w+)\((.*)\)', matching_sig)
    if not func_match:
        print(f"❌ Invalid function signature format: {matching_sig}")
        return

    func_name = func_match.group(1)
    params_str = func_match.group(2)

    # Parse parameters
    param_defs = []
    if params_str:
        # Simple parsing - doesn't handle complex types perfectly
        param_parts = params_str.split(',')
        for part in param_parts:
            part = part.strip()
            parts = part.rsplit(' ', 1)
            if len(parts) == 2:
                param_defs.append({'type': parts[0], 'name': parts[1]})
            else:
                param_defs.append({'type': parts[0], 'name': f'param{len(param_defs)}'})

    # Decode calldata
    param_types = [p['type'] for p in param_defs]
    param_names = [p['name'] for p in param_defs]

    try:
        decoded_values = decode(param_types, calldata[4:])
        decoded_params = dict(zip(param_names, decoded_values))
    except Exception as e:
        print(f"\n❌ Failed to decode calldata: {e}")
        return

    print(f"\n📊 DECODED PARAMETERS:")
    print("-" * 80)

    # Display fields according to format specification
    fields = matching_format.get('fields', [])
    required = matching_format.get('required', [])
    excluded = matching_format.get('excluded', [])

    for field in fields:
        path = field.get('path', '')
        label = field.get('label', path)

        # Skip excluded fields
        if path in excluded:
            continue

        # Get the value
        value = decoded_params.get(path, '<not found>')

        # Format the value
        formatted_value = format_field_value(value, field, decoded_params)

        # Mark required fields
        required_mark = "★" if path in required else " "

        print(f"{required_mark} {label}: {formatted_value}")

    print("\n" + "=" * 80)
    print("★ = Required field")
    print("=" * 80)


def main():
    """Main entry point."""
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    descriptor_path = sys.argv[1]

    # Check if --file flag is used
    if sys.argv[2] == '--file':
        if len(sys.argv) < 4:
            print("Error: --file requires a file path")
            sys.exit(1)
        calldata_hex = None
        calldata_file = sys.argv[3]
    else:
        calldata_hex = sys.argv[2]
        calldata_file = None

    try:
        # Load descriptor
        print(f"Loading descriptor: {descriptor_path}")
        descriptor = load_descriptor(descriptor_path)

        # Load calldata
        print(f"Loading calldata...")
        calldata = load_calldata(calldata_hex, calldata_file)
        print(f"Calldata length: {len(calldata)} bytes\n")

        # Display clear signing
        display_clear_signing(descriptor, calldata)

    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
