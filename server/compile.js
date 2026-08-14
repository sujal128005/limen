'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');

// solc-js ships the compiler through npm, so contracts build with no separate
// download and no network at runtime.
function compileContracts() {
  const files = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.sol'));
  const sources = {};
  for (const f of files) {
    sources[f] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), 'utf8') };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    throw new Error('Solidity compilation failed:\n' + errors.map((e) => e.formattedMessage).join('\n'));
  }
  const warnings = (output.errors || []).filter((e) => e.severity === 'warning');

  const artifacts = {};
  for (const file of Object.keys(output.contracts || {})) {
    for (const name of Object.keys(output.contracts[file])) {
      artifacts[name] = {
        abi: output.contracts[file][name].abi,
        bytecode: '0x' + output.contracts[file][name].evm.bytecode.object,
      };
    }
  }
  return { artifacts, warnings: warnings.map((w) => w.formattedMessage), solcVersion: solc.version() };
}

module.exports = { compileContracts };
