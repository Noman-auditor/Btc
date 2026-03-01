const express = require('express');
const router = express.Router();
const btc = require('../services/bitcoin');

// ─── GET /api/wallet/generate ─────────────────────────────────────────────────
// Generate a brand new wallet with mnemonic
router.get('/generate', async (req, res, next) => {
  try {
    const wallet = btc.generateWallet();
    res.json({
      success: true,
      message: '⚠️ Save your mnemonic securely! Never share it.',
      wallet: {
        address: wallet.address,
        mnemonic: wallet.mnemonic,
        derivation_path: wallet.path
      }
    });
  } catch (err) { next(err); }
});

// ─── POST /api/wallet/import/wif ──────────────────────────────────────────────
// Import wallet from WIF private key
router.post('/import/wif', async (req, res, next) => {
  try {
    const { wif } = req.body;
    if (!wif) return res.status(400).json({ error: 'WIF private key required' });
    const wallet = btc.importWalletFromWIF(wif);
    const balance = await btc.fetchBalance(wallet.address);
    res.json({ success: true, address: wallet.address, balance });
  } catch (err) { next(err); }
});

// ─── POST /api/wallet/import/mnemonic ────────────────────────────────────────
// Import wallet from mnemonic seed phrase
router.post('/import/mnemonic', async (req, res, next) => {
  try {
    const { mnemonic, account_index = 0, address_index = 0 } = req.body;
    if (!mnemonic) return res.status(400).json({ error: 'Mnemonic required' });
    const wallet = btc.importWalletFromMnemonic(mnemonic, account_index, address_index);
    const balance = await btc.fetchBalance(wallet.address);
    res.json({
      success: true,
      address: wallet.address,
      derivation_path: wallet.path,
      balance
    });
  } catch (err) { next(err); }
});

// ─── GET /api/wallet/balance/:address ────────────────────────────────────────
router.get('/balance/:address', async (req, res, next) => {
  try {
    const balance = await btc.fetchBalance(req.params.address);
    res.json({ success: true, ...balance });
  } catch (err) { next(err); }
});

// ─── GET /api/wallet/utxos/:address ──────────────────────────────────────────
router.get('/utxos/:address', async (req, res, next) => {
  try {
    const utxos = await btc.fetchUTXOs(req.params.address);
    const total = utxos.reduce((s, u) => s + u.value, 0);
    res.json({
      success: true,
      address: req.params.address,
      utxo_count: utxos.length,
      total_satoshis: total,
      total_btc: (total / 1e8).toFixed(8),
      utxos
    });
  } catch (err) { next(err); }
});

// ─── GET /api/wallet/fees ─────────────────────────────────────────────────────
router.get('/fees', async (req, res, next) => {
  try {
    const fees = await btc.fetchFeeRates();
    res.json({ success: true, fee_rates_sat_vbyte: fees });
  } catch (err) { next(err); }
});

module.exports = router;
