# Snap Saver

Snap Saver is a MetaMask Snap that prevents blind signing by showing clear, human-readable previews of signatures. Using the ERC-7730 and VisualSign standards, it parses transaction data from EVM and non-EVM protocols, helping users understand what they're approving and protecting them from malicious or unintended actions.

## Project Structure

This repository contains three main components:

### 1. VisualSign Parser (Rust - `/src`)

A secure enclave application that parses unsigned transactions and returns VisualSign formatted output.

**Running tests:**

```bash
make -C src test
```

**Running locally:**

```bash
make -C src parser
```

The parser exposes a gRPC interface on port `44020` by default.

### 2. Express Server Bridge (`app.js`)

An HTTP/REST API that bridges MetaMask Snap with both VisualSign (gRPC) and ERC-7730 Clear Signing.

**Endpoints:**

- `POST /parse-visualsign` - Parse transactions using VisualSign
- `POST /parse-clearsigning` - Parse transactions using ERC-7730 descriptors
- `GET /health` - Health check

**Starting the server:**

```bash
node app.js
```

The server runs on port `80` by default and automatically:

- Builds descriptor maps from `clear-signing/` directory
- Connects to VisualSign parser (local or remote)
- Handles transaction parsing with intelligent fallback logic

### 3. MetaMask Snap (`/my-snap`)

The user-facing snap that integrates with MetaMask to display transaction insights.

**Building the snap:**

```bash
cd my-snap
yarn install
yarn build
```

**Development mode:**

```bash
yarn start
```

## How It Works

1. **VisualSign Priority**: When a transaction is initiated, the snap first tries VisualSign for protocol-specific parsing
2. **ERC-7730 Fallback**: If VisualSign returns generic data, it falls back to ERC-7730 descriptors for standards like ERC-20, WETH, Aave, etc. If neither ERC-7730 parses the transaction successfully, VisualSign is used as final.
3. **Intelligent Display**: The snap displays the most relevant transaction details based on which parser provides better insights

## ERC-7730 Clear Signing

The project includes a growing registry of ERC-7730 descriptors in the `clear-signing/` directory:

- **ERCs**: Standard token interfaces (ERC-20, WETH, etc.)
- **Registry**: Protocol-specific descriptors (Aave, Uniswap, etc.)

Descriptors are automatically indexed on server startup using a priority system:

- ERC-20: Priority 100
- ERC-721: Priority 90
- Registry protocols: Priority 5

## Configuration

### Environment Variables

Create a `.env` file in the root directory:

```env
# VisualSign Parser
PARSER_HOST=0.0.0.0
PARSER_PORT=44020

# Optional: Etherscan API for transaction testing
ETHERSCAN_API_KEY=your_api_key_here
```

## VisualSign Parser Details

### Making gRPC Requests

Once the parser is running, test it with:

```bash
grpcurl -plaintext -d '{"unsigned_payload": "0xabcdef"}' localhost:44020 parser.ParserService/Parse
```

### Health Check

```bash
grpcurl -plaintext -d '{"service":""}' localhost:44020 grpc.health.v1.Health/Check
```

### Building Parser OCI Containers

This repository uses [StageX](https://stagex.tools) to build OCI containers. You'll need Docker > 26 and `containerd` for OCI compatibility.

**Docker Desktop:** Enable "Use containerd for pulling and storing images" in Settings

**Linux:** Add to `/etc/docker/daemon.json`:

```json
{
  "features": {
    "containerd-snapshotter": true
  },
  "registry-mirrors": ["https://ghcr.io/anchorageoss"]
}
```

**Build containers:**

```bash
# Parser app container
make out/parser_app/index.json

# Parser host container
make out/parser_host/index.json
```

## Example Transactions

### Ethereum

**CLI:**

```bash
cargo run --bin parser_cli -- --chain ethereum -t '0xf86c808504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83'
```

**gRPC:**

```bash
grpcurl -plaintext -d '{"unsigned_payload": "0xf86c808504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83", "chain":"CHAIN_ETHEREUM"}' localhost:44020 parser.ParserService/Parse
```

### Solana

**CLI:**

```bash
cargo run --bin parser_cli -- --chain solana -t 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAGDpVgWUMU7MEPPORo0ORMinVaO1ktDjHe3//f1qqIwJ2XYaz02Vuj7xyKHc5e6LXN5WxDxzUGN72irt3XVidnPQdbX1g0C8G9eZLm2AYo6hVEwP0bql0mb8fZLQW6g3h/XIjx/6Oi3+YXvcTjVzJRoyLj/K6B5aRXOQ5kdRwApGXinqdo/t9kTIqum44hiK3Qa8VQ+/cWyCK5zmPHeD2VLh8J5qP+7PmQMuHB32uXItyzY057jjRAk2vDSwzByOtSH/zRQemDLK8QrZF0lcoPJxtbKTzUcCfqc3AH7UDrOaC9BIo+CMO0lb4X9FQn2JvsW4DH4mlcGGTXZ0PbOb7TRtYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFTlniTAUaihSnsel5fw4Szfp0kCFmUxlaalEqbxZmArjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FkDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAaBTtTK9ooXRnL9rIYDGmPoTqFe+h1EtyKT9tvbABZQBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKk7YUJFOy/o1K3RALVqqztUypoKMpR8OCcCt0Rr0FUhSAYIAgABDAIAAAAA5AtUAgAAAAoGAAIABggNAQEMCgcJBAECBQIGCA0JDgDkC1QCAAAACwAFAoAaBgALAAkDUMMAAAAAAAAIAgADDAIAAAAQJwAAAAAAAA=='
```

### Sui

**CLI:**

```bash
cargo run --bin parser_cli -- --chain sui -t 'AQAAAAAABAAgoeOuVRwqvjxrzqItPxk1amRwhta9VqwNCeTu7QYpC3YBAMIA6wRHwZnY1Uq4kShmJ9MzSf09cido4hRbib9QxPr6GprUFwAAAAAgaLIB/QqiGeVY7g/t0gmAgBUq5KN1vBtUCNfQl+OWI4QACBAnAAAAAAAAAAggTgAAAAAAAAQCAQEAAQEDAAEBAgAAAQAAAgEBAAEBAgABAQICAAEAANbpLgAuJsOvsgiAAcG1ggtk8rw1G/2lojQqy/n1wcrCActIXvgKC6+QeaYhxCyLDLZc6ZhuHIH9Fu6IA48ASlrtGprUFwAAAAAgruP9lGIbTNb4l4WPdDGN2qrKMg4H7WiVr4iK3KnMEI/W6S4ALibDr7IIgAHBtYILZPK8NRv9paI0Ksv59cHKwugDAAAAAAAAQEtMAAAAAAAAAWEAmEURyDG9UG5JOixWeOweSlyhULQ2oNgiAUrKrio+mjI8yelPjyw5AFA8WOgv9T/RytUNWfnqKsStA67qnisQAwzQ7OmIzoPhw5nTC3tMzLjAySqs8CGINPAk+pl4i3Nm'
```

## Contributing

To add support for new protocols:

1. Add an ERC-7730 descriptor to `clear-signing/ercs/` or `clear-signing/registry/`
2. Restart the server to rebuild descriptor maps
3. Test with your transaction data
