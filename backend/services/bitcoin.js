const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const axios = require('axios');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

// ─── Network Config ───────────────────────────────────────────────────────────
const getNetwork = () => {
  return process.env.BTC_NETWORK === 'testnet'
    ? bitcoin.networks.testnet
    : bitcoin.networks.bitcoin;
};

const getApiBase = () => {
  return process.env.BTC_NETWORK === 'testnet'
    ? 'https://blockstream.info/testnet/api'
    : 'https://blockstream.info/api';
};

// ─── Wallet Import from WIF Private Key ───────────────────────────────────────
const importWalletFromWIF = (wif) => {
  const network = getNetwork();
  const keyPair = ECPair.fromWIF(wif, network);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network
  });
  return { address, keyPair };
};

// ─── Wallet Import from Mnemonic (BIP84 - Native SegWit) ─────────────────────
const importWalletFromMnemonic = (mnemonic, accountIndex = 0, addressIndex = 0) => {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic phrase');
  const network = getNetwork();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, network);
  // BIP84: m/84'/0'/account'/0/index
  const coinType = network === bitcoin.networks.testnet ? 1 : 0;
  const path = `m/84'/${coinType}'/${accountIndex}'/0/${addressIndex}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network
  });
  return { address, keyPair: child, path };
};

// ─── Generate New Wallet ──────────────────────────────────────────────────────
const generateWallet = () => {
  const mnemonic = bip39.generateMnemonic(256); // 24 words
  const wallet = importWalletFromMnemonic(mnemonic);
  return { mnemonic, ...wallet };
};

// ─── Fetch UTXOs from Blockstream ─────────────────────────────────────────────
const fetchUTXOs = async (address) => {
  const url = `${getApiBase()}/address/${address}/utxo`;
  const { data } = await axios.get(url);
  return data; // [{txid, vout, value, status}]
};

// ─── Fetch Balance ────────────────────────────────────────────────────────────
const fetchBalance = async (address) => {
  const url = `${getApiBase()}/address/${address}`;
  const { data } = await axios.get(url);
  const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
  return {
    address,
    confirmed_satoshis: confirmed,
    unconfirmed_satoshis: unconfirmed,
    total_satoshis: confirmed + unconfirmed,
    confirmed_btc: (confirmed / 1e8).toFixed(8),
    unconfirmed_btc: (unconfirmed / 1e8).toFixed(8),
    total_btc: ((confirmed + unconfirmed) / 1e8).toFixed(8)
  };
};

// ─── Fetch Recommended Fees (sat/vbyte) ──────────────────────────────────────
const fetchFeeRates = async () => {
  const { data } = await axios.get(`${getApiBase()}/fee-estimates`);
  return {
    fast: Math.ceil(data['1'] || 20),      // ~1 block
    medium: Math.ceil(data['6'] || 10),    // ~6 blocks
    slow: Math.ceil(data['144'] || 5)      // ~144 blocks (1 day)
  };
};

// ─── Estimate TX Size (SegWit P2WPKH) ────────────────────────────────────────
const estimateTxSize = (inputCount, outputCount) => {
  // P2WPKH: overhead=10, input=68, output=31
  return 10 + (inputCount * 68) + (outputCount * 31);
};

// ─── Build & Sign Transaction ─────────────────────────────────────────────────
const buildTransaction = async (wifOrKeyPair, fromAddress, toAddress, amountBTC, feeRate = 'medium') => {
  const network = getNetwork();
  
  // Resolve key
  let keyPair;
  if (typeof wifOrKeyPair === 'string') {
    keyPair = ECPair.fromWIF(wifOrKeyPair, network);
  } else {
    keyPair = wifOrKeyPair;
  }

  // Validate destination address
  try {
    bitcoin.address.toOutputScript(toAddress, network);
  } catch {
    throw new Error('Invalid recipient Bitcoin address');
  }

  const amountSats = Math.round(amountBTC * 1e8);
  if (amountSats < 546) throw new Error('Amount below dust limit (546 satoshis)');

  // Fetch UTXOs
  const utxos = await fetchUTXOs(fromAddress);
  if (!utxos.length) throw new Error('No UTXOs available (zero balance or unconfirmed)');

  // Fetch fee rate
  const feeRates = await fetchFeeRates();
  const satPerVbyte = typeof feeRate === 'number' ? feeRate : feeRates[feeRate] || feeRates.medium;

  // UTXO selection (largest first / greedy)
  const sortedUTXOs = utxos
    .filter(u => u.status?.confirmed)
    .sort((a, b) => b.value - a.value);

  let selectedUTXOs = [];
  let totalInput = 0;
  let estimatedFee = 0;

  for (const utxo of sortedUTXOs) {
    selectedUTXOs.push(utxo);
    totalInput += utxo.value;
    const txSize = estimateTxSize(selectedUTXOs.length, 2); // 2 outputs: dest + change
    estimatedFee = txSize * satPerVbyte;
    if (totalInput >= amountSats + estimatedFee) break;
  }

  if (totalInput < amountSats + estimatedFee) {
    throw new Error(
      `Insufficient funds. Have: ${(totalInput / 1e8).toFixed(8)} BTC, ` +
      `Need: ${((amountSats + estimatedFee) / 1e8).toFixed(8)} BTC (inc. fee)`
    );
  }

  const change = totalInput - amountSats - estimatedFee;

  // Build PSBT
  const psbt = new bitcoin.Psbt({ network });

  // Fetch raw tx for each input (required for legacy; for segwit we use witnessUtxo)
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network
  });

  for (const utxo of selectedUTXOs) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output,
        value: utxo.value
      }
    });
  }

  // Output 1: recipient
  psbt.addOutput({ address: toAddress, value: amountSats });

  // Output 2: change (if meaningful)
  if (change > 546) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  // Sign all inputs
  for (let i = 0; i < selectedUTXOs.length; i++) {
    psbt.signInput(i, keyPair);
  }

  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();

  return {
    txHex: tx.toHex(),
    txId: tx.getId(),
    inputCount: selectedUTXOs.length,
    amountBTC,
    amountSats,
    feeSats: estimatedFee,
    feeBTC: (estimatedFee / 1e8).toFixed(8),
    changeSats: change > 546 ? change : 0,
    changeBTC: change > 546 ? (change / 1e8).toFixed(8) : '0',
    totalInputSats: totalInput,
    vsize: tx.virtualSize(),
    satPerVbyte
  };
};

// ─── Broadcast Transaction ────────────────────────────────────────────────────
const broadcastTransaction = async (txHex) => {
  const { data } = await axios.post(`${getApiBase()}/tx`, txHex, {
    headers: { 'Content-Type': 'text/plain' }
  });
  return data; // returns txid on success
};

// ─── Fetch Transaction History ────────────────────────────────────────────────
const fetchTxHistory = async (address, limit = 25) => {
  const { data } = await axios.get(`${getApiBase()}/address/${address}/txs`);
  return data.slice(0, limit).map(tx => {
    const received = tx.vout
      .filter(o => o.scriptpubkey_address === address)
      .reduce((s, o) => s + o.value, 0);
    const sent = tx.vin
      .filter(i => i.prevout?.scriptpubkey_address === address)
      .reduce((s, i) => s + i.prevout.value, 0);
    const net = received - sent;
    return {
      txid: tx.txid,
      type: net >= 0 ? 'received' : 'sent',
      amount_btc: (Math.abs(net) / 1e8).toFixed(8),
      amount_sats: Math.abs(net),
      fee_sats: tx.fee || 0,
      confirmed: tx.status?.confirmed || false,
      block_height: tx.status?.block_height || null,
      timestamp: tx.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
      explorer_url: `${process.env.BTC_NETWORK === 'testnet'
        ? 'https://blockstream.info/testnet/tx/'
        : 'https://blockstream.info/tx/'}${tx.txid}`
    };
  });
};

module.exports = {
  generateWallet,
  importWalletFromWIF,
  importWalletFromMnemonic,
  fetchBalance,
  fetchUTXOs,
  fetchFeeRates,
  buildTransaction,
  broadcastTransaction,
  fetchTxHistory
};
